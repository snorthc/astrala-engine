import { describe, it, expect } from 'vitest'
import vectors from './slip39-vectors.json'
import { splitPhrase, joinShares } from '../src/core/shares'
// @ts-expect-error no types
import slip39 from 'slip39'
import { newMnemonic } from '../src/core/derive'

describe('SLIP-39 library matches the official Trezor test vectors', () => {
  for (const [name, mnemonics, secret] of vectors as [string, string[], string, string][]) {
    it(name, () => {
      if (secret) {
        const out = slip39.recoverSecret(mnemonics, 'TREZOR')
        expect(Buffer.from(out).toString('hex')).toBe(secret)
      } else {
        expect(() => slip39.recoverSecret(mnemonics, 'TREZOR')).toThrow()
      }
    })
  }
})

describe('Astrala split backup', () => {
  it('any 2 of 3 shares restore the exact 24 words', () => {
    const m = newMnemonic()
    const shares = splitPhrase(m)
    expect(shares).toHaveLength(3)
    for (const pair of [[0, 1], [0, 2], [1, 2]]) expect(joinShares(pair.map((i) => shares[i]))).toBe(m)
  })
  it('one share alone is not enough', () => {
    const shares = splitPhrase(newMnemonic())
    expect(() => joinShares([shares[0]])).toThrow()
  })
})
