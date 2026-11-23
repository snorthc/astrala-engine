import { describe, it, expect } from 'vitest'
import { heightAt } from '../src/core/monero'

describe('monero restore height', () => {
  it('lands about a day before the reference block', () => {
    expect(heightAt(Date.UTC(2026, 9, 31, 8, 34))).toBe(3_795_997 - 720)
  })
  // Real block timestamps, read from a public node on 2026-10-31
  it.each([
    [3_000_000, Date.UTC(2023, 9, 20, 14, 49)],
    [2_500_000, Date.UTC(2021, 10, 24, 2, 24)],
    [1_500_000, Date.UTC(2018, 1, 1, 12, 49)]
  ])('never starts after block %i, and stays within a fortnight of it', (block, at) => {
    const h = heightAt(at)
    expect(h).toBeLessThanOrEqual(block)
    expect(block - h).toBeLessThan(720 * 14)
  })
})
