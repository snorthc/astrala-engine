// Transaction history per chain (sent + received), normalised. Read-only public sources, all via net().
// BTC/LTC: Esplora · DOGE: BlockCypher · ETH/AVAX: Routescan · other EVM: on-chain ERC-20 Transfer logs
// · SOL: RPC signatures + parsed transactions · TRX: TronGrid.
import { ASSETS, NETWORKS, type Asset } from './assets'
import { getJson, rpc, type Addresses } from './chain'
import { tronDecode, tronFromHex } from './derive'
import { bytesToHex } from '@noble/hashes/utils.js'

export interface HistoryItem {
  id: string
  asset: string
  network: string
  direction: 'in' | 'out'
  amount: number
  counterparty: string
  txid: string
  time: number
  status: 'pending' | 'confirmed' | 'failed'
}

const tokenOn = (network: string, contract: string) => ASSETS.find((a) => a.network === network && a.kind === 'token' && a.contract!.toLowerCase() === contract.toLowerCase())
const nativeOf = (network: string) => ASSETS.find((a) => a.id === NETWORKS[network].native)!
const units = (v: string | number | bigint, d: number) => Number(BigInt(v)) / 10 ** d
const LIMIT = 25

async function esploraHistory(network: 'bitcoin' | 'litecoin', addr: string): Promise<HistoryItem[]> {
  const txs: any[] = await getJson(`${NETWORKS[network].rpc[0]}/api/address/${addr}/txs`)
  const a = nativeOf(network)
  return txs.slice(0, LIMIT).map((tx) => {
    const got = tx.vout.filter((o: any) => o.scriptpubkey_address === addr).reduce((s: number, o: any) => s + o.value, 0)
    const spent = tx.vin.filter((i: any) => i.prevout?.scriptpubkey_address === addr).reduce((s: number, i: any) => s + i.prevout.value, 0)
    const net = got - spent
    const dir = net >= 0 ? 'in' : 'out'
    const other = dir === 'in' ? tx.vin[0]?.prevout?.scriptpubkey_address : tx.vout.find((o: any) => o.scriptpubkey_address !== addr)?.scriptpubkey_address
    return { id: `${network}:${tx.txid}`, asset: a.id, network, direction: dir, amount: Math.abs(net) / 1e8, counterparty: other ?? '', txid: tx.txid, time: (tx.status.block_time ?? Date.now() / 1000) * 1000, status: tx.status.confirmed ? 'confirmed' : 'pending' } as HistoryItem
  })
}

async function dogeHistory(addr: string): Promise<HistoryItem[]> {
  const j = await getJson(`${NETWORKS.dogecoin.rpc[0]}/addrs/${addr}/full?limit=${LIMIT}`)
  return (j.txs ?? []).map((tx: any) => {
    const got = tx.outputs.filter((o: any) => o.addresses?.includes(addr)).reduce((s: number, o: any) => s + o.value, 0)
    const spent = tx.inputs.filter((i: any) => i.addresses?.includes(addr)).reduce((s: number, i: any) => s + (i.output_value ?? 0), 0)
    const net = got - spent
    const dir = net >= 0 ? 'in' : 'out'
    const other = dir === 'in' ? tx.inputs[0]?.addresses?.[0] : tx.outputs.find((o: any) => !o.addresses?.includes(addr))?.addresses?.[0]
    return { id: `dogecoin:${tx.hash}`, asset: 'doge', network: 'dogecoin', direction: dir, amount: Math.abs(net) / 1e8, counterparty: other ?? '', txid: tx.hash, time: Date.parse(tx.confirmed ?? tx.received), status: (tx.confirmations ?? 0) > 0 ? 'confirmed' : 'pending' } as HistoryItem
  })
}

