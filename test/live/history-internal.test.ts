import { describe, expect, it } from 'vitest'
import { getTxHistory } from '../../src/core/history'

// ETH moved by a contract (exchange withdrawals, smart wallets) arrives as an internal transaction.
describe.runIf(process.env.LIVE)('ethereum history includes internal transfers', () => {
  it('finds incoming internal ETH for a busy address', async () => {
    const items = await getTxHistory({ evm: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' })
    const internal = items.filter((h) => h.id.includes(':internal:'))
    console.log('items', items.length, 'internal', internal.length)
    expect(internal.length).toBeGreaterThan(0)
  }, 90_000)
})
