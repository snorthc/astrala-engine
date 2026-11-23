// Monero, the real thing: a full wallet (monero-ts, official C++ compiled to WASM) running in the main process.
// It scans remote nodes with your view key, rotates to a fresh subaddress for every payment, and signs locally.
import moneroTs from 'monero-ts'

// Wallet scanning runs in monero-ts's worker thread so it never blocks the app.
// In the packaged app the worker must load from the unpacked copy, not from inside app.asar.
{
  const lib: any = (moneroTs as any).LibraryUtils
  const p = lib?.WORKER_DIST_PATH
  if (typeof p === 'string' && p.includes('app.asar') && !p.includes('app.asar.unpacked')) lib.setWorkerDistPath(p.replace('app.asar', 'app.asar.unpacked'))
}
import { net } from './chain'
import { heightAt } from './xmr-height'

// ASTRALA_PERF=1 turns these on. Monero is the one subsystem that can sit silently doing nothing, so it has to say what
// it is doing: which node, what restore height, whether blocks are actually arriving.
const diag = (...a: unknown[]) => { if (process.env.ASTRALA_PERF) console.log('[xmr]', ...a) }

export type XmrState = 'idle' | 'connecting' | 'syncing' | 'synced' | 'offline'
/** height: last block scanned; startHeight: where this scan began; daemonHeight: the node's tip. */
export interface XmrStatus { state: XmrState; percent: number; height: number; startHeight: number; daemonHeight: number; node: string; error?: string }
/** restoreHeight (the account's own, set by the user) wins over birthday when there is no saved scan. */
export interface XmrKeys { address: string; viewSec: string; spendSec: string; birthday?: number; restoreHeight?: number }
export interface XmrTransfer { txid: string; direction: 'in' | 'out'; amount: number; fee: number; time: number; confirmations: number; address: string }

// Public remote nodes (scanning happens locally; nodes only serve blocks). Tried in order; user can add their own.
export const DEFAULT_NODES = [
  'https://xmr-node.cakewallet.com:18081',
  'https://node.sethforprivacy.com:443',
  'https://xmr.cryptostorm.is:18081',
  'https://node.monerodevs.org:18089',
  'http://nodes.hashvault.pro:18081',
  'http://node.community.rino.io:18081'
]
/** No block for this long means the node is not really serving us, whatever the connection says. */
const STALL_MS = 150_000
/** Scan progress reaches the window at most this often (plus on every whole percent), so block numbers stay live. */
const PROGRESS_MS = 1000

export { heightAt } from './xmr-height'
const ATOMIC = 1e12
const PRIORITY = { slow: 1, normal: 2, fast: 3 } as const

export class MoneroService {
  private wallet: Awaited<ReturnType<typeof moneroTs.createWalletFull>> | null = null
  private keys: XmrKeys | null = null
  status: XmrStatus = { state: 'idle', percent: 0, height: 0, startHeight: 0, daemonHeight: 0, node: '' }
  private onChange: (balanceChanged?: boolean) => void
  private saveCache: (data: { keys: Uint8Array; cache: Uint8Array; restoreHeight: number }) => Promise<void>
  private busy = false
  private generation = 0
  private saver: ReturnType<typeof setInterval> | null = null
  private lastData: { keys: Uint8Array; cache: Uint8Array; restoreHeight: number } | null = null
  nodes: string[] = DEFAULT_NODES
  /** SOCKS5 route for the wallet's node connection (Tor / proxy). */
  proxy: string | null = null
  /** Kill switch engaged with no usable route: stay offline rather than connect directly. */
  blocked = false

  constructor(onChange: (balanceChanged?: boolean) => void, saveCache: MoneroService['saveCache']) {
    this.onChange = onChange
    this.saveCache = saveCache
  }

