// Payment safety: PIN lockout, rolling 24 h spend limit, and single-use approval tokens.
// Pure logic (no Electron) so it can be unit-tested; the main process owns all state.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const PIN_RE = /^\d{6}$/
export const LOCK_AFTER = 5 // wrong PINs → payments paused
export const LOCK_MS = 5 * 60_000
export const APP_LOCK_AFTER = 10 // wrong PINs → the whole app locks, full password needed
export const TOKEN_MS = 2 * 60_000

export interface PinGuard { fails: number; lockUntil?: number }

export const pinBlocked = (g: PinGuard, now: number) => !!g.lockUntil && now < g.lockUntil

/** A wrong PIN: count it, pause payments at 5, lock the app at 10. */
export function onPinFail(g: PinGuard, now: number): { guard: PinGuard; lockApp: boolean; remaining: number; lockUntil?: number } {
  const fails = g.fails + 1
  if (fails >= APP_LOCK_AFTER) return { guard: { fails }, lockApp: true, remaining: 0 }
  const lockUntil = fails === LOCK_AFTER ? now + LOCK_MS : g.lockUntil
  return { guard: { fails, lockUntil }, lockApp: false, remaining: (fails < LOCK_AFTER ? LOCK_AFTER : APP_LOCK_AFTER) - fails, lockUntil: fails === LOCK_AFTER ? lockUntil : undefined }
}

// ---------- daily limit ----------
export interface Spend { asset: string; amount: number; time: number; status: string; cancel?: { outcome?: string } }

/** Fiat value of everything sent or swapped away in the last 24 h (failed ones and payments cancelled back to us don't count). */
export function spent24h(items: Spend[], priceOf: (asset: string) => number | undefined, now: number): number {
  return items.filter((i) => i.status !== 'failed' && i.cancel?.outcome !== 'done' && now - i.time < 86_400_000 && now >= i.time).reduce((s, i) => s + i.amount * (priceOf(i.asset) ?? 0), 0)
}

export const isOverLimit = (limit: number | undefined, spent: number, amountFiat: number) => !!limit && limit > 0 && spent + amountFiat > limit + 1e-9

// ---------- approvals ----------
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
/** The exact payment being approved. Change any field and the token no longer fits. */
export const intentHash = (intent: unknown) => createHash('sha256').update(canon(intent)).digest()

export class Approvals {
  private live = new Map<string, { hash: Buffer; exp: number; override: boolean }>()
  issue(intent: unknown, now: number, override = false): string {
    for (const [k, v] of this.live) if (v.exp <= now) this.live.delete(k)
    const token = randomBytes(24).toString('hex')
    this.live.set(token, { hash: intentHash(intent), exp: now + TOKEN_MS, override })
    return token
  }
  /** Single use: the token is gone after this call whether it matched or not. */
  consume(token: unknown, intent: unknown, now: number): { ok: boolean; override: boolean } {
    if (typeof token !== 'string') return { ok: false, override: false }
    const t = this.live.get(token)
    this.live.delete(token)
    if (!t || t.exp <= now) return { ok: false, override: false }
    const h = intentHash(intent)
    return { ok: h.length === t.hash.length && timingSafeEqual(h, t.hash), override: t.override }
  }
  clear() { this.live.clear() }
}
