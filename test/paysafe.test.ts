import { describe, expect, it } from 'vitest'
import { Approvals, onPinFail, pinBlocked, spent24h, isOverLimit, TOKEN_MS, LOCK_MS } from '../src/core/paysafe'

describe('PIN lockout', () => {
  it('pauses payments after 5 wrong PINs and locks the app at 10', () => {
    let g = { fails: 0 } as { fails: number; lockUntil?: number }
    const now = 1_000_000
    for (let i = 1; i <= 4; i++) { const r = onPinFail(g, now); g = r.guard; expect(r.lockApp).toBe(false); expect(r.remaining).toBe(5 - i); expect(pinBlocked(g, now)).toBe(false) }
    const fifth = onPinFail(g, now); g = fifth.guard
    expect(fifth.lockUntil).toBe(now + LOCK_MS)
    expect(pinBlocked(g, now + 1000)).toBe(true)
    expect(pinBlocked(g, now + LOCK_MS + 1)).toBe(false)
    for (let i = 6; i <= 9; i++) { const r = onPinFail(g, now + LOCK_MS + i); g = r.guard; expect(r.lockApp).toBe(false); expect(r.remaining).toBe(10 - i) }
    const tenth = onPinFail(g, now + LOCK_MS + 20)
    expect(tenth.lockApp).toBe(true)
  })
})

describe('daily limit', () => {
  const price = (a: string) => ({ eth: 2000, sol: 100 } as Record<string, number>)[a]
  const now = Date.UTC(2026, 9, 31, 12)
  const items = [
    { asset: 'eth', amount: 0.1, time: now - 3600e3, status: 'confirmed' }, // 200
    { asset: 'sol', amount: 1, time: now - 23 * 3600e3, status: 'pending' }, // 100
    { asset: 'sol', amount: 5, time: now - 25 * 3600e3, status: 'confirmed' }, // outside the window
    { asset: 'eth', amount: 1, time: now - 60e3, status: 'failed' } // failed: doesn't count
  ]
  it('counts only the last 24 h and ignores failures', () => expect(spent24h(items, price, now)).toBeCloseTo(300))
  it('ignores a payment cancelled back to us, but not one whose cancel came too late', () => {
    const p = () => 100
    expect(spent24h([{ asset: 'btc', amount: 1, time: now - 1000, status: 'confirmed', cancel: { outcome: 'done' } }], p, now)).toBe(0)
    expect(spent24h([{ asset: 'btc', amount: 1, time: now - 1000, status: 'confirmed', cancel: { outcome: 'late' } }], p, now)).toBe(100)
    expect(spent24h([{ asset: 'btc', amount: 1, time: now - 1000, status: 'pending', cancel: {} }], p, now)).toBe(100) // still might go through
  })
  it('flags a send that would cross the limit', () => {
    expect(isOverLimit(500, 300, 199)).toBe(false)
    expect(isOverLimit(500, 300, 201)).toBe(true)
    expect(isOverLimit(undefined, 1e9, 1e9)).toBe(false)
    expect(isOverLimit(0, 1e9, 1)).toBe(false)
  })
})

describe('approval tokens', () => {
  const intent = { kind: 'send', req: { assetId: 'eth', to: '0xabc', amount: '0.5', account: 0, speed: 'normal', max: false } }
  it('authorise exactly one matching payment', () => {
    const a = new Approvals()
    const t = a.issue(intent, 0)
    expect(a.consume(t, { ...intent }, 1000).ok).toBe(true)
    expect(a.consume(t, intent, 1000).ok).toBe(false) // single use
  })
  it('refuse a different amount, recipient or route', () => {
    const a = new Approvals()
    const t1 = a.issue(intent, 0)
    expect(a.consume(t1, { ...intent, req: { ...intent.req, amount: '5' } }, 10).ok).toBe(false)
    const t2 = a.issue(intent, 0)
    expect(a.consume(t2, { ...intent, req: { ...intent.req, to: '0xevil' } }, 10).ok).toBe(false)
    const swap = { kind: 'swap', req: { from: 'eth', to: 'ltc', amount: '1' }, provider: 'wagyu', minOut: 40 }
    const t3 = a.issue(swap, 0)
    expect(a.consume(t3, { ...swap, provider: 'thorchain' }, 10).ok).toBe(false)
  })
  it('key order does not matter, but expiry does', () => {
    const a = new Approvals()
    const t = a.issue(intent, 0)
    expect(a.consume(t, { req: { max: false, speed: 'normal', account: 0, amount: '0.5', to: '0xabc', assetId: 'eth' }, kind: 'send' }, 5).ok).toBe(true)
    const t2 = a.issue(intent, 0)
    expect(a.consume(t2, intent, TOKEN_MS + 1).ok).toBe(false)
    expect(a.consume('nope', intent, 1).ok).toBe(false)
    expect(a.consume(undefined, intent, 1).ok).toBe(false)
  })
  it('carries the over-limit override only when it was approved', () => {
    const a = new Approvals()
    expect(a.consume(a.issue(intent, 0, true), intent, 1).override).toBe(true)
    expect(a.consume(a.issue(intent, 0), intent, 1).override).toBe(false)
  })
})

// regression: overlapping vault saves must never leave a half-written file
import { test as t2, expect as e2 } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join as j } from 'node:path'
import { tmpdir } from 'node:os'
import { queuedWriter } from '../src/core/atomic'
t2('queued atomic writes never interleave', async () => {
  const d = mkdtempSync(j(tmpdir(), 'astrala-w-')), p = j(d, 'vault.bin'), write = queuedWriter()
  await Promise.all(Array.from({ length: 40 }, (_, i) => write(p, JSON.stringify({ n: i, pad: 'x'.repeat(20000 + i * 997) }))))
  e2(JSON.parse(readFileSync(p, 'utf8')).n).toBe(39)
  e2(readdirSync(d)).toEqual(['vault.bin']) // no temp files left behind
})
