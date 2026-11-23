// Ledger sends without a Ledger: each test builds exactly what the device would be handed, lets a software key
// play the device, and checks the wallet's half (what it sends the device, and how it puts the answer back).
// No device, no network, nothing broadcast.
import { describe, expect, it, vi } from 'vitest'
import * as btc from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { serializeTransaction, recoverTransactionAddress, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { PsbtV2 } from 'ledger-bitcoin'

// the Bitcoin explorer, played by this test
const web = vi.hoisted(() => ({ utxos: [] as unknown[], raw: {} as Record<string, string>, sent: [] as string[], fee: 3 }))
vi.mock('../src/core/chain', async (orig) => {
  const real = await orig<typeof import('../src/core/chain')>()
  const reply = (body: string, ok = true) => ({ ok, text: async () => body, json: async () => JSON.parse(body) })
  return {
    ...real,
    getJson: async (url: string) => (url.endsWith('/utxo') ? web.utxos : url.endsWith('/fees/recommended') ? { hourFee: 2, halfHourFee: web.fee, fastestFee: 5 } : {}),
    net: async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') { web.sent.push(init.body!); return reply(btc.Transaction.fromRaw(hexToBytes(init.body!)).id) }
      const id = url.match(/\/api\/tx\/([0-9a-f]{64})\/hex$/)?.[1]
      return id && web.raw[id] ? reply(web.raw[id]) : reply('not found', false)
    }
  }
})
const { _internal } = await import('../src/core/send')
const { ASSET } = await import('../src/core/assets')

describe('Ledger: Bitcoin', () => {
  // the "device": an account key at Ledger Live's path, 84'/0'/0'
  const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(7))
  const acct = root.derive("m/84'/0'/0'"), key = acct.deriveChild(0).deriveChild(0)
  const fingerprint = root.fingerprint
  const from = btc.p2wpkh(key.publicKey!).address!

  it('hands the Bitcoin app a PSBT it can read (previous tx + key origin) and finalizes with its signatures', async () => {
    // a coin for this address, in a transaction the explorer can show in full
    const fund = new btc.Transaction({ allowUnknownOutputs: true })
    fund.addInput({ txid: new Uint8Array(32).fill(1), index: 0 })
    fund.addOutputAddress(from, 50_000n)
    const fundHex = bytesToHex(fund.unsignedTx), fundId = fund.id
    web.utxos = [{ txid: fundId, vout: 0, value: 50_000 }]
    web.raw = { [fundId]: fundHex }
    web.sent = []

    let seenByDevice: { inputs: number; origin?: { readonly masterFingerprint: Buffer; readonly path: readonly number[] }; prevTx?: Buffer } = { inputs: 0 }
    const hw = {
      btcOrigin: { pubkey: key.publicKey!, fingerprint, path: "m/84'/0'/0'/0/0" },
      btc: async (psbt: Uint8Array) => {
        // what ledger-bitcoin itself does first: parse it as Ledger's PsbtV2
        const p = new PsbtV2(); p.deserialize(Buffer.from(psbt))
        seenByDevice = { inputs: p.getGlobalInputCount(), origin: p.getInputBip32Derivation(0, Buffer.from(key.publicKey!)), prevTx: p.getInputNonWitnessUtxo(0) }
        // then sign the way the device does (SIGHASH_ALL), returning [input, { pubkey, signature }]
        const t = btc.Transaction.fromPSBT(psbt)
        t.signIdx(key.privateKey!, 0)
        const [[pub, sig]] = t.getInput(0).partialSig!
        return [[0, { pubkey: pub, signature: sig }]] as [number, { pubkey: Uint8Array; signature: Uint8Array }][]
      }
    }
    const to = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
    const r = await _internal.sendWithDevice(ASSET.btc, 'btc', { assetId: 'btc', to, amount: '0.0002', speed: 'normal' }, from, key.publicKey!, hw)

    expect(seenByDevice.inputs).toBe(1)
    expect(bytesToHex(seenByDevice.prevTx!)).toBe(fundHex) // the whole previous transaction went to the device
    // with this key's origin: the fingerprint and path the Bitcoin app matches against the wallet policy
    expect(seenByDevice.origin?.masterFingerprint.readUInt32BE(0)).toBe(fingerprint)
    expect(seenByDevice.origin?.path).toEqual(btc.bip32Path("m/84'/0'/0'/0/0"))
    expect(web.sent).toHaveLength(1)
    const out = btc.Transaction.fromRaw(hexToBytes(web.sent[0]))
    expect(r.txid).toBe(out.id)
    expect(btc.Address().encode(btc.OutScript.decode(out.getOutput(0).script!))).toBe(to)
    expect(out.getOutput(0).amount).toBe(20_000n)
  })

  it('never hands the device a previous transaction that is not the coin being spent', async () => {
    const keep = { utxos: web.utxos, raw: web.raw }
    const real = new btc.Transaction({ allowUnknownOutputs: true }); real.addInput({ txid: new Uint8Array(32).fill(5), index: 0 }); real.addOutputAddress(from, 50_000n)
    const fake = new btc.Transaction({ allowUnknownOutputs: true }); fake.addInput({ txid: new Uint8Array(32).fill(6), index: 0 }); fake.addOutputAddress(from, 50_000n)
    web.utxos = [{ txid: real.id, vout: 0, value: 50_000 }]
    web.raw = { [real.id]: bytesToHex(fake.unsignedTx) } // the explorer lies about what the coin came from
    web.sent = []
    let asked = false
    const hw = { btcOrigin: { pubkey: key.publicKey!, fingerprint, path: "m/84'/0'/0'/0/0" }, btc: async () => { asked = true; return [] } }
    await expect(_internal.sendWithDevice(ASSET.btc, 'btc', { assetId: 'btc', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: '0.0002', speed: 'normal' }, from, key.publicKey!, hw)).rejects.toThrow(/doesn’t match/)
    expect(asked).toBe(false)
    expect(web.sent).toHaveLength(0)
    Object.assign(web, keep)
  })

  it('refuses an absurd fee rate from the explorer', async () => {
    web.fee = 5000
    const hw = { btcOrigin: { pubkey: key.publicKey!, fingerprint, path: "m/84'/0'/0'/0/0" }, btc: async () => [] }
    await expect(_internal.sendWithDevice(ASSET.btc, 'btc', { assetId: 'btc', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: '0.0002', speed: 'normal' }, from, key.publicKey!, hw)).rejects.toThrow(/looks wrong/)
    web.fee = 3
  })

  it('refuses a device that signed only part of the transaction', async () => {
    const hw = { btcOrigin: { pubkey: key.publicKey!, fingerprint, path: "m/84'/0'/0'/0/0" }, btc: async () => [] }
    web.sent = []
    await expect(_internal.sendWithDevice(ASSET.btc, 'btc', { assetId: 'btc', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: '0.0002', speed: 'normal' }, from, key.publicKey!, hw)).rejects.toThrow(/every input/)
    expect(web.sent).toHaveLength(0)
  })
})

