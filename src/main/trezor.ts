// Trezor over USB, built on Trezor's MIT-licensed transport and message definitions (@trezor/transport,
// @trezor/protobuf). Their all-in-one Trezor Connect isn't used: its licence forbids shipping it in another app.
// So the conversation with the device is written here, against the published message schema. Keys never leave
// the device; this file asks it for addresses and signatures, one conversation at a time.
import * as btc from '@scure/btc-signer'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { parseTransaction, type TransactionSerializableEIP1559 } from 'viem'
import type { HwAccount } from '../core/vault'
import type { HwSigner } from '../core/send'

export type TrezorChain = 'evm' | 'btc' | 'sol'
/** Trezor Suite's own paths, so a Trezor account here shows the same addresses as in Trezor Suite. */
export const trezorPath = (chain: TrezorChain, account: number) =>
  chain === 'evm' ? `m/44'/60'/0'/0/${account}` : chain === 'btc' ? `m/84'/0'/${account}'/0/0` : `m/44'/501'/${account}'/0'`

type Msg = { type: string; message: any }
type Res<T> = { success: true; payload: T } | { success: false; error: string; message?: string }
interface Transport {
  init(): Promise<Res<unknown>>
  enumerate(): Promise<Res<{ path: string; session: string | null }[]>>
  acquire(p: { input: { path: string; previous: string | null } }): Promise<Res<string>>
  release(p: { path: string; session: string }): Promise<Res<unknown>>
  call(p: { session: string; name: string; data: Record<string, unknown> }): Promise<Res<Msg>>
}

let transport: Promise<Transport> | null = null
/** Loaded on first use: the USB library is native, and the wallet shouldn't depend on it to start. */
function usb(): Promise<Transport> {
  return (transport ??= (async () => {
    const { NodeUsbTransport } = await import('@trezor/transport')
    const t = new NodeUsbTransport({ id: 'astrala' }) as unknown as Transport
    const r = await t.init()
    if (!r.success) { transport = null; throw new Error('Could not start USB for the Trezor') }
    return t
  })())
}

const FAILURE: Record<string, string> = {
  Failure_ActionCancelled: 'You declined it on your Trezor.',
  Failure_PinCancelled: 'The PIN was cancelled on your Trezor.',
  Failure_PinInvalid: 'Wrong PIN on your Trezor.',
  Failure_NotInitialized: 'This Trezor has no wallet on it yet. Set it up in Trezor Suite first.',
  Failure_UnexpectedMessage: "This Trezor's firmware can't do that yet. Update it in Trezor Suite, then try again.",
  Failure_DataError: 'Your Trezor refused the data it was sent.',
  Failure_ProcessError: 'Your Trezor could not finish this.'
}
const usbError = (e: string) => /unable to open|LIBUSB_ERROR_ACCESS|session|other call|busy/i.test(e)
  ? 'Your Trezor is in use by another app. Close Trezor Suite (and anything else using it), then try again.'
  : /not found|disconnected/i.test(e) ? 'No Trezor found. Plug it in and unlock it, then try again.' : `Trezor: ${e}`

let busy: Promise<unknown> = Promise.resolve()
/**
 * One conversation with the device: claim it, say hello (Initialize), run, let it go. Prompts the device makes
 * along the way are answered here: button presses and PIN on the device (ButtonAck), the passphrase on the device
 * when it can take one. A Trezor One types its PIN on the computer, which this doesn't do: it says so.
 */
