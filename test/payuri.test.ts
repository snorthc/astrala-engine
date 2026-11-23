import { describe, it, expect } from 'vitest'
import { buildPayUri, parsePayUri, payText, plainDecimal, toAtomic, fromAtomic, formatAmount } from '../src/core/payuri'

const BTC = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const LTC = 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'
const DOGE = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'
const XMR = '4AX6hSULkesCJAwNUz6Vsi4C5BzYoBssv8fM6rEUNdzYUMQb93TV3nu6UHMnEQLiPjZFHs8D94iLf3FVKgQFpDmFHW8UcqJ'
const EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const TRX = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'

describe('exact amounts', () => {
  it.each([
    [0.1 + 0.2, '0.3'],
    [1e-7, '0.0000001'],
    [1.5e-12, '0.0000000000015'],
    [21e6, '21000000'],
    [1e21, '1000000000000000000000'],
    [0.000615384615384615, '0.000615384615384615'],
    ['0.010', '0.01'],
    ['00012.5000', '12.5'],
    ['.5', '0.5'],
    ['2.014e18', '2014000000000000000'],
    ['1E-8', '0.00000001'],
    [0, '0']
  ])('plainDecimal(%s) → %s', (v, out) => expect(plainDecimal(v as any)).toBe(out))

  it.each([['-1'], ['1,5'], ['abc'], [''], ['1.2.3'], [NaN], [-0.5], [Infinity]])('rejects %s', (v) => expect(plainDecimal(v as any)).toBeNull())

  it('rounds half-up to the coin precision and never loses digits', () => {
    expect(toAtomic('0.123456785', 8)).toBe(12345679n)
    expect(toAtomic('0.123456784', 8)).toBe(12345678n)
    expect(toAtomic('1.000000000000000001', 18)).toBe(1000000000000000001n)
    expect(toAtomic(0.1 + 0.2, 18)).toBe(300000000000000000n)
    expect(fromAtomic(1500000n, 8)).toBe('0.015')
    expect(fromAtomic(100000000n, 8)).toBe('1')
    expect(fromAtomic('7', 6)).toBe('0.000007')
    expect(fromAtomic(42n, 0)).toBe('42')
  })

  it('formats nothing for no amount, zero, dust below precision or junk', () => {
    expect(formatAmount(undefined, 8)).toBe('')
    expect(formatAmount(0, 8)).toBe('')
    expect(formatAmount('0.000000001', 8)).toBe('')
    expect(formatAmount('nope', 8)).toBe('')
    expect(formatAmount(50 / 81250, 8)).toBe('0.00061538')
  })
})

