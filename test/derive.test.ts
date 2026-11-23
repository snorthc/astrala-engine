import { describe, it, expect } from 'vitest'
import { mnemonicToSeedSync } from '@scure/bip39'
import { hexToBytes } from '@noble/hashes/utils.js'
import { _internal, deriveAccount, isValidMnemonic, newMnemonic, moneroKeysFromSpend } from '../src/core/derive'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const seed = mnemonicToSeedSync(ABANDON)

describe('derivation (public test vectors)', () => {
  it('BTC BIP84 vector', () => {
    expect(_internal.segwitAddress(seed, 0, 'bc', 0).address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')
  })
  it('ETH vector (hardhat test mnemonic)', () => {
    const s = mnemonicToSeedSync('test test test test test test test test test test test junk')
    expect(_internal.ethAddress(s, 0).address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
  })
  it('SOL Phantom-path vector', () => {
    expect(_internal.solAddress(seed, 0).address).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')
  })
  it('LTC BIP84 vector', () => {
    expect(_internal.segwitAddress(seed, 2, 'ltc', 0).address).toBe('ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh')
  })
  it('XMR: keys -> address matches Monero reference', () => {
        const k = moneroKeysFromSpend(hexToBytes('77916d0cd56ed1920aef6ca56d8a41bac915b68e4c46a589e0956e27a7b77404'))
    // cross-checked against monero-ts (official Monero C++ compiled to wasm)
    expect(k.address).toBe('4AX6hSULkesCJAwNUz6Vsi4C5BzYoBssv8fM6rEUNdzYUMQb93TV3nu6UHMnEQLiPjZFHs8D94iLf3FVKgQFpDmFHW8UcqJ')
    expect(k.viewSec).toBe('24e12ae3ca29f89ec8cb9e81b4a2fe5c00f1eba2bdba1ce582897a272c943b03')
  })
  it('DOGE BIP44 vector', () => {
    expect(_internal.dogeAddress(seed, 0).address).toBe('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC')
  })
  it('TRX BIP44 vector', () => {
    expect(_internal.trxAddress(seed, 0).address).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')
  })
  it('24-word mnemonic generation + full account', () => {
    const m = newMnemonic()
    expect(m.split(' ')).toHaveLength(24)
    expect(isValidMnemonic(m)).toBe(true)
    const acct = deriveAccount(m)
    expect(acct.map((a) => a.chain)).toEqual(['xmr', 'evm', 'sol', 'ltc', 'btc', 'doge', 'trx'])
  })
})