  /** A node can accept the connection and then never send a block. Without this the wallet sits at 0% forever. */
  private lastProgress = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private clearWatchdog() { if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null } }
  private startWatchdog(gen: number) {
    this.clearWatchdog()
    this.watchdog = setInterval(() => {
      if (gen !== this.generation || this.status.state !== 'syncing') return this.clearWatchdog()
      const idle = Date.now() - this.lastProgress
      if (idle < STALL_MS) return
      diag(`no blocks for ${Math.round(idle / 1000)}s on ${this.status.node} — moving to another node`)
      this.clearWatchdog()
      this.nodes = [...this.nodes.filter((n) => n !== this.status.node), this.status.node] // demote the silent one
      this.set({ state: 'offline', error: 'That node stopped sending blocks, trying another' })
      if (this.keys) void this.open(this.keys, this.lastData)
    }, 20_000)
  }

  private set(p: Partial<XmrStatus>) { this.status = { ...this.status, ...p }; this.onChange() }

  /** First node that answers get_info, with its height. */
  async pickNode(): Promise<{ uri: string; height: number } | null> {
    for (const uri of this.nodes) {
      try {
        const r = await net(`${uri}/get_info`, { signal: AbortSignal.timeout(7000) } as RequestInit)
        if (!r.ok) continue
        const j: any = await r.json()
        if (j?.height) return { uri, height: j.height }
      } catch { /* next */ }
    }
    return null
  }

  async open(keys: XmrKeys, cached?: { keys: Uint8Array; cache: Uint8Array; restoreHeight: number } | null) {
    const gen = ++this.generation
    await this.close()
    this.keys = keys
    if (this.blocked) { diag('blocked by the route kill switch; not opening'); this.set({ state: 'offline', error: 'Waiting for the secure route' }); return }
    this.set({ state: 'connecting', percent: 0, error: undefined })
    diag('picking a node from', this.nodes.length, 'candidates')
    const node = await this.pickNode()
    diag(node ? `node ${node.uri} at height ${node.height}` : 'no node answered get_info')
    if (gen !== this.generation) return
    if (!node) { this.set({ state: 'offline', error: 'No Monero node reachable' }); setTimeout(() => gen === this.generation && this.open(keys, cached), 60_000); return }
    const restoreHeight = cached?.restoreHeight ?? Math.min(keys.restoreHeight ?? heightAt(keys.birthday ?? Date.now()), node.height)
    diag(`restore height ${restoreHeight} (${cached ? 'from cache' : 'fresh'}), ${node.height - restoreHeight} blocks to scan`)
    const common = { networkType: moneroTs.MoneroNetworkType.MAINNET, password: 'astrala-local', proxyToWorker: true, server: { uri: node.uri, ...(this.proxy ? { proxyUri: this.proxy } : {}) } }
    try {
      this.wallet = cached
        ? await moneroTs.openWalletFull({ ...common, keysData: cached.keys, cacheData: cached.cache })
        : await moneroTs.createWalletFull({ ...common, primaryAddress: keys.address, privateViewKey: keys.viewSec, privateSpendKey: keys.spendSec, restoreHeight })
    } catch (e: any) {
      diag('wallet open FAILED:', e?.message ?? e)
      this.set({ state: 'offline', error: String(e?.message ?? e).slice(0, 120) })
      setTimeout(() => gen === this.generation && this.open(keys, cached), 60_000); return
    }
    if (gen !== this.generation) { await this.wallet?.close(); return }
    if ((await this.wallet.getPrimaryAddress()) !== keys.address) { await this.close(); this.set({ state: 'offline', error: 'Key mismatch' }); return }
    diag('wallet open, starting sync')
    this.set({ state: 'syncing', node: node.uri, daemonHeight: node.height, height: restoreHeight, startHeight: restoreHeight })
    this.lastProgress = Date.now()
    const self = this
    const listener = new (class extends moneroTs.MoneroWalletListener {
      private emitted = 0
      async onSyncProgress(height: number, startHeight: number, endHeight: number, percentDone: number) {
        const pct = Math.round(percentDone * 100)
        const now = Date.now()
        self.lastProgress = now
        if (gen !== self.generation) return
        if (pct !== self.status.percent || endHeight - height < 2 || now - this.emitted >= PROGRESS_MS) {
          if (pct !== self.status.percent) diag(`sync ${pct}% — block ${height} of ${endHeight}`)
          this.emitted = now
          self.set({ height, startHeight, daemonHeight: endHeight, percent: pct })
        }
      }
      async onBalancesChanged() { if (gen === self.generation) self.onChange(true) }
    })()
    await this.wallet.addListener(listener)
    this.startWatchdog(gen)
    try {
      await this.wallet.sync()
      if (gen !== this.generation) return
      diag('sync complete')
      try { // what the scan found, so a missing payment can be traced from the log (amounts and heights only)
        const w = this.wallet!
        const [bal, unl, ts, addr] = await Promise.all([w.getBalance(0), w.getUnlockedBalance(0), w.getTransfers({ accountIndex: 0 }), w.getPrimaryAddress()])
        diag(`found: balance ${Number(bal) / 1e12} XMR, unlocked ${Number(unl) / 1e12}, ${ts.length} transfers${ts.length ? ' at heights ' + ts.map((t: any) => t.getTx().getHeight() ?? 'pool').join(',') : ''}, primary ${String(addr).slice(0, 8)}…`)
      } catch (e: any) { diag('could not read results:', e?.message ?? e) }
      this.clearWatchdog()
      this.set({ state: 'synced', percent: 100, height: await this.wallet.getHeight().catch(() => node.height) })
      await this.persist(restoreHeight)
      await this.wallet.startSyncing(20_000)
      if (this.saver) clearInterval(this.saver)
      this.saver = setInterval(() => gen === this.generation && this.persist(restoreHeight), 180_000)
    } catch (e: any) {
      if (gen !== this.generation) return // locked or switched mid-scan
      diag('sync FAILED on', node.uri, '-', e?.message ?? e)
      this.clearWatchdog()
      this.nodes = [...this.nodes.filter((n) => n !== node.uri), node.uri] // try a different node next time
      this.set({ state: 'offline', error: String(e?.message ?? e).slice(0, 120) })
      await this.persist(restoreHeight) // keep whatever was scanned
      setTimeout(() => gen === this.generation && this.keys && this.open(this.keys, this.lastData), 15_000)
    }
  }

  private async persist(restoreHeight: number) {
    if (!this.wallet) return
    try {
      const [k, c] = await this.wallet.getData()
      this.lastData = { keys: new Uint8Array(k.buffer, k.byteOffset, k.byteLength).slice(), cache: new Uint8Array(c.buffer, c.byteOffset, c.byteLength).slice(), restoreHeight }
      await this.saveCache(this.lastData)
    } catch { /* best effort */ }
  }

  /** Lock: abort any in-flight open, drop the wallet from memory. */
  async stop() {
    this.clearWatchdog()
    this.generation++
    this.keys = null
    this.lastData = null
    await this.close()
    this.status = { state: 'idle', percent: 0, height: 0, startHeight: 0, daemonHeight: 0, node: '' }
  }

  async close() {
    if (this.saver) { clearInterval(this.saver); this.saver = null }
    const w = this.wallet
    this.wallet = null
    if (w) { try { await w.stopSyncing(); await w.close(false) } catch { /* ignore */ } }
  }

  /** The balance a saved wallet file had at its last scan, read offline: no node, no sync, nothing leaves the machine.
   *  Lets Astrala show every account's Monero, though only one account is scanned live at a time. */
  static async savedBalance(cached: { keys: Uint8Array; cache: Uint8Array }, address: string): Promise<number | null> {
    let w: any = null
    try {
      w = await moneroTs.openWalletFull({ networkType: moneroTs.MoneroNetworkType.MAINNET, password: 'astrala-local', proxyToWorker: true, keysData: cached.keys, cacheData: cached.cache })
      if ((await w.getPrimaryAddress()) !== address) return null // a file from another wallet: never trust its number
      return Number(await w.getBalance(0)) / ATOMIC
    } catch { return null } finally { await w?.close().catch(() => {}) }
  }

  async balance(): Promise<{ total: number; unlocked: number } | null> {
    if (!this.wallet || this.status.state !== 'synced') return null
    return { total: Number(await this.wallet.getBalance(0)) / ATOMIC, unlocked: Number(await this.wallet.getUnlockedBalance(0)) / ATOMIC }
  }

  /** A fresh subaddress for every payment: reuse the newest one until something lands on it. */
  async receiveAddress(forceNew = false): Promise<string> {
    if (!this.wallet) return this.keys?.address ?? ''
    const subs = await this.wallet.getSubaddresses(0)
    const latest = subs[subs.length - 1]
    if (!forceNew && latest && latest.getIndex() > 0 && !latest.getIsUsed()) return latest.getAddress()
    return (await this.wallet.createSubaddress(0, `r${Date.now()}`)).getAddress()
  }

  async transfers(): Promise<XmrTransfer[]> {
    if (!this.wallet) return []
    const ts = await this.wallet.getTransfers({ accountIndex: 0 })
    return ts.map((t: any) => {
      const tx = t.getTx()
      const incoming = t.getIsIncoming()
      return {
        txid: tx.getHash(),
        direction: incoming ? 'in' : 'out',
        amount: Number(t.getAmount()) / ATOMIC,
        fee: incoming ? 0 : Number(tx.getFee() ?? 0n) / ATOMIC,
        time: (tx.getBlock()?.getTimestamp() ?? Date.now() / 1000) * 1000,
        confirmations: tx.getNumConfirmations() ?? 0,
        address: incoming ? t.getAddress?.() ?? '' : t.getDestinations?.()?.[0]?.getAddress() ?? ''
      } as XmrTransfer
    })
  }

  static isValid(addr: string) { return moneroTs.MoneroUtils.isValidAddress(addr, moneroTs.MoneroNetworkType.MAINNET) }

  private async build(to: string, amount: string, speed: keyof typeof PRIORITY, max: boolean, relay: boolean) {
    if (!this.wallet) throw new Error('Monero is still syncing')
    if (this.status.state !== 'synced') throw new Error(`Monero is syncing (${this.status.percent}%)`)
    if (this.busy && relay) throw new Error('A Monero payment is already being sent')
    this.busy = relay
    try {
      if (max) {
        const txs = await this.wallet.sweepUnlocked({ accountIndex: 0, address: to, priority: PRIORITY[speed], relay })
        const out = txs.reduce((s: bigint, t: any) => s + (t.getOutgoingAmount() ?? 0n), 0n)
        const fee = txs.reduce((s: bigint, t: any) => s + (t.getFee() ?? 0n), 0n)
        return { amount: Number(out) / ATOMIC, fee: Number(fee) / ATOMIC, txid: txs[0]?.getHash() ?? '' }
      }
      const atomic = BigInt(Math.round(Number(amount) * ATOMIC))
      const tx = await this.wallet.createTx({ accountIndex: 0, address: to, amount: atomic, priority: PRIORITY[speed], relay })
      return { amount: Number(atomic) / ATOMIC, fee: Number(tx.getFee()) / ATOMIC, txid: tx.getHash() }
    } finally {
      if (relay) this.busy = false
    }
  }
  quote(to: string, amount: string, speed: keyof typeof PRIORITY, max: boolean) { return this.build(to, amount, speed, max, false) }
  send(to: string, amount: string, speed: keyof typeof PRIORITY, max: boolean) { return this.build(to, amount, speed, max, true) }
}