const ROUTESCAN: Record<string, number> = { ethereum: 1, avalanche: 43114 }
async function routescanHistory(network: string, addr: string): Promise<HistoryItem[]> {
  const base = `https://api.routescan.io/v2/network/mainnet/evm/${ROUTESCAN[network]}/etherscan/api?address=${addr}&page=1&offset=${LIMIT}&sort=desc&module=account&action=`
  // internal = ETH moved by a contract (exchange withdrawals, smart-contract wallets, bridges): not in txlist
  // Etherscan-style APIs answer errors with HTTP 200 and status "0" ("rate limit", "NOTOK"). Only "No transactions
  // found" is a real empty answer; anything else is a failure, so Activity says so instead of showing nothing.
  const call = async (action: string) => {
    const j = await getJson(base + action)
    if (Array.isArray(j?.result)) return j
    if (/no (transactions|records) found/i.test(`${j?.message} ${j?.result}`)) return { result: [] }
    throw new Error(`${action}: ${String(j?.result ?? j?.message ?? 'bad answer').slice(0, 80)}`)
  }
  const [txs, toks, inner] = await Promise.all([call('txlist'), call('tokentx'), call('txlistinternal').catch(() => ({ result: [] }))])
  const me = addr.toLowerCase()
  const out: HistoryItem[] = []
  const native = nativeOf(network)
  for (const t of Array.isArray(txs.result) ? txs.result : []) {
    if (t.value === '0') continue
    const dir = t.to?.toLowerCase() === me ? 'in' : 'out'
    out.push({ id: `${network}:${t.hash}`, asset: native.id, network, direction: dir, amount: units(t.value, 18), counterparty: dir === 'in' ? t.from : t.to, txid: t.hash, time: Number(t.timeStamp) * 1000, status: t.isError === '1' ? 'failed' : 'confirmed' })
  }
  const listed = new Set(out.map((o) => o.txid))
  for (const t of Array.isArray(inner.result) ? inner.result : []) {
    if (t.value === '0' || t.isError === '1' || listed.has(t.hash)) continue
    const dir = t.to?.toLowerCase() === me ? 'in' : 'out'
    out.push({ id: `${network}:${t.hash}:internal:${t.traceId ?? ''}`, asset: native.id, network, direction: dir, amount: units(t.value, 18), counterparty: dir === 'in' ? t.from : t.to, txid: t.hash, time: Number(t.timeStamp) * 1000, status: 'confirmed' })
  }
  for (const t of Array.isArray(toks.result) ? toks.result : []) {
    const a = tokenOn(network, t.contractAddress)
    if (!a) continue // unknown tokens are usually spam: ignore
    const dir = t.to?.toLowerCase() === me ? 'in' : 'out'
    out.push({ id: `${network}:${t.hash}:${a.id}`, asset: a.id, network, direction: dir, amount: units(t.value, a.decimals), counterparty: dir === 'in' ? t.from : t.to, txid: t.hash, time: Number(t.timeStamp) * 1000, status: 'confirmed' })
  }
  return out
}

/** Chains without a free indexer: read ERC-20 Transfer events for our known tokens straight from the chain. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
async function logHistory(network: string, addr: string): Promise<HistoryItem[]> {
  const tokens = ASSETS.filter((a) => a.network === network && a.kind === 'token')
  if (!tokens.length) return []
  const rpcs = NETWORKS[network].rpc
  const head = Number(BigInt(await rpc(rpcs, 'eth_blockNumber', [])))
  const topicAddr = '0x' + addr.slice(2).toLowerCase().padStart(64, '0')
  const out: HistoryItem[] = []
  const span = 9_000, windows = 3 // recent blocks, in RPC-friendly chunks
  for (let w = 0; w < windows && out.length < LIMIT; w++) {
    const to = head - w * span, from = Math.max(0, to - span + 1)
    await Promise.all((['in', 'out'] as const).map(async (dirTopic) => {
      const topics = dirTopic === 'in' ? [TRANSFER, null, topicAddr] : [TRANSFER, topicAddr]
      let logs: any[] = []
      try { logs = await rpc(rpcs, 'eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), address: tokens.map((t) => t.contract), topics }]) } catch { return }
      for (const l of logs) {
        const a = tokenOn(network, l.address)
        if (!a) continue
        const other = '0x' + l.topics[dirTopic === 'in' ? 1 : 2].slice(26)
        out.push({ id: `${network}:${l.transactionHash}:${a.id}`, asset: a.id, network, direction: dirTopic, amount: units(l.data, a.decimals), counterparty: other, txid: l.transactionHash, time: 0, status: 'confirmed', _block: Number(BigInt(l.blockNumber)) } as HistoryItem & { _block: number })
      }
    }))
  }
  // timestamps: one block lookup per distinct block (capped)
  const blocks = [...new Set(out.map((o: any) => o._block))].slice(0, 20)
  const times = new Map<number, number>()
  await Promise.all(blocks.map(async (b) => { try { const blk = await rpc(rpcs, 'eth_getBlockByNumber', ['0x' + b.toString(16), false]); times.set(b, Number(BigInt(blk.timestamp)) * 1000) } catch { /* ignore */ } }))
  return out.map((o: any) => { const { _block, ...rest } = o; return { ...rest, time: times.get(_block) ?? Date.now() } })
}

