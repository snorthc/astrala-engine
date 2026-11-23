import { describe, it, expect } from 'vitest'
import { checkAddress } from '../src/core/poison'

const real = '0x52908400098527886E0F7030069857D2E4169EE7'
const fake = '0x5290aBcDeF0123456789aBcDeF0123456969EE7'.padEnd(42, '0').slice(0, 38) + '9EE7'
describe('address poisoning', () => {
  const ctx = { book: [{ id: '1', name: 'Mira', address: real, family: 'evm', created: 0 }], activity: [] as any[], history: [{ id: 'h', asset: 'usdt-ethereum', network: 'ethereum', direction: 'in', amount: 0, counterparty: fake, txid: 't', time: 0, status: 'confirmed' }] as any[] }
  it('flags a lookalike of a saved contact', () => {
    const r = checkAddress(fake, ctx)
    expect(r.lookalike?.name).toBe('Mira')
    expect(r.dustOnly).toBe(true)
  })
  it('recognises the real contact, case-insensitively', () => {
    const r = checkAddress(real.toLowerCase(), ctx)
    expect(r.contact?.name).toBe('Mira')
    expect(r.lookalike).toBeUndefined()
  })
  it('stays quiet for an unrelated new address', () => {
    const r = checkAddress('0x1111111111111111111111111111111111111111', ctx)
    expect(r.lookalike).toBeUndefined()
    expect(r.sentBefore).toBe(0)
  })
})