describe('buildPayUri', () => {
  it('BIP-21 for Bitcoin, Litecoin and Dogecoin', () => {
    expect(buildPayUri({ assetId: 'btc', address: BTC })).toBe(`bitcoin:${BTC}`)
    expect(buildPayUri({ assetId: 'btc', address: BTC, amount: 0.01 })).toBe(`bitcoin:${BTC}?amount=0.01`)
    expect(buildPayUri({ assetId: 'btc', address: BTC, amount: 1e-7, note: 'Dinner & drinks' })).toBe(`bitcoin:${BTC}?amount=0.0000001&message=Dinner%20%26%20drinks`)
    expect(buildPayUri({ assetId: 'ltc', address: LTC, amount: '2.5' })).toBe(`litecoin:${LTC}?amount=2.5`)
    expect(buildPayUri({ assetId: 'doge', address: DOGE, amount: 420 })).toBe(`dogecoin:${DOGE}?amount=420`)
  })

  it('Monero uses tx_amount and tx_description', () => {
    expect(buildPayUri({ assetId: 'xmr', address: XMR })).toBe(`monero:${XMR}`)
    expect(buildPayUri({ assetId: 'xmr', address: XMR, amount: 0.5, note: 'Rent' })).toBe(`monero:${XMR}?tx_amount=0.5&tx_description=Rent`)
    expect(buildPayUri({ assetId: 'xmr', address: XMR, amount: '0.0000000000015' })).toBe(`monero:${XMR}?tx_amount=0.000000000002`) // 12 decimals, rounded
  })

  it('EIP-681 for ETH and every EVM chain, value in wei', () => {
    expect(buildPayUri({ assetId: 'eth', address: EVM })).toBe(`ethereum:${EVM}@1`)
    expect(buildPayUri({ assetId: 'eth', address: EVM, amount: 0.1 + 0.2 })).toBe(`ethereum:${EVM}@1?value=300000000000000000`)
    expect(buildPayUri({ assetId: 'eth-base', address: EVM, amount: 1 })).toBe(`ethereum:${EVM}@8453?value=1000000000000000000`)
    expect(buildPayUri({ assetId: 'bnb', address: EVM, amount: '0.000000000000000001' })).toBe(`ethereum:${EVM}@56?value=1`)
    expect(buildPayUri({ assetId: 'pol', address: EVM, note: 'ignored, EIP-681 has no memo' })).toBe(`ethereum:${EVM}@137`)
  })

  it('ERC-20 is a transfer call on the token contract, in atomic units', () => {
    expect(buildPayUri({ assetId: 'usdc-ethereum', address: EVM, amount: 25.5 }))
      .toBe(`ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1/transfer?address=${EVM}&uint256=25500000`)
    expect(buildPayUri({ assetId: 'usdt-bsc', address: EVM, amount: '1' })) // 18-decimal USDT on BNB Chain
      .toBe(`ethereum:0x55d398326f99059fF775485246999027B3197955@56/transfer?address=${EVM}&uint256=1000000000000000000`)
    expect(buildPayUri({ assetId: 'usdc-arbitrum', address: EVM }))
      .toBe(`ethereum:0xaf88d065e77c8cC2239327C5EDb3A432268e5831@42161/transfer?address=${EVM}`)
  })

  it('Solana Pay, with spl-token for tokens', () => {
    expect(buildPayUri({ assetId: 'sol', address: SOL })).toBe(`solana:${SOL}`)
    expect(buildPayUri({ assetId: 'sol', address: SOL, amount: 1.5, note: 'Thanks' })).toBe(`solana:${SOL}?amount=1.5&message=Thanks`)
    expect(buildPayUri({ assetId: 'usdc-solana', address: SOL, amount: 10 })).toBe(`solana:${SOL}?amount=10&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)
    expect(buildPayUri({ assetId: 'usdt-solana', address: SOL })).toBe(`solana:${SOL}?spl-token=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`)
  })

  it('Tron, with the token contract for TRC-20', () => {
    expect(buildPayUri({ assetId: 'trx', address: TRX, amount: 100 })).toBe(`tron:${TRX}?amount=100`)
    expect(buildPayUri({ assetId: 'usdt-tron', address: TRX, amount: 150.25 })).toBe(`tron:${TRX}?amount=150.25&token=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`)
  })

  it('never writes exponent notation or float noise', () => {
    for (const v of [1e-7, 0.1 + 0.2, 1 / 3, 123456789.123456789, 5e-9])
      for (const id of ['btc', 'eth', 'xmr', 'sol', 'usdt-tron', 'usdc-ethereum']) {
        const u = buildPayUri({ assetId: id, address: id === 'xmr' ? XMR : EVM, amount: v })
        const amt = /[?&](?:amount|tx_amount|value|uint256)=([^&]*)/.exec(u)?.[1]
        if (amt !== undefined) expect(amt).toMatch(/^\d+(\.\d+)?$/) // plain digits: no exponent
        expect(amt ?? '').not.toMatch(/0000000000004|9999999999/)
      }
  })

  it('refuses unknown assets and empty addresses', () => {
    expect(() => buildPayUri({ assetId: 'nope', address: BTC })).toThrow()
    expect(() => buildPayUri({ assetId: 'btc', address: '  ' })).toThrow()
  })
})

describe('payText', () => {
  it('reads like a message', () => {
    expect(payText({ assetId: 'btc', address: BTC, amount: 0.01 })).toBe(`Pay 0.01 BTC to ${BTC}: bitcoin:${BTC}?amount=0.01`)
    expect(payText({ assetId: 'usdt-tron', address: TRX, amount: 150, note: 'Invoice 12' })).toBe(`Pay 150 USDT on Tron to ${TRX} for “Invoice 12”: tron:${TRX}?amount=150&token=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`)
    expect(payText({ assetId: 'eth-arbitrum', address: EVM })).toBe(`Pay ETH on Arbitrum to ${EVM}: ethereum:${EVM}@42161`)
    expect(payText({ assetId: 'bnb', address: EVM, amount: 1 })).toMatch(/^Pay 1 BNB to /)
  })
})

describe('parsePayUri', () => {
  it('round-trips everything it builds', () => {
    const cases: [string, string, string | undefined, string | undefined][] = [
      ['btc', BTC, '0.0000001', 'Dinner & drinks'], ['ltc', LTC, '2.5', undefined], ['doge', DOGE, undefined, undefined],
      ['xmr', XMR, '0.5', 'Rent'], ['eth', EVM, '0.3', undefined], ['eth-base', EVM, '1', undefined], ['avax', EVM, '0.000000000000000001', undefined],
      ['usdc-ethereum', EVM, '25.5', undefined], ['usdt-bsc', EVM, '1', undefined], ['sol', SOL, '1.5', 'Thanks'],
      ['usdc-solana', SOL, '10', undefined], ['trx', TRX, '100', undefined], ['usdt-tron', TRX, '150.25', undefined]
    ]
    for (const [assetId, address, amount, note] of cases) {
      const p = parsePayUri(buildPayUri({ assetId, address, amount, note }))
      expect(p, assetId).not.toBeNull()
      expect(p!.assetId).toBe(assetId)
      expect(p!.address).toBe(address)
      expect(p!.amount).toBe(amount)
      if (!assetId.startsWith('eth') && !assetId.includes('ethereum') && !assetId.includes('bsc') && assetId !== 'avax') expect(p!.note).toBe(note)
    }
  })

  it('reads links from other wallets', () => {
    expect(parsePayUri(`BITCOIN:${BTC.toUpperCase()}?amount=1.2&label=Shop`)).toMatchObject({ assetId: 'btc', address: BTC.toUpperCase(), amount: '1.2', note: 'Shop' })
    expect(parsePayUri(`bitcoin://${BTC}?amount=0.5`)).toMatchObject({ address: BTC, amount: '0.5' })
    expect(parsePayUri(`ethereum:pay-${EVM}@10?value=2.014e18`)).toMatchObject({ assetId: 'eth-optimism', address: EVM, amount: '2.014', chainId: 10 })
    expect(parsePayUri(`ethereum:${EVM}`)).toMatchObject({ assetId: 'eth', chainId: 1, amount: undefined })
    expect(parsePayUri(`ethereum:${EVM}?amount=0.25`)).toMatchObject({ assetId: 'eth', amount: '0.25' })
    expect(parsePayUri(`solana:${SOL}?amount=0.01&memo=abc`)).toMatchObject({ assetId: 'sol', amount: '0.01', note: 'abc' })
    expect(parsePayUri(`monero:${XMR}?tx_amount=0.000000000001&recipient_name=Cafe`)).toMatchObject({ assetId: 'xmr', amount: '0.000000000001', note: 'Cafe' })
  })

  it('names unknown tokens as null but still gives the address', () => {
    expect(parsePayUri(`solana:${SOL}?amount=5&spl-token=So1aNa111111111111111111111111111111111111`)).toMatchObject({ assetId: null, address: SOL, amount: '5', token: 'So1aNa111111111111111111111111111111111111' })
    const erc = parsePayUri(`ethereum:0x1111111111111111111111111111111111111111@1/transfer?address=${EVM}&uint256=5`)
    expect(erc).toMatchObject({ assetId: null, address: EVM, amount: undefined })
  })

  it('ignores zero amounts', () => {
    expect(parsePayUri(`bitcoin:${BTC}?amount=0`)!.amount).toBeUndefined()
    expect(parsePayUri(`ethereum:${EVM}@1?value=0`)!.amount).toBeUndefined()
  })

  it('returns null for bare addresses and other links', () => {
    for (const t of [BTC, EVM, 'https://example.com', 'mailto:a@b.c', 'bitcoin:', `ethereum:${EVM}@1/approve?address=${EVM}&uint256=1`, `ethereum:0xabc@1/transfer?uint256=1`, 'lightning:lnbc1...']) expect(parsePayUri(t), t).toBeNull()
  })
})
