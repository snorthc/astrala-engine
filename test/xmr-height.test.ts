import { describe, it, expect } from 'vitest'
import { parseRestoreHeight, heightForDate, maxRestoreHeight, estimatedTip, dateAt, heightAt, REF_HEIGHT, REF_TIME } from '../src/core/xmr-height'

describe('restore height validation', () => {
  const max = 3_800_603
  it('accepts whole blocks from 0 to the tip, with separators', () => {
    expect(parseRestoreHeight('0', max)).toEqual({ ok: true, height: 0 })
    expect(parseRestoreHeight('3,797,752', max)).toEqual({ ok: true, height: 3_797_752 })
    expect(parseRestoreHeight(' 3 000 000 ', max)).toEqual({ ok: true, height: 3_000_000 })
    expect(parseRestoreHeight(max, max)).toEqual({ ok: true, height: max })
  })
  it('treats empty as the wallet default', () => {
    expect(parseRestoreHeight('', max)).toEqual({ ok: true, height: null })
    expect(parseRestoreHeight(null, max)).toEqual({ ok: true, height: null })
  })
  it.each([['-5'], ['12.5'], ['abc'], ['1e6'], ['0x10']])('rejects %s', (v) => expect(parseRestoreHeight(v, max).ok).toBe(false))
  it('rejects anything past the tip, saying where the tip is', () => {
    const r = parseRestoreHeight(max + 1, max)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('3,800,603')
    expect(parseRestoreHeight('99999999999999999999', max).ok).toBe(false)
  })
  it('uses the node tip when known, else the clock plus a day', () => {
    expect(maxRestoreHeight(3_801_000)).toBe(3_801_000)
    expect(maxRestoreHeight(0, REF_TIME)).toBe(REF_HEIGHT + 720)
    expect(maxRestoreHeight(undefined, REF_TIME + 86_400_000)).toBe(REF_HEIGHT + 720 * 2)
  })
})

describe('date → height', () => {
  const now = Date.UTC(2026, 10, 7)
  it('pads a day early, like the wallet birthday does', () => {
    expect(heightForDate('2026-10-31', now)).toBe(heightAt(Date.UTC(2026, 9, 31)))
    expect(heightForDate('2026-10-31', now)).toBeLessThan(REF_HEIGHT - 720)
  })
  it('stays before the real block for known dates', () => {
    // real block timestamps, read from a public node on 2026-10-31
    expect(heightForDate('2023-10-20', now)!).toBeLessThanOrEqual(3_000_000)
    expect(heightForDate('2021-11-24', now)!).toBeLessThanOrEqual(2_500_000)
    expect(heightForDate('2018-02-01', now)!).toBeLessThanOrEqual(1_500_000)
  })
  it('counts 60-second blocks before the 2016 fork, so early dates never land too late', () => {
    // the v2 fork (block time 60 s → 120 s) was block 1,009,827
    expect(heightForDate('2016-03-22', now)!).toBeLessThanOrEqual(1_009_827)
    const early = heightForDate('2015-03-01', now)!
    expect(early).toBeLessThan(heightAt(Date.UTC(2015, 2, 1)))
    expect(early).toBeGreaterThan(0)
    expect(heightForDate('2015-01-01', now)!).toBeLessThan(early)
    expect(heightForDate('2014-01-01', now)).toBe(0)
  })
  it('refuses future and malformed dates', () => {
    expect(heightForDate('2027-01-01', now)).toBeNull()
    expect(heightForDate('31/10/2026', now)).toBeNull()
    expect(heightForDate('', now)).toBeNull()
  })
  it('dateAt inverts the clock estimate', () => {
    expect(dateAt(REF_HEIGHT)).toBe(REF_TIME)
    expect(estimatedTip(dateAt(3_700_000))).toBe(3_700_000)
  })
})
