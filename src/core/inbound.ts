// Inbound radar: payments on their way to you, seen before they confirm, with an honest landing estimate.
// BTC/LTC: the address's mempool, placed in the projected next blocks by fee rate.
// SOL: signatures at "confirmed" (~1 s), landed once finalized. XMR: pool + blocks until spendable (10).
// EVM/Tron/DOGE confirm in seconds or have no public per-address mempool; the balance poll covers them.
import { NETWORKS } from './assets'
import { getJson, rpc, type Addresses } from './chain'

export interface Inbound {
  id: string
  asset: string
  network: string
  txid: string
  amount: number
  from: string
  /** when Astrala first saw it */
  seen: number
  confs: number
  /** confirmations until it counts as landed */
  need: number
  /** estimated landing time (epoch ms) */
  eta: number
  /** BTC/LTC: projected block it's in (0 = the next one) */
  block?: number
}

export interface XmrIn { txid: string; direction: 'in' | 'out'; amount: number; time: number; confirmations: number; address: string }
export interface Scan { flying: Inbound[]; landed: Inbound[]; dropped: Inbound[] }

const AVG_BLOCK: Record<string, number> = { bitcoin: 600_000, litecoin: 150_000 }
const XMR_LOCK = 10
const XMR_BLOCK = 120_000
const SOL_FINALITY = 13_000
const DROP_AFTER = 6 // consecutive "not found" checks before a vanished tx counts as dropped

/** Fee rate (sat/vB) → which projected block it lands in (0 = next). Past the projection: one after the last. */
export function blockPosition(rate: number, blocks: { feeRange: number[] }[]): number {
  const i = blocks.findIndex((b) => rate >= (b.feeRange?.[0] ?? 0))
  return i < 0 ? blocks.length : i
}

const is404 = (e: unknown) => /HTTP 404/.test(String((e as Error)?.message ?? e))

export class InboundRadar {
  private tracked = new Map<string, Inbound & { misses: number }>()
  private seen = new Map<string, number>()
  /** Solana signatures already looked at and found not to pay us. */
  private notMine = new Set<string>()

  reset() { this.tracked.clear(); this.seen.clear(); this.notMine.clear() }

  /** xmr: the wallet's transfers, or null when they couldn't be read (so nothing Monero lands or drops on a bad read). */
  async scan(addrs: Addresses, xmr: XmrIn[] | null = null, now = Date.now()): Promise<Scan> {
    const found: Inbound[] = []
    const ok = new Set<string>() // networks whose scan succeeded (only those can land or drop)
    const jobs: Promise<void>[] = []
    for (const [net, fam] of [['bitcoin', 'btc'], ['litecoin', 'ltc']] as const) {
      const addr = addrs[fam]
      if (addr) jobs.push(this.utxo(net, fam, addr, now).then((r) => { found.push(...r); ok.add(net) }).catch(() => {}))
    }
    if (addrs.sol) jobs.push(this.sol(addrs.sol, now).then((r) => { found.push(...r); ok.add('solana') }).catch(() => {}))
    await Promise.all(jobs)
    if (xmr) { found.push(...this.xmr(xmr, now)); ok.add('monero') }

    const flying: Inbound[] = [], landed: Inbound[] = [], dropped: Inbound[] = []
    const live = new Set(found.map((f) => f.id))
    for (const f of found) {
      if (f.confs >= f.need) { if (this.tracked.has(f.id)) { landed.push(f); this.tracked.delete(f.id) } continue }
      this.tracked.set(f.id, { ...f, misses: 0 })
      flying.push(f)
    }
    // tracked earlier, gone from the pending view now: confirmed, or dropped/replaced
    for (const [id, t] of [...this.tracked]) {
      if (live.has(id) || !ok.has(t.network)) { if (!live.has(id)) flying.push(t); continue }
      const s = await this.status(t).catch(() => 'unknown' as const)
      if (s === 'landed') { landed.push({ ...t, confs: t.need, eta: now }); this.tracked.delete(id) }
      else if (s === 'gone' && ++t.misses >= DROP_AFTER) { dropped.push(t); this.tracked.delete(id) }
      else flying.push(t)
    }
    return { flying: flying.map(({ misses: _m, ...f }: any) => f).sort((a, b) => a.eta - b.eta), landed, dropped }
  }

  private first(id: string, now: number) {
    if (!this.seen.has(id)) this.seen.set(id, now)
    return this.seen.get(id)!
  }

