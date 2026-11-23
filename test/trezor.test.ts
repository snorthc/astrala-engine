// Trezor sends without a Trezor: a pretend device behind the USB transport speaks the real message flow (Initialize,
// ButtonRequest, SignTx/TxRequest/TxAck, EthereumSignTxEIP1559, SolanaSignTx) and signs with a software key.
// It checks what the wallet tells it the way the firmware does. No device, no network, nothing broadcast.
import { describe, expect, it, vi } from 'vitest'
import * as btc from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { serializeTransaction, recoverTransactionAddress, keccak256 } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'

const dev = vi.hoisted(() => ({ log: [] as string[], btcKey: null as null | { priv: Uint8Array; pub: Uint8Array }, evmPriv: '' as `0x${string}`, solKey: null as null | Uint8Array }))

// ---- the pretend Trezor
vi.mock('@trezor/transport', () => {
  class NodeUsbTransport {
    queue: { type: string; message: any }[] = []
    tx: any = null
    async init() { return { success: true } }
    async enumerate() { return { success: true, payload: [{ path: '1', session: null }] } }
    async acquire() { return { success: true, payload: 's1' } }
    async release() { return { success: true } }
    async call({ name, data }: { name: string; data: any }) {
      dev.log.push(name)
      const ok = (type: string, message: any = {}) => ({ success: true, payload: { type, message } })
      if (name === 'Initialize') return ok('Features', { initialized: true, model: 'T', capabilities: ['Capability_Bitcoin', 'Capability_PassphraseEntry'] })
      if (name === 'ButtonAck') { const next = this.queue.shift(); return next ? ok(next.type, next.message) : ok('Success') }
      if (name === 'SignTx') { this.step = 0; this.tx = { n: data.inputs_count, m: data.outputs_count, version: data.version, lock: data.lock_time, inputs: [], outputs: [], prevs: {} as Record<string, any> }; return this.press(this.nextBtc()) }
      if (name === 'TxAck') { this.takeBtc(data.tx); return ok('TxRequest', this.nextBtc()) }
      if (name === 'EthereumSignTxEIP1559') return this.press(await this.signEvm(data))
      if (name === 'SolanaSignTx') return ok('SolanaTxSignature', { signature: bytesToHex(ed25519.sign(hexToBytes(data.serialized_tx), dev.solKey!)) })
      return ok('Failure', { code: 'Failure_UnexpectedMessage', message: name })
    }
    // a button press first, like the device asking you to confirm
    after: { type: string; message: any } | null = null
    press(next: any) { this.after = { type: next?.signature_r ? 'EthereumTxRequest' : 'TxRequest', message: next }; this.queue.push(this.after); return { success: true, payload: { type: 'ButtonRequest', message: { code: 'ButtonRequest_ConfirmOutput' } } } }
    // ---- Bitcoin, in the firmware's order: every input, every output, then each previous transaction in full
    step = 0; pending: any = null
    nextBtc(): any {
      const t = this.tx
      const plan: any[] = []
      for (let i = 0; i < t.n; i++) plan.push({ request_type: 'TXINPUT', details: { request_index: i } })
      for (let i = 0; i < t.m; i++) plan.push({ request_type: 'TXOUTPUT', details: { request_index: i } })
      const hashes = [...new Set(t.inputs.map((x: any) => x.prev_hash))] as string[]
      if (this.step >= t.n + t.m) for (const h of hashes) {
        const p = t.prevs[h] ?? (t.prevs[h] = { inputs: [], outputs: [] })
        plan.push({ request_type: 'TXMETA', details: { tx_hash: h } })
        for (let j = 0; j < (p.meta?.inputs_cnt ?? 0); j++) plan.push({ request_type: 'TXINPUT', details: { tx_hash: h, request_index: j } })
        for (let j = 0; j < (p.meta?.outputs_cnt ?? 0); j++) plan.push({ request_type: 'TXOUTPUT', details: { tx_hash: h, request_index: j } })
      }
      const r = plan[this.step]
      if (r) { this.pending = r; this.step++; return r }
      return { request_type: 'TXFINISHED', serialized: { serialized_tx: this.signBtc() } }
    }
    takeBtc(ack: any) {
      const r = this.pending, t = this.tx, h = r.details.tx_hash
      if (!h && r.request_type === 'TXINPUT') t.inputs[r.details.request_index] = ack.inputs[0]
      else if (!h) t.outputs[r.details.request_index] = ack.outputs[0]
      else if (r.request_type === 'TXMETA') t.prevs[h].meta = ack
      else if (r.request_type === 'TXINPUT') t.prevs[h].inputs[r.details.request_index] = ack.inputs[0]
      else t.prevs[h].outputs[r.details.request_index] = ack.bin_outputs[0]
    }
    signBtc() {
      const t = this.tx, key = dev.btcKey!
      // like the firmware: each previous transaction must hash to the id it was asked about, and the amounts must agree
      for (const inp of t.inputs) {
        const p = t.prevs[inp.prev_hash]
        const raw = btc.RawTx.encode({ version: p.meta.version, segwitFlag: false, inputs: p.inputs.map((x: any) => ({ txid: hexToBytes(x.prev_hash), index: x.prev_index, finalScriptSig: hexToBytes(x.script_sig), sequence: x.sequence })), outputs: p.outputs.map((o: any) => ({ amount: BigInt(o.amount), script: hexToBytes(o.script_pubkey) })), witnesses: [], lockTime: p.meta.lock_time })
        const id = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true, disableScriptCheck: true }).id
        if (id !== inp.prev_hash) throw new Error('previous transaction does not match its hash')
        if (BigInt(p.outputs[inp.prev_index].amount) !== BigInt(inp.amount)) throw new Error('input amount does not match')
      }
      const tx = new btc.Transaction({ version: t.version, lockTime: t.lock })
      for (const inp of t.inputs) tx.addInput({ txid: inp.prev_hash, index: inp.prev_index, sequence: inp.sequence, witnessUtxo: { script: btc.p2wpkh(key.pub).script, amount: BigInt(inp.amount) } })
      for (const o of t.outputs) tx.addOutputAddress(o.address, BigInt(o.amount))
      tx.sign(key.priv); tx.finalize()
      return tx.hex
    }
    // ---- Ethereum: rebuild the transaction from the fields, the way the firmware RLP-encodes them (bytes as given)
    signEvm(d: any) {
      const n = (h: string) => { if (h.length % 2 || h.startsWith('00')) throw new Error(`non-canonical ${h}`); return h ? BigInt('0x' + h) : 0n }
      const tx = { chainId: d.chain_id, type: 'eip1559' as const, nonce: Number(n(d.nonce)), gas: n(d.gas_limit), maxFeePerGas: n(d.max_gas_fee), maxPriorityFeePerGas: n(d.max_priority_fee), to: d.to, value: n(d.value), data: (d.data_initial_chunk ? `0x${d.data_initial_chunk}` : undefined) as `0x${string}` | undefined }
      return sign({ hash: keccak256(serializeTransaction(tx)), privateKey: dev.evmPriv }).then((g) => ({ signature_r: g.r.slice(2), signature_s: g.s.slice(2), signature_v: g.yParity }))
    }
  }
  return { NodeUsbTransport }
})