function withTrezor<T>(fn: (ask: (name: string, data?: Record<string, unknown>) => Promise<Msg>, features: any) => Promise<T>): Promise<T> {
  const run = busy.then(async () => {
    const t = await usb()
    const list = await t.enumerate()
    if (!list.success) throw new Error(usbError(list.error))
    const dev = list.payload[0]
    if (!dev) throw new Error('No Trezor found. Plug it in and unlock it, then try again.')
    const got = await t.acquire({ input: { path: dev.path, previous: dev.session } })
    if (!got.success) throw new Error(usbError(got.error))
    const session = got.payload
    let onDevicePassphrase = false
    const ask = async (name: string, data: Record<string, unknown> = {}): Promise<Msg> => {
      let r = await t.call({ session, name, data })
      for (;;) {
        if (!r.success) throw new Error(usbError(r.error))
        const { type, message } = r.payload
        if (type === 'ButtonRequest') { r = await t.call({ session, name: 'ButtonAck', data: {} }); continue }
        if (type === 'PassphraseRequest') {
          // never answer for you: an empty passphrase would quietly open the standard wallet instead of your hidden one
          if (!onDevicePassphrase) { await t.call({ session, name: 'Cancel', data: {} }).catch(() => {}); throw new Error('This Trezor asks for a passphrase on the computer, which Astrala doesn’t do. Turn on passphrase entry on the device in Trezor Suite, or use a Model T or Safe.') }
          r = await t.call({ session, name: 'PassphraseAck', data: { on_device: true } }); continue
        }
        if (type === 'PinMatrixRequest') {
          await t.call({ session, name: 'Cancel', data: {} }).catch(() => {})
          throw new Error('This Trezor wants its PIN typed on the computer (Trezor One), which Astrala doesn’t do yet. A Trezor Model T or Safe works.')
        }
        if (type === 'Failure') throw new Error(FAILURE[message?.code] ?? `Trezor: ${message?.message ?? 'failed'}`)
        return { type, message }
      }
    }
    try {
      const f = (await ask('Initialize')).message
      if (f?.initialized === false) throw new Error(FAILURE.Failure_NotInitialized)
      onDevicePassphrase = (f?.capabilities ?? []).some((c: unknown) => c === 'Capability_PassphraseEntry' || c === 17)
      // a prompt nobody answers mustn't hold the device (and every later request) for ever
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([fn(ask, f), new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('Your Trezor didn’t answer in time, so nothing was sent. Try again.')), 180_000) })])
      } catch (e) {
        if (/in time/.test(String((e as Error)?.message))) await t.call({ session, name: 'Cancel', data: {} }).catch(() => {}) // clear the prompt off its screen
        throw e
      } finally { clearTimeout(timer) }
    } finally {
      await t.release({ path: dev.path, session }).catch(() => {})
    }
  })
  busy = run.catch(() => {})
  return run
}

export async function trezorStatus(): Promise<{ supported: boolean; connected: boolean; app?: string; error?: string }> {
  try {
    const t = await usb()
    const list = await t.enumerate()
    if (!list.success) return { supported: true, connected: false, error: usbError(list.error) }
    return { supported: true, connected: list.payload.length > 0 }
  } catch (e: any) { return { supported: false, connected: false, error: String(e?.message ?? e) } }
}

const path = (p: string) => btc.bip32Path(p)
/** Read one chain's address from the device (display: also show it there to compare). */
export function trezorRead(chain: TrezorChain, account: number, display = false): Promise<Partial<HwAccount>> {
  const p = path(trezorPath(chain, account))
  return withTrezor(async (ask) => {
    if (chain === 'evm') return { evm: (await ask('EthereumGetAddress', { address_n: p, show_display: display })).message.address }
    if (chain === 'sol') return { sol: (await ask('SolanaGetAddress', { address_n: p, show_display: display })).message.address }
    const address = (await ask('GetAddress', { address_n: p, coin_name: 'Bitcoin', script_type: 'SPENDWITNESS', show_display: display })).message.address
    const pubkey = (await ask('GetPublicKey', { address_n: p, coin_name: 'Bitcoin', script_type: 'SPENDWITNESS' })).message.node.public_key
    return { btc: { address, pubkey } }
  })
}

/** Big-endian bytes as the firmware wants them: no leading zeros, and zero as no bytes at all. */
const be = (n: bigint | number | undefined) => { const v = BigInt(n ?? 0); if (v === 0n) return ''; const h = v.toString(16); return h.length % 2 ? '0' + h : h }