async function solHistory(addr: string): Promise<HistoryItem[]> {
  const rpcs = NETWORKS.solana.rpc
  const sigs: any[] = await rpc(rpcs, 'getSignaturesForAddress', [addr, { limit: 12, commitment: 'confirmed' }])
  const out: HistoryItem[] = []
  const txs = await Promise.all(sigs.map((s, k) => new Promise((r) => setTimeout(r, k * 120)).then(() => rpc(rpcs, 'getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]).catch(() => null))))
  for (const [k, s] of sigs.entries()) {
    const tx: any = txs[k]
    if (!tx?.meta) continue
    const keys = tx.transaction.message.accountKeys.map((k: any) => (typeof k === 'string' ? k : k.pubkey))
    const i = keys.indexOf(addr)
    const time = (tx.blockTime ?? Date.now() / 1000) * 1000
    const status = tx.meta.err ? 'failed' : s.confirmationStatus === 'finalized' ? 'confirmed' : 'pending'
    if (i >= 0) {
      const delta = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) + (i === 0 ? tx.meta.fee : 0)
      if (Math.abs(delta) > 0) out.push({ id: `solana:${s.signature}:sol`, asset: 'sol', network: 'solana', direction: delta > 0 ? 'in' : 'out', amount: Math.abs(delta) / 1e9, counterparty: keys.find((k: string, j: number) => j !== i && j < 3 && k !== '11111111111111111111111111111111') ?? '', txid: s.signature, time, status })
    }
    const pre = new Map<string, number>(), post = new Map<string, number>()
    for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === addr) pre.set(b.mint, Number(b.uiTokenAmount.uiAmountString))
    for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === addr) post.set(b.mint, Number(b.uiTokenAmount.uiAmountString))
    for (const mint of new Set([...pre.keys(), ...post.keys()])) {
      const a = tokenOn('solana', mint)
      if (!a) continue
      const d = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0)
      if (d !== 0) out.push({ id: `solana:${s.signature}:${a.id}`, asset: a.id, network: 'solana', direction: d > 0 ? 'in' : 'out', amount: Math.abs(d), counterparty: '', txid: s.signature, time, status })
    }
  }
  return out
}

const tronHex = (b58: string) => bytesToHex(tronDecode(b58)).toLowerCase()
async function tronHistory(addr: string): Promise<HistoryItem[]> {
  const base = NETWORKS.tron.rpc[0]
  const me = tronHex(addr)
  const [nat, trc] = await Promise.all([getJson(`${base}/v1/accounts/${addr}/transactions?limit=${LIMIT}`), getJson(`${base}/v1/accounts/${addr}/transactions/trc20?limit=${LIMIT}`)])
  const out: HistoryItem[] = []
  for (const t of nat.data ?? []) {
    const c = t.raw_data?.contract?.[0]
    if (c?.type !== 'TransferContract') continue
    const v = c.parameter.value
    const dir = v.to_address?.toLowerCase() === me ? 'in' : 'out'
    out.push({ id: `tron:${t.txID}`, asset: 'trx', network: 'tron', direction: dir, amount: v.amount / 1e6, counterparty: (() => { try { return tronFromHex(dir === 'in' ? v.owner_address : v.to_address) } catch { return '' } })(), txid: t.txID, time: t.block_timestamp, status: t.ret?.[0]?.contractRet === 'SUCCESS' ? 'confirmed' : 'failed' })
  }
  for (const t of trc.data ?? []) {
    const a = tokenOn('tron', t.token_info?.address ?? '')
    if (!a) continue
    const dir = t.to === addr ? 'in' : 'out'
    out.push({ id: `tron:${t.transaction_id}:${a.id}`, asset: a.id, network: 'tron', direction: dir, amount: units(t.value, a.decimals), counterparty: dir === 'in' ? t.from : t.to, txid: t.transaction_id, time: t.block_timestamp, status: 'confirmed' })
  }
  return out
}

/** Newest first, one entry per id, dust dropped. */
export function tidy(items: HistoryItem[]): HistoryItem[] {
  const seen = new Set<string>()
  return items.filter((h) => h.amount > 1e-12 && !seen.has(h.id) && seen.add(h.id)).sort((a, b) => b.time - a.time).slice(0, 200)
}

/** Called as each source finishes: its items, or the error that stopped it, and how long it took. */
export type SourceReport = (source: string, result: HistoryItem[] | Error, ms: number) => void

/** Everything we can find, newest first. Each source fails independently and reports as it lands. */
export async function getTxHistory(addrs: Addresses, report?: SourceReport): Promise<HistoryItem[]> {
  const jobs: [string, () => Promise<HistoryItem[]>][] = []
  if (addrs.btc) jobs.push(['Bitcoin', () => esploraHistory('bitcoin', addrs.btc!)])
  if (addrs.ltc) jobs.push(['Litecoin', () => esploraHistory('litecoin', addrs.ltc!)])
  if (addrs.doge) jobs.push(['Dogecoin', () => dogeHistory(addrs.doge!)])
  if (addrs.sol) jobs.push(['Solana', () => solHistory(addrs.sol!)])
  if (addrs.trx) jobs.push(['Tron', () => tronHistory(addrs.trx!)])
  if (addrs.evm) {
    jobs.push(['Ethereum', () => routescanHistory('ethereum', addrs.evm!)], ['Avalanche', () => routescanHistory('avalanche', addrs.evm!)])
    for (const n of ['arbitrum', 'base', 'optimism', 'polygon', 'bsc']) jobs.push([NETWORKS[n].name, () => logHistory(n, addrs.evm!)])
  }
  const res = await Promise.all(jobs.map(async ([name, run]) => {
    const t0 = Date.now()
    try { const r = await run(); report?.(name, r, Date.now() - t0); return r }
    catch (e) { report?.(name, e instanceof Error ? e : new Error(String(e)), Date.now() - t0); return [] }
  }))
  return tidy(res.flat())
}

export type { Asset }