// the Bitcoin explorer, played by this test
const web = vi.hoisted(() => ({ utxos: [] as unknown[], raw: {} as Record<string, string>, sent: [] as string[] }))
vi.mock('../src/core/chain', async (orig) => {
  const real = await orig<typeof import('../src/core/chain')>()
  const reply = (body: string, ok = true) => ({ ok, text: async () => body, json: async () => JSON.parse(body) })
  return {
    ...real,
    getJson: async (url: string) => (url.endsWith('/utxo') ? web.utxos : url.endsWith('/fees/recommended') ? { hourFee: 2, halfHourFee: 3, fastestFee: 5 } : {}),
    net: async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') { web.sent.push(init.body!); return reply(btc.Transaction.fromRaw(hexToBytes(init.body!)).id) }
      const id = url.match(/\/api\/tx\/([0-9a-f]{64})\/hex$/)?.[1]
      return id && web.raw[id] ? reply(web.raw[id]) : reply('not found', false)
    }
  }
})
const { _internal } = await import('../src/core/send')
const { ASSET } = await import('../src/core/assets')
const { trezorSigner } = await import('../src/main/trezor')

describe('Trezor: Bitcoin', () => {
  const key = HDKey.fromMasterSeed(new Uint8Array(32).fill(11)).derive("m/84'/0'/0'/0/0")
  dev.btcKey = { priv: key.privateKey!, pub: key.publicKey! }
  const from = btc.p2wpkh(key.publicKey!).address!
  const hw = trezorSigner({ vendor: 'trezor', account: 0, btc: { address: from, pubkey: bytesToHex(key.publicKey!) } })

  it('answers every request (inputs, outputs, previous transactions) and broadcasts only what it checked', async () => {
    // two coins from two earlier payments, so the device has to ask about both
    const funds = [40_000n, 25_000n].map((v, k) => {
      const f = new btc.Transaction(); f.addInput({ txid: new Uint8Array(32).fill(k + 2), index: k, sequence: 0xfffffffe }); f.addOutputAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 1000n); f.addOutputAddress(from, v)
      return { id: f.id, hex: bytesToHex(f.unsignedTx) }
    })
    web.utxos = funds.map((f, k) => ({ txid: f.id, vout: 1, value: [40_000, 25_000][k] }))
    web.raw = Object.fromEntries(funds.map((f) => [f.id, f.hex]))
    web.sent = []; dev.log.length = 0
    const to = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
    const r = await _internal.sendWithDevice(ASSET.btc, 'btc', { assetId: 'btc', to, amount: '0.0006', speed: 'normal' }, from, key.publicKey!, hw)
    expect(dev.log[0]).toBe('Initialize')
    expect(dev.log).toContain('ButtonAck') // it pressed through the device's confirmation
    expect(web.sent).toHaveLength(1)
    const out = btc.Transaction.fromRaw(hexToBytes(web.sent[0]))
    expect(r.txid).toBe(out.id)
    expect(out.inputsLength).toBe(2)
    // outputs are sorted (BIP-69): find the payment by address; the rest is change back to this account
    const outs = Array.from({ length: out.outputsLength }, (_, i) => out.getOutput(i)).map((o) => ({ to: btc.Address().encode(btc.OutScript.decode(o.script!)), amount: o.amount }))
    expect(outs.find((o) => o.to === to)?.amount).toBe(60_000n)
    expect(outs.every((o) => o.to === to || o.to === from)).toBe(true)
  })

  it('refuses a device whose signature is for something else', async () => {
    const f = new btc.Transaction(); f.addInput({ txid: new Uint8Array(32).fill(9), index: 0 }); f.addOutputAddress(from, 50_000n)
    web.utxos = [{ txid: f.id, vout: 0, value: 50_000 }]; web.raw = { [f.id]: bytesToHex(f.unsignedTx) }; web.sent = []
    const bad = { ...hw, btc: async (psbt: Uint8Array) => (await hw.btc!(psbt)).map(([i, s]) => { const g = s.signature.slice(); g[12] ^= 1; return [i, { ...s, signature: g }] as [number, typeof s] }) }
    await expect(_internal.sendWithDevice(ASSET.btc, 'btc', { assetId: 'btc', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: '0.0002', speed: 'normal' }, from, key.publicKey!, bad)).rejects.toThrow(/does not match|signature/i)
    expect(web.sent).toHaveLength(0)
  })
})

