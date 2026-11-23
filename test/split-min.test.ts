import { describe, it, expect } from 'vitest'
import { minTotalFor } from '../src/core/minimums'

describe('minTotalFor', () => {
  it('scales a leg minimum up to the whole split, with headroom', () => {
    // THORChain: "at least 0.00289 ETH" on a leg holding 34% of a split with no fee taken.
    const t = minTotalFor('Amount is below the minimum for this route (at least 0.00289 ETH)', 34, 0)!
    expect(t).toBeCloseTo((0.00289 / 0.34) * 1.02, 8)
    expect(t * 0.34).toBeGreaterThan(0.00289) // the leg's share actually clears the minimum
  })

  it('accounts for the fee taken before routing', () => {
    const t = minTotalFor('at least 0.01 BTC', 50, 1500)! // 15% fee
    expect(t * 0.85 * 0.5).toBeGreaterThan(0.01)
  })

  it('returns null for errors that are not minimums', () => {
    expect(minTotalFor('No liquidity pool for this pair', 50, 0)).toBeNull()
    expect(minTotalFor('This chain is paused on the protocol right now', 50, 0)).toBeNull()
    expect(minTotalFor(undefined, 50, 0)).toBeNull()
    expect(minTotalFor('at least 0.01 ETH', 0, 0)).toBeNull() // no share yet
  })
})