  private async utxo(network: 'bitcoin' | 'litecoin', asset: 'btc' | 'ltc', addr: string, now: number): Promise<Inbound[]> {
    const base = NETWORKS[network].rpc[0]
    const txs: any[] = await getJson(`${base}/api/address/${addr}/txs/mempool`)
    const mine = txs.map((tx) => {
      const got = tx.vout.filter((o: any) => o.scriptpubkey_address === addr).reduce((s: number, o: any) => s + o.value, 0)
      const spent = tx.vin.filter((i: any) => i.prevout?.scriptpubkey_address === addr).reduce((s: number, i: any) => s + i.prevout.value, 0)
      return { tx, net: got - spent }
    }).filter((m) => m.net > 0)
    if (!mine.length) return []
    const blocks: any[] = await getJson(`${base}/api/v1/fees/mempool-blocks`).catch(() => [])
    const avg = AVG_BLOCK[network]
    return mine.map(({ tx, net }) => {
      const rate = tx.fee && tx.weight ? tx.fee / (tx.weight / 4) : 0
      const id = `${network}:${tx.txid}`
      const block = blocks.length ? blockPosition(rate, blocks) : this.tracked.get(id)?.block ?? 0
      // block arrivals are memoryless (the next one is on average a block time away whenever you look),
      // so the estimate is fixed when first made and only moves if the payment's place in the queue does
      const known = this.tracked.get(id)
      const eta = known && known.block === block ? known.eta : now + (block + 1) * avg
      return { id, asset, network, txid: tx.txid, amount: net / 1e8, from: tx.vin[0]?.prevout?.scriptpubkey_address ?? '', seen: this.first(id, now), confs: 0, need: 1, eta, block }
    })
  }

  private async sol(addr: string, now: number): Promise<Inbound[]> {
    const rpcs = NETWORKS.solana.rpc
    const sigs: any[] = await rpc(rpcs, 'getSignaturesForAddress', [addr, { limit: 8, commitment: 'confirmed' }])
    const out: Inbound[] = []
    for (const s of sigs) {
      if (s.err || s.confirmationStatus === 'finalized' || this.notMine.has(s.signature)) continue
      if (s.blockTime && now - s.blockTime * 1000 > 10 * 60_000) continue
      const id = `solana:${s.signature}`
      const known = this.tracked.get(id)
      if (known) { out.push(known); continue }
      const tx: any = await rpc(rpcs, 'getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]).catch(() => null)
      if (!tx?.meta) continue
      const keys = tx.transaction.message.accountKeys.map((k: any) => (typeof k === 'string' ? k : k.pubkey))
      const i = keys.indexOf(addr)
      const lamports = i >= 0 ? tx.meta.postBalances[i] - tx.meta.preBalances[i] + (i === 0 ? tx.meta.fee : 0) : 0
      const at = (s.blockTime ?? now / 1000) * 1000
      if (lamports > 0) out.push({ id, asset: 'sol', network: 'solana', txid: s.signature, amount: lamports / 1e9, from: keys[0] !== addr ? keys[0] : '', seen: this.first(id, now), confs: 0, need: 1, eta: at + SOL_FINALITY })
      else this.notMine.add(s.signature) // SPL tokens are picked up by the balance poll
    }
    return out
  }

  private xmr(ts: XmrIn[], now: number): Inbound[] {
    return ts.filter((t) => t.direction === 'in' && t.amount > 0 && now - t.time < 3 * 3600e3).map((t) => {
      const id = `monero:${t.txid}:in`, known = this.tracked.get(id)
      const eta = known && known.confs === t.confirmations ? known.eta : now + Math.max(0, XMR_LOCK - t.confirmations) * XMR_BLOCK
      return { id, asset: 'xmr', network: 'monero', txid: t.txid, amount: t.amount, from: '', seen: this.first(id, now), confs: t.confirmations, need: XMR_LOCK, eta }
    })
  }

  private async status(t: Inbound): Promise<'landed' | 'gone' | 'unknown'> {
    if (t.network === 'bitcoin' || t.network === 'litecoin') {
      try {
        const s = await getJson(`${NETWORKS[t.network].rpc[0]}/api/tx/${t.txid}/status`)
        return s.confirmed ? 'landed' : 'unknown'
      } catch (e) { return is404(e) ? 'gone' : 'unknown' }
    }
    if (t.network === 'solana') {
      const r = await rpc(NETWORKS.solana.rpc, 'getSignatureStatuses', [[t.txid], { searchTransactionHistory: true }])
      const s = r?.value?.[0]
      if (!s) return 'gone'
      return s.err ? 'gone' : s.confirmationStatus === 'finalized' ? 'landed' : 'unknown'
    }
    return 'gone' // monero: transfers vanish only if the pool drops them
  }
}