describe('Trezor: Ethereum and Solana', () => {
  it('EVM: sends the fields in canonical form (zero as no bytes) and the signature rebuilds a tx from this address', async () => {
    dev.evmPriv = `0x${'07'.repeat(32)}`
    const me = privateKeyToAccount(dev.evmPriv).address
    const hw = trezorSigner({ vendor: 'trezor', account: 0, evm: me })
    const tx = { chainId: 1, type: 'eip1559' as const, nonce: 0, gas: 21_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 0n, to: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F' as const, value: 0n }
    const signed = serializeTransaction(tx, await hw.evm!(serializeTransaction(tx)))
    expect(await recoverTransactionAddress({ serializedTransaction: signed })).toBe(me)
  })

  it('Solana: the device signs the message; the signature verifies on the transaction', async () => {
    const kp = Keypair.fromSeed(new Uint8Array(32).fill(4)); dev.solKey = kp.secretKey.slice(0, 32)
    const hw = trezorSigner({ vendor: 'trezor', account: 0, sol: kp.publicKey.toBase58() })
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 })
      .add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV'), lamports: 1000 }))
    tx.addSignature(kp.publicKey, Buffer.from(await hw.sol!(tx.serializeMessage())))
    expect(tx.verifySignatures()).toBe(true)
  })
})
