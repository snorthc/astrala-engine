import { describe, it, expect } from 'vitest'
import * as btc from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { privateKeyToAccount } from 'viem/accounts'
import { Keypair } from '@solana/web3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { deriveAccount, signingKey, tronFromPub, moneroKeysFromSpend } from '../src/core/derive'

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
const LTC = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 }
const DOGE = { bech32: 'doge', pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e }

// The key used to sign must own the address the account shows. Checked for several accounts.
describe('signing keys match displayed addresses', () => {
  for (const acct of [0, 1, 2, 7]) {
    it(`account ${acct}`, () => {
      const a = Object.fromEntries(deriveAccount(M, acct).map((x) => [x.chain, x.address]))
      expect(btc.p2wpkh(signingKey(M, 'btc', acct).pub).address).toBe(a.btc)
      expect(btc.p2wpkh(signingKey(M, 'ltc', acct).pub, LTC).address).toBe(a.ltc)
      expect(btc.p2pkh(signingKey(M, 'doge', acct).pub, DOGE).address).toBe(a.doge)
      expect(privateKeyToAccount(`0x${bytesToHex(signingKey(M, 'evm', acct).priv)}`).address).toBe(a.evm)
      expect(Keypair.fromSeed(signingKey(M, 'sol', acct).priv).publicKey.toBase58()).toBe(a.sol)
      expect(tronFromPub(secp256k1.getPublicKey(signingKey(M, 'trx', acct).priv, false).slice(1))).toBe(a.trx)
      expect(moneroKeysFromSpend(signingKey(M, 'xmr', acct).priv).address).toBe(a.xmr)
    })
  }
})
