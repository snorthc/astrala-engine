import { describe, it, expect, afterEach } from 'vitest'
import { ASSETS, ASSET, registerTokens, tokenId, assetByContract, coingeckoIds } from '../src/core/assets'
import { addressKind } from '../src/core/tokens'

const pepe = { network: 'ethereum', contract: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE', name: 'Pepe', decimals: 18, cg: 'pepe', verified: true, added: 1 }
const bonk = { network: 'solana', contract: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'Bonk', name: 'Bonk', decimals: 5, verified: false, added: 2 }
const base = ASSETS.length

describe('custom token registry', () => {
  afterEach(() => registerTokens([]))
  it('adds, replaces and clears without touching built-ins', () => {
    registerTokens([pepe, bonk])
    expect(ASSETS.length).toBe(base + 2)
    const id = tokenId('ethereum', pepe.contract)
    expect(id).toBe('tok-ethereum-0x6982508145454ce325ddbe47a25d4ec3d2311933')
    expect(ASSET[id]).toMatchObject({ kind: 'token', decimals: 18, cg: 'pepe', custom: true })
    // unlisted tokens price by contract and stay out of the CoinGecko id list
    expect(ASSET[tokenId('solana', bonk.contract)].cg).toBe(`ct:solana:${bonk.contract}`)
    expect(coingeckoIds()).toContain('pepe')
    expect(coingeckoIds().some((c) => c.startsWith('ct:'))).toBe(false)
    registerTokens([bonk])
    expect(ASSET[id]).toBeUndefined()
    expect(ASSETS.length).toBe(base + 1)
    registerTokens([])
    expect(ASSETS.length).toBe(base)
  })
  it('never shadows a built-in token or a duplicate', () => {
    const usdc = { ...pepe, contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'FAKE' }
    expect(registerTokens([usdc, pepe, { ...pepe, contract: pepe.contract.toLowerCase() }]).length).toBe(1)
    expect(assetByContract('ethereum', usdc.contract)!.id).toBe('usdc-ethereum')
  })
  it('ignores networks that cannot hold tokens', () => {
    expect(registerTokens([{ ...pepe, network: 'bitcoin' }, { ...pepe, network: 'nope' }]).length).toBe(0)
  })
})

describe('address detection', () => {
  it('tells EVM, Tron and Solana apart', () => {
    expect(addressKind('0x6982508145454Ce325dDbE47a25d4ec3d2311933')).toBe('evm')
    expect(addressKind('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe('trx')
    expect(addressKind('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')).toBe('sol')
    expect(addressKind('pepe')).toBe(null)
    expect(addressKind('0x123')).toBe(null)
  })
})