describe('Ledger: Ethereum and Solana signatures go back on the right transaction', () => {
  it('EVM: the device signs the unsigned EIP-1559 bytes; r, s and parity rebuild a tx from that address', async () => {
    const priv = new Uint8Array(32).fill(9)
    const me = privateKeyToAccount(`0x${bytesToHex(priv)}`).address
    const tx = { chainId: 8453, type: 'eip1559' as const, nonce: 4, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, to: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F' as const, value: 10n ** 15n }
    const unsigned = serializeTransaction(tx)
    // the device signs keccak256 of what it was sent and returns v as 00/01 (here: what main/ledger.ts turns it into)
    const s = secp256k1.sign(keccak_256(hexToBytes(unsigned.slice(2))), priv, { prehash: false, format: 'recovered' })
    const sig = { r: `0x${bytesToHex(s.slice(1, 33))}` as `0x${string}`, s: `0x${bytesToHex(s.slice(33))}` as `0x${string}`, yParity: s[0] }
    const signed = serializeTransaction(tx, sig)
    expect(await recoverTransactionAddress({ serializedTransaction: signed })).toBe(me)
    expect(keccak256(unsigned)).not.toBe(keccak256(signed))
  })

  it('Solana: the device signs the message; the signature verifies on the transaction', () => {
    const kp = Keypair.fromSeed(new Uint8Array(32).fill(3))
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 })
      .add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV'), lamports: 1000 }))
    const sig = ed25519.sign(tx.serializeMessage(), kp.secretKey.slice(0, 32))
    tx.addSignature(kp.publicKey, Buffer.from(sig))
    expect(tx.verifySignatures()).toBe(true)
  })
})
