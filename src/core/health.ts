// Network health: one cheap read per chain (its current block height), timed, through the app's own fetcher so
// Astral Route and its kill switch apply exactly as they do to balances. Only endpoints already configured in
// NETWORKS are touched, and only while the Status panel is open. Pure apart from the fetcher it is handed.
import { NETWORKS } from './assets'

export type ProbeState = 'ok' | 'slow' | 'down' | 'held'
export interface ChainProbe {
  network: string
  name: string
  /** the endpoint's host, never the full URL (some carry keys in the path) */
  host: string
  state: ProbeState
  /** round trip in ms, through the route (Tor and Mullvad add their own delay) */
  ms?: number
  height?: number
  error?: string
}
export interface NetHealth { at: number; held: boolean; chains: ChainProbe[] }

/** At or above this a reachable node reads as slow. */
export const SLOW_MS = 1500
/** Shown in this order: the headline chains first, then the rest of EVM, then the long tail. */
export const PROBE_ORDER = ['bitcoin', 'ethereum', 'solana', 'litecoin', 'arbitrum', 'base', 'optimism', 'polygon', 'bsc', 'avalanche', 'tron', 'dogecoin'] as const

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
interface Probe { url: string; init?: RequestInit; height: (body: any) => number | undefined }

const hex = (v: unknown) => (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined)
const jsonRpc = (method: string) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) })

/** The cheapest height read each chain's first configured endpoint offers. null = nothing to ping (Monero has its own scan status). */
export function probeFor(network: string): Probe | null {
  const n = NETWORKS[network]
  const base = n?.rpc?.[0]
  if (!n || !base) return null
  switch (n.family) {
    case 'evm': return { url: base, init: jsonRpc('eth_blockNumber'), height: (j) => hex(j?.result) }
    case 'sol': return { url: base, init: jsonRpc('getSlot'), height: (j) => num(j?.result) }
    case 'btc': case 'ltc': return { url: `${base}/api/blocks/tip/height`, height: (j) => num(j) }
    case 'doge': return { url: base, height: (j) => num(j?.height) }
    case 'trx': return { url: `${base}/wallet/getnowblock`, init: { method: 'POST' }, height: (j) => num(j?.block_header?.raw_data?.number) }
    default: return null
  }
}

export const hostOf = (url: string) => { try { return new URL(url).host } catch { return '' } }

/** Turn one timed attempt into what the panel shows. Errors are cut short and never include the URL. */
export function shapeProbe(network: string, r: { ms: number; height?: number; error?: unknown; held?: boolean }): ChainProbe {
  const n = NETWORKS[network]
  const p = probeFor(network)
  const base = { network, name: n?.name ?? network, host: p ? hostOf(p.url) : '' }
  if (r.held) return { ...base, state: 'held', error: 'Held by the kill switch' }
  if (r.error != null) {
    const msg = String((r.error as any)?.message ?? r.error)
    const error = /abort|timeout|timed out/i.test(msg) ? 'No answer' : /HTTP (\d+)/.test(msg) ? `Refused (${/HTTP (\d+)/.exec(msg)![1]})` : 'Unreachable'
    return { ...base, state: 'down', ms: undefined, error }
  }
  const ms = Math.max(0, Math.round(r.ms))
  return { ...base, state: ms >= SLOW_MS ? 'slow' : 'ok', ms, ...(r.height != null && r.height > 0 ? { height: r.height } : {}) }
}

/** Ping every chain at once. `held`: the route is down and the kill switch is holding traffic, so nothing is sent. */
export async function pingChains(fetch: Fetch, opts: { held?: boolean; timeoutMs?: number; now?: () => number } = {}): Promise<NetHealth> {
  const now = opts.now ?? (() => performance.now())
  const nets = PROBE_ORDER.filter((n) => probeFor(n))
  if (opts.held) return { at: Date.now(), held: true, chains: nets.map((n) => shapeProbe(n, { ms: 0, held: true })) }
  const chains = await Promise.all(nets.map(async (network) => {
    const p = probeFor(network)!
    const t0 = now()
    try {
      const r = await fetch(p.url, { ...p.init, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const text = await r.text()
      const ms = now() - t0
      let body: unknown = text
      try { body = JSON.parse(text) } catch { /* esplora answers a bare number */ }
      return shapeProbe(network, { ms, height: p.height(body) })
    } catch (error) {
      return shapeProbe(network, { ms: now() - t0, error })
    }
  }))
  return { at: Date.now(), held: false, chains }
}

/** A one-line verdict for the sidebar dot: worst first. */
export function overall(chains: ChainProbe[]): ProbeState {
  if (!chains.length) return 'ok'
  if (chains.every((c) => c.state === 'held')) return 'held'
  const down = chains.filter((c) => c.state === 'down').length
  if (down > chains.length / 2) return 'down'
  if (down || chains.some((c) => c.state === 'slow')) return 'slow'
  return 'ok'
}