/** Signers for core/send.ts: the device signs, the wallet builds, checks and broadcasts. */
export function trezorSigner(hw: HwAccount): HwSigner {
  const at = (c: TrezorChain) => path(trezorPath(c, hw.account))
  return {
    evm: (unsigned) => withTrezor(async (ask) => {
      const tx = parseTransaction(unsigned) as TransactionSerializableEIP1559
      const data = hexToBytes((tx.data ?? '0x').slice(2))
      let r = await ask('EthereumSignTxEIP1559', {
        address_n: at('evm'), chain_id: tx.chainId, nonce: be(tx.nonce), gas_limit: be(tx.gas), max_gas_fee: be(tx.maxFeePerGas), max_priority_fee: be(tx.maxPriorityFeePerGas),
        to: tx.to ?? '', value: be(tx.value), data_initial_chunk: bytesToHex(data.subarray(0, 1024)), data_length: data.length, access_list: []
      })
      let sent = Math.min(1024, data.length)
      // longer contract data goes in the chunk sizes the device asks for
      while (r.message?.data_length) { const n = r.message.data_length; r = await ask('EthereumTxAck', { data_chunk: bytesToHex(data.subarray(sent, sent + n)) }); sent += n }
      const m = r.message
      if (!m?.signature_r || !m?.signature_s) throw new Error('Your Trezor returned no signature')
      return { r: `0x${m.signature_r.padStart(64, '0')}` as `0x${string}`, s: `0x${m.signature_s.padStart(64, '0')}` as `0x${string}`, yParity: Number(m.signature_v) % 2 }
    }),
    sol: (message) => withTrezor(async (ask) => hexToBytes((await ask('SolanaSignTx', { address_n: at('sol'), serialized_tx: bytesToHex(message) })).message.signature)),
    /**
     * Bitcoin: the device asks for the transaction one piece at a time (its inputs and outputs, then each previous
     * transaction's), and is answered from the PSBT the wallet built. Only its signatures are kept: the wallet
     * checks each one and assembles the final transaction itself.
     */
    btc: (psbt) => withTrezor(async (ask) => {
      const tx = btc.Transaction.fromPSBT(psbt, { allowUnknownOutputs: true })
      // each input's previous transaction, as the PSBT carries it (decoded: txids in display order)
      type Prev = NonNullable<ReturnType<typeof tx.getInput>['nonWitnessUtxo']>
      const prevs = new Map<string, Prev>()
      for (let i = 0; i < tx.inputsLength; i++) {
        const inp = tx.getInput(i)
        if (!inp.nonWitnessUtxo) throw new Error('A previous transaction is missing')
        prevs.set(bytesToHex(inp.txid!), inp.nonWitnessUtxo)
      }
      const addr = btc.Address(btc.NETWORK)
      let req = await ask('SignTx', { inputs_count: tx.inputsLength, outputs_count: tx.outputsLength, coin_name: 'Bitcoin', version: tx.version, lock_time: tx.lockTime })
      let signed = ''
      for (;;) {
        const m = req.message
        if (req.type !== 'TxRequest') throw new Error(`Your Trezor sent ${req.type} while signing`)
        if (m.serialized?.serialized_tx) signed += m.serialized.serialized_tx
        if (m.request_type === 'TXFINISHED') break
        const i: number = m.details?.request_index ?? 0, hash: string | undefined = m.details?.tx_hash
        const prev = hash ? prevs.get(hash) : undefined
        if (hash && !prev) throw new Error('Your Trezor asked about a transaction this payment does not spend')
        let ack: Record<string, unknown>
        if (m.request_type === 'TXINPUT' && !prev) {
          const inp = tx.getInput(i)
          ack = { inputs: [{ address_n: at('btc'), prev_hash: bytesToHex(inp.txid!), prev_index: inp.index, amount: String(inp.witnessUtxo!.amount), sequence: inp.sequence, script_type: 'SPENDWITNESS' }] }
        } else if (m.request_type === 'TXOUTPUT' && !prev) {
          const o = tx.getOutput(i)
          ack = { outputs: [{ address: addr.encode(btc.OutScript.decode(o.script!)), amount: String(o.amount), script_type: 'PAYTOADDRESS' }] }
        } else if (m.request_type === 'TXMETA' && prev) {
          ack = { version: prev.version, lock_time: prev.lockTime, inputs_cnt: prev.inputs.length, outputs_cnt: prev.outputs.length }
        } else if (m.request_type === 'TXINPUT' && prev) {
          const pi = prev.inputs[i]
          ack = { inputs: [{ prev_hash: bytesToHex(pi.txid), prev_index: pi.index, script_sig: bytesToHex(pi.finalScriptSig), sequence: pi.sequence }] }
        } else if (m.request_type === 'TXOUTPUT' && prev) {
          const po = prev.outputs[i]
          ack = { bin_outputs: [{ amount: String(po.amount), script_pubkey: bytesToHex(po.script) }] }
        } else throw new Error(`Your Trezor asked for ${m.request_type}, which a plain Bitcoin payment doesn't have`)
        req = await ask('TxAck', { tx: ack })
      }
      // the device's own copy of the signed payment: take only each input's signature and key from its witness
      const out = btc.Transaction.fromRaw(hexToBytes(signed), { allowUnknownOutputs: true })
      if (out.inputsLength !== tx.inputsLength) throw new Error('Your Trezor signed a different transaction')
      return Array.from({ length: out.inputsLength }, (_, i) => {
        const w = out.getInput(i).finalScriptWitness
        if (!w || w.length !== 2) throw new Error('Your Trezor returned an input without a signature')
        return [i, { signature: w[0], pubkey: w[1] }] as [number, { pubkey: Uint8Array; signature: Uint8Array }]
      })
    }),
    btcOrigin: hw.btc ? { pubkey: hexToBytes(hw.btc.pubkey), fingerprint: 0, path: trezorPath('btc', hw.account) } : undefined
  }
}
