import { describe, it, expect } from 'vitest'
import { recoverTransactionAddress, parseTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import * as btc from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { deriveAccount, signingKey, tronFromPub } from '../src/core/derive'
import { validateAddress, _internal } from '../src/core/send'

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const addr = Object.fromEntries(deriveAccount(M).map((a) => [a.chain, a.address]))

describe('signing (offline, nothing broadcast)', () => {
  it('EVM EIP-1559 tx recovers to our address', async () => {
    const { priv } = signingKey(M, 'evm')
    const acct = privateKeyToAccount(`0x${bytesToHex(priv)}`)
    expect(acct.address).toBe(addr.evm)
    const signed = await acct.signTransaction({ chainId: 1, type: 'eip1559', nonce: 0, gas: 21000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, to: '0x000000000000000000000000000000000000dEaD', value: 1n })
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(addr.evm)
    expect(parseTransaction(signed).value).toBe(1n)
  })

  it('Solana transfer signature verifies', () => {
    const { priv } = signingKey(M, 'sol')
    const kp = Keypair.fromSeed(priv)
    expect(kp.publicKey.toBase58()).toBe(addr.sol)
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 })
      .add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey('11111111111111111111111111111112'), lamports: 1000 }))
    tx.sign(kp)
    expect(ed25519.verify(tx.signature!, tx.serializeMessage(), kp.publicKey.toBytes())).toBe(true)
  })

  for (const fam of ['btc', 'ltc', 'doge'] as const) {
    it(`${fam.toUpperCase()} tx builds, signs and finalizes`, () => {
      const { priv, pub } = signingKey(M, fam)
      const to = addr[fam]
      const utxos = [{ txid: 'aa'.repeat(32), vout: 0, value: 500_000_000 }, { txid: 'bb'.repeat(32), vout: 1, value: 20_000_000 }]
      const rate = fam === 'doge' ? 1000 : 5
      const sel = _internal.utxoSelect(fam, pub, addr[fam], utxos, to, 100_000_000n, false, rate)!
      expect(sel).toBeTruthy()
      sel.tx!.sign(priv)
      sel.tx!.finalize()
      const raw = btc.Transaction.fromRaw(hexToBytes(sel.tx!.hex), { allowUnknownOutputs: true })
      const outs = Array.from({ length: raw.outputsLength }, (_, i) => raw.getOutput(i).amount!)
      expect(outs).toContain(100_000_000n)
      const spent = sel.inputs!.reduce((a, i) => a + (i.witnessUtxo!.amount as bigint), 0n)
      const fee = spent - outs.reduce((a, b) => a + b, 0n)
      expect(fee).toBe(sel.fee)
      expect(Number(fee)).toBeGreaterThan(0)
      expect(Number(fee)).toBeLessThan(fam === 'doge' ? 2_000_000 : 5_000)
    })
    it(`${fam.toUpperCase()} send-max sweeps everything minus fee`, () => {
      const { pub } = signingKey(M, fam)
      const utxos = [{ txid: 'cc'.repeat(32), vout: 0, value: 300_000_000 }]
      const sel = _internal.utxoSelect(fam, pub, addr[fam], utxos, addr[fam], 0n, true, fam === 'doge' ? 1000 : 5)!
      expect(sel.tx!.outputsLength).toBe(1)
      expect(sel.tx!.getOutput(0).amount! + sel.fee!).toBe(300_000_000n)
    })
  }

  it('Tron signature recovers to our address', () => {
    const { priv } = signingKey(M, 'trx')
    const raw = '0a02abcd2208deadbeefcafebabe40c0843d5a65080112610a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e7472616374'
    const txID = bytesToHex(sha256(hexToBytes(raw)))
    const sig = hexToBytes(_internal.tronSign(txID, raw, priv.slice()))
    const rec = sig[64] - 27
    const pub = secp256k1.Signature.fromBytes(new Uint8Array([rec, ...sig.slice(0, 64)]), 'recovered').recoverPublicKey(hexToBytes(txID)).toBytes(false)
    expect(tronFromPub(pub.slice(1))).toBe(addr.trx)
  })
  it('Tron refuses a txID that does not match the raw data', () => {
    expect(() => _internal.tronSign('00'.repeat(32), 'abcd', new Uint8Array(32).fill(1))).toThrow()
  })
})

describe('address validation', () => {
  const cases: [string, string, boolean][] = [
    ['eth', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', true],
    ['usdc-base', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', true],
    ['eth', '0x9858EfFD232B4033E47d90003D41EC34EcaEda9', false],
    ['sol', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', true],
    ['sol', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', false],
    ['btc', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', true],
    ['btc', 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh', false],
    ['ltc', 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh', true],
    ['doge', 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', true],
    ['doge', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', false],
    ['trx', 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', true],
    ['usdt-tron', 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdx', false],
    ['xmr', '4AX6hSULkesCJAwNUz6Vsi4C5BzYoBssv8fM6rEUNdzYUMQb93TV3nu6UHMnEQLiPjZFHs8D94iLf3FVKgQFpDmFHW8UcqJ', true],
    ['xmr', '4AX6hSULkesCJAwNUz6Vsi4C5BzYoBssv8fM6rEUNdzYUMQb93TV3nu6UHMnEQLiPjZFHs8D94iLf3FVKgQFpDmFHW8UcqK', false]
  ]
  for (const [asset, a, ok] of cases) it(`${asset} ${a.slice(0, 10)}… → ${ok}`, () => expect(validateAddress(asset, a)).toBe(ok))
})
