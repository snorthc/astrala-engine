// Monero block heights ↔ dates, and restore-height validation. Pure, so the UI and tests can use it without monero-ts.

// Reference point (observed 2026-10-31 08:34 UTC); Monero targets one block per 120 s.
export const REF_HEIGHT = 3_795_997
export const REF_TIME = Date.UTC(2026, 9, 31, 8, 34)
const BLOCK_MS = 120_000
const DAY_BLOCKS = 720
const GENESIS = Date.UTC(2014, 3, 18)
const V2_FORK = Date.UTC(2016, 2, 23) // block time went from 60 s to 120 s

/** Block height near a date, padded a day earlier so nothing is missed. */
export const heightAt = (ms: number) => Math.max(1, Math.floor(REF_HEIGHT - (REF_TIME - ms) / BLOCK_MS) - DAY_BLOCKS)

/** Roughly when a block was mined (no padding). Good to a few days for recent blocks. */
export const dateAt = (height: number) => REF_TIME - (REF_HEIGHT - height) * BLOCK_MS

/** Where the chain tip should be right now, by the clock. */
export const estimatedTip = (now = Date.now()) => Math.floor(REF_HEIGHT + (now - REF_TIME) / BLOCK_MS)

/** The highest restore height Astrala accepts: the node's tip when it is known, otherwise the clock's estimate
 *  plus a day of slack (block times vary). */
export const maxRestoreHeight = (daemonHeight?: number, now = Date.now()) => (daemonHeight && daemonHeight > 0 ? daemonHeight : estimatedTip(now) + DAY_BLOCKS)

export type HeightCheck = { ok: true; height: number | null } | { ok: false; error: string }

/** A restore height typed by the user. Empty means "use the wallet's default". Thousands separators are allowed. */
export function parseRestoreHeight(input: string | number | null | undefined, max: number): HeightCheck {
  if (input == null) return { ok: true, height: null }
  const s = String(input).trim().replace(/[,_\s]/g, '')
  if (!s) return { ok: true, height: null }
  if (!/^\d+$/.test(s)) return { ok: false, error: 'Use a whole block number' }
  const h = Number(s)
  if (!Number.isSafeInteger(h)) return { ok: false, error: 'That block is too high' }
  if (h > max) return { ok: false, error: `The chain is only at block ${max.toLocaleString('en-GB')}` }
  return { ok: true, height: h }
}

/** A date input's "YYYY-MM-DD" to a restore height a day before it. Null for an invalid or future date. */
export function heightForDate(ymd: string, now = Date.now()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim())
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (!Number.isFinite(ms) || ms > now) return null
  if (ms < GENESIS) return 0
  // blocks came every 60 s before the March 2016 fork: count those back at double rate so the guess stays early
  if (ms < V2_FORK) return Math.max(0, heightAt(V2_FORK) - Math.ceil((V2_FORK - ms) / 60_000))
  return heightAt(ms)
}
