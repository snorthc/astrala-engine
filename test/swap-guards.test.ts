import { describe, it, expect } from 'vitest'
import { checkThorMemo, lifiPaysTo, LIFI_DIAMOND } from '../src/core/swap'

// Memo shapes THORChain and Maya return (public example addresses)
const EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', SOL = 'So11111111111111111111111111111111111111112'
const ATTACKER = '0x000000000000000000000000000000000000dEaD'

describe('THORChain / Maya memo check', () => {
  it('passes the memos the protocols really send', () => {
    expect(checkThorMemo(`=:b:${BTC}/${EVM}:279638/1/0`, BTC, EVM, 270000n)).toBeNull()
    expect(checkThorMemo(`=:e:${EVM}:34757253`, EVM, undefined, 34000000n)).toBeNull()
    expect(checkThorMemo(`=:e:${EVM.toLowerCase()}:34757253`, EVM, BTC, 1n)).toBeNull()
    expect(checkThorMemo(`=:o:${SOL}/${EVM}:234845507/0/3`, SOL, EVM, 1n)).toBeNull()
    expect(checkThorMemo(`=:ETH.USDC:${EVM}/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t:19710755955/1/0`, EVM, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 1n)).toBeNull()
  })
  it('refuses a memo that pays someone else', () => {
    expect(checkThorMemo(`=:e:${ATTACKER}:34757253`, EVM, undefined, 1n)).toMatch(/not yours/)
    expect(checkThorMemo(`=:b:${BTC}/${ATTACKER}:279638`, BTC, EVM, 1n)).toMatch(/refunds/)
    expect(checkThorMemo(`=:o:${SOL.toLowerCase()}:1`, SOL, undefined, 1n)).toMatch(/not yours/) // base58 is case-sensitive
  })
  it('refuses a missing price limit, an affiliate cut or junk', () => {
    expect(checkThorMemo(`=:e:${EVM}:0`, EVM, undefined, 0n)).toMatch(/limit/)
    expect(checkThorMemo(`=:e:${EVM}:100`, EVM, undefined, 34000000n)).toMatch(/limit/)
    expect(checkThorMemo(`=:e:${EVM}:34757253:thief:500`, EVM, undefined, 1n)).toMatch(/affiliate/)
    expect(checkThorMemo(`=:e:${EVM}:34757253:none:0`, EVM, undefined, 1n)).toBeNull()
    expect(checkThorMemo(`+:ETH.ETH:${EVM}`, EVM, undefined, 1n)).toMatch(/not a swap/)
    expect(checkThorMemo('', EVM, undefined, 1n)).toMatch(/not a swap/)
  })
})

describe('LI.FI payout check', () => {
  const pad = (a: string) => a.slice(2).toLowerCase().padStart(64, '0')
  it('finds the user address in the calldata', () => {
    expect(lifiPaysTo(`0xa3443faa${pad(EVM)}`, EVM, 'evm')).toBe(true)
    expect(lifiPaysTo(`0xa3443faa${pad(ATTACKER)}`, EVM, 'evm')).toBe(false)
  })
  it('finds a Solana payout as raw bytes, and never vouches for other chains', () => {
    expect(lifiPaysTo('0x' + '43' + '1'.repeat(64), SOL, 'sol')).toBe(false)
    expect(lifiPaysTo(`0x${'00'.repeat(4)}`, BTC, 'btc')).toBe(false)
  })
  it('pins the LI.FI contract', () => { expect(LIFI_DIAMOND).toBe('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE') })
})
