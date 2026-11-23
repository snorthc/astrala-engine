// Anonymous install heartbeat + live config poller.
//
// The HQ URL lives in ops/hq-url.ts, which is gitignored and stripped from the public export;
// if the file is missing (the public repo build), import.meta.glob returns {} and every call
// here degrades to a no-op. So a developer cloning the public repo gets a wallet that never
// phones home, and the author's build (with ops/hq-url.ts filled in) gets exactly three fields
// sent out: a random install id, the version, and the platform string. No addresses, no
// transactions, no IP tracking.
//
// Live config is the small JSON Astrala HQ publishes at /api/live.json — latest versions and
// broadcast banners. The wallet polls it and renders the banner / update pill from the result.
import { net } from './chain'

// @ts-ignore: Vite fills this in at build time; it is {} when the file doesn't exist.
const LOCAL = import.meta.glob('../../ops/hq-url.ts', { eager: true }) as Record<string, { HQ_URL: string }>

/** HQ is only ever reached over https on a public host. A plain-http or loopback address (a dev HQ on the
 *  author's own Mac) would make every user's wallet talk to whatever listens on their own machine, so it
 *  counts as "no HQ" and the wallet keeps its built-in rates. */
export function usableHqUrl(raw: unknown): string {
  const s = String(raw ?? '').trim().replace(/\/+$/, '')
  let u: URL
  try { u = new URL(s) } catch { return '' }
  if (u.protocol !== 'https:' || u.username || u.password) return ''
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || h === '0.0.0.0') return ''
  return s
}
export const HQ_URL: string = usableHqUrl(Object.values(LOCAL)[0]?.HQ_URL)
export const hqEnabled = () => !!HQ_URL

export type Platform = 'mac' | 'chrome' | 'edge' | 'firefox' | 'brave' | 'web'

export interface LiveConfig {
  latest: { mac: string; ext: string }
  forceUpdate: boolean
  /** Optional fee rates set in HQ (basis points). The wallet clamps them to FEE_CEILING in core/fees.ts. */
  fees?: { swapBps?: number; splitBps?: number; routeBps?: number }
  broadcasts: { id: string; text: string; link?: string; tone: 'launch' | 'info' | 'warning'; audience: 'site' | 'mac' | 'ext' | 'all' }[]
  at: number
}

// A fresh timeout per request (one made at load time would already be spent after 8 s, cancelling every later call).
// Requests go through net(), so they follow Astral Route: Tor, Mullvad or the proxy, and the kill switch.
const timeout = () => ({ signal: AbortSignal.timeout(15000) as any })

export async function beat(input: { id: string; v: string; p: Platform; enabled: boolean }): Promise<void> {
  if (!HQ_URL || !input.enabled || !/^[a-f0-9]{16,64}$/i.test(input.id)) return
  try {
    await net(`${HQ_URL}/api/i`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: input.id, v: input.v, p: input.p }), ...timeout() })
  } catch { /* offline, HQ down, whatever — never block the wallet */ }
}

export async function fetchLive(): Promise<LiveConfig | null> {
  if (!HQ_URL) return null
  try {
    const r = await net(`${HQ_URL}/api/live.json`, timeout())
    if (!r.ok) return null
    return (await r.json()) as LiveConfig
  } catch { return null }
}

/** Compare two dotted version strings (e.g. '0.12.0' vs '0.12.1'). Returns 1 if a>b, -1 if a<b, 0 if equal. */
export function cmpVersion(a: string, b: string): number {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y ? 1 : -1 }
  return 0
}

/** Did `latest` go past `current`? Convenience for the Update pill. */
export const hasUpdate = (current: string, latest: string) => !!latest && cmpVersion(latest, current) > 0
