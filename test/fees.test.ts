import { describe, it, expect } from 'vitest'
import { FEES } from '../src/core/fees'
import { validateAddress } from '../src/core/send'

// the asset whose address format each family uses
const ASSET_OF: Record<string, string> = { evm: 'eth', btc: 'btc', ltc: 'ltc', doge: 'doge', sol: 'sol', trx: 'trx', xmr: 'xmr' }

describe('fee addresses in src/core/fees.ts', () => {
  const set = Object.entries(FEES.to).filter(([, a]) => a)
  it('are valid for their chain: a typo would send every fee into the void', () => {
    for (const [fam, addr] of set) expect(validateAddress(ASSET_OF[fam], addr as string), `${fam}: ${addr}`).toBe(true)
  })
  it('are only for chains Astrala knows', () => {
    for (const [fam] of set) expect(Object.keys(ASSET_OF)).toContain(fam)
  })
  it('are not the burn address left in from testing', () => {
    for (const [fam, addr] of set) expect((addr as string).toLowerCase(), fam).not.toBe('0x000000000000000000000000000000000000dead')
  })
  it('come with sane percentages', () => {
    for (const k of ['swapBps', 'splitBps'] as const) { expect(FEES[k]).toBeGreaterThanOrEqual(0); expect(FEES[k]).toBeLessThan(10_000) }
  })
})

describe('fee wallets from public keys', async () => {
  const { HDKey } = await import('@scure/bip32')
  const { seedOf, signingKey } = await import('../src/core/derive')
  const { feeAddressFrom, slotFor } = await import('../src/core/fee-wallets')
  const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const root = HDKey.fromMasterSeed(seedOf(M))
  const acct = (p: string) => root.derive(p).publicExtendedKey
  const w = { xpub: { btc: acct("m/84'/0'/0'"), ltc: acct("m/84'/2'/0'"), evm: acct("m/44'/60'/0'"), doge: acct("m/44'/3'/0'"), trx: acct("m/44'/195'/0'") }, fixed: { sol: 'So1Fixed', xmr: '' } }
  it('day 0 of the pool is the account\'s first address, matching the wallet itself', async () => {
    const { deriveAccount } = await import('../src/core/derive')
    const mine = Object.fromEntries(deriveAccount(M).map((a) => [a.chain, a.address]))
    const day0 = Date.UTC(2026, 0, 1) + 3600_000
    expect(feeAddressFrom(w, 'btc', day0)).toBe(mine.btc)
    expect(feeAddressFrom(w, 'ltc', day0)).toBe(mine.ltc)
    expect(feeAddressFrom(w, 'evm', day0)).toBe(mine.evm)
    void signingKey
  })
  it('rotates daily and wraps inside the pool so wallets still see it', () => {
    const d = (n: number) => Date.UTC(2026, 0, 1) + n * 86_400_000 + 1000
    expect(feeAddressFrom(w, 'btc', d(1))).not.toBe(feeAddressFrom(w, 'btc', d(2)))
    expect(feeAddressFrom(w, 'btc', d(3))).toBe(feeAddressFrom(w, 'btc', d(23)))
    expect(slotFor(d(45))).toBe(5)
    for (const fam of ['btc', 'ltc', 'evm', 'doge', 'trx'] as const) expect(validateAddress(ASSET_OF[fam], feeAddressFrom(w, fam, d(7))), fam).toBe(true)
  })
  it('uses fixed addresses for Solana and Monero, and nothing when unset', () => {
    expect(feeAddressFrom(w, 'sol')).toBe('So1Fixed')
    expect(feeAddressFrom(w, 'xmr')).toBe('')
    expect(feeAddressFrom({}, 'btc')).toBe('')
  })
  it('refuses a private key', () => {
    expect(() => feeAddressFrom({ xpub: { btc: root.derive("m/84'/0'/0'").privateExtendedKey } }, 'btc')).toThrow(/private key/)
  })
  it('the repo ships with no fee address in the code', () => {
    expect(Object.values(FEES.to).filter(Boolean)).toHaveLength(0)
  })
})

import { applyRemoteFees, FEE_CEILING } from '../src/core/fees'
describe('fee rates from HQ', () => {
  it('applies valid rates, clamps to the ceiling, and falls back to defaults', () => {
    const d = applyRemoteFees(null)
    expect(applyRemoteFees({ splitBps: 300 }).splitBps).toBe(300)
    expect(applyRemoteFees({ splitBps: 99_999, swapBps: -5 })).toMatchObject({ splitBps: FEE_CEILING.splitBps, swapBps: 0 })
    expect(applyRemoteFees({ routeBps: 'nope' }).routeBps).toBe(d.routeBps)
    expect(applyRemoteFees({})).toEqual(d)
  })
})
