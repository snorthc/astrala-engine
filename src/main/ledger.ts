// Ledger over USB, with Ledger's own libraries (the code Ledger Live ships): the HID transport, the Ethereum app,
// the Solana app, and ledger-bitcoin for the current Bitcoin app. Keys never leave the device; this file only
// asks it for addresses and signatures. One request holds the device at a time and closes it after.
import { createRequire } from 'node:module'
import { HDKey } from '@scure/bip32'
import { base58 } from '@scure/base'
import type { HwAccount } from '../core/vault'

// Their ES-module builds are .js files without "type": "module", which Node refuses: load the CommonJS builds.
const req = createRequire(import.meta.url)
type Transport = { send(cla: number, ins: number, p1: number, p2: number, data?: Buffer, ok?: number[]): Promise<Buffer>; close(): Promise<void> }
const lib = () => ({
  T: req('@ledgerhq/hw-transport-node-hid-noevents').default as { open(path?: string | null): Promise<Transport>; list(): Promise<string[]>; isSupported(): Promise<boolean> },
  Eth: req('@ledgerhq/hw-app-eth').default as new (t: Transport) => {
    getAddress(path: string, display?: boolean): Promise<{ publicKey: string; address: string }>
    signTransaction(path: string, rawTxHex: string, resolution?: null): Promise<{ r: string; s: string; v: string }>
  },
  Sol: req('@ledgerhq/hw-app-solana').default as new (t: Transport) => {
    getAddress(path: string, display?: boolean): Promise<{ address: Buffer }>
    signTransaction(path: string, tx: Buffer): Promise<{ signature: Buffer }>
  },
  Btc: req('ledger-bitcoin') as {
    AppClient: new (t: Transport) => {
      getMasterFingerprint(): Promise<string>
      getExtendedPubkey(path: string, display?: boolean): Promise<string>
      getWalletAddress(policy: unknown, hmac: null, change: number, index: number, display: boolean): Promise<string>
      signPsbt(psbt: Buffer, policy: unknown, hmac: null): Promise<[number, { pubkey: Buffer; signature: Buffer }][]>
    }
    DefaultWalletPolicy: new (template: 'wpkh(@0/**)', key: string) => unknown
  }
})

export type LedgerChain = 'evm' | 'btc' | 'sol'
/** The app each chain needs open on the device, by the name the device reports. */
const APP: Record<LedgerChain, string> = { evm: 'Ethereum', btc: 'Bitcoin', sol: 'Solana' }
/** Ledger Live's own paths, so a Ledger account here shows the same addresses as in Ledger Live. */
export const ledgerPath = (chain: LedgerChain, account: number) =>
  chain === 'evm' ? `44'/60'/${account}'/0/0` : chain === 'btc' ? `84'/0'/${account}'/0/0` : `44'/501'/${account}'`
const btcAccountPath = (account: number) => `84'/0'/${account}'`

/** The device's answers, in words: status codes from Ledger's apps and the dashboard. */
function explain(e: any, chain?: LedgerChain): Error {
  const code: number | undefined = e?.statusCode
  const app = chain ? APP[chain] : 'the right'
  const msg = code === 0x6985 || code === 0x5501 ? 'You declined it on your Ledger.'
    : code === 0x5515 || code === 0x6982 ? 'Your Ledger is locked. Unlock it with your PIN and try again.'
    : code === 0x6e00 || code === 0x6d00 || code === 0x6e01 || code === 0x6511 ? `Open the ${app} app on your Ledger and try again.`
    : code === 0x6a80 && chain === 'evm' ? 'Your Ledger needs Blind signing for this (token payments show as raw data). Turn it on in the Ethereum app’s settings on the device, or update the app in Ledger Live.'
    : code === 0x6a80 || code === 0x6b00 ? `The ${app} app refused this. Update it in Ledger Live (My Ledger), then try again.`
    : /no device|cannot open|could not|not found/i.test(String(e?.message)) ? 'No Ledger found. Plug it in, unlock it, and close Ledger Live if it is open (only one app can use it at a time).'
    : String(e?.message ?? e).slice(0, 200)
  return new Error(msg)
}

let busy: Promise<unknown> = Promise.resolve()
/** One conversation with the device at a time (a second open while one is running fails on HID). */
function withDevice<T>(fn: (t: Transport) => Promise<T>): Promise<T> {
  const run = busy.then(async () => {
    const { T } = lib()
    const t = await T.open('')
    // a prompt nobody answers mustn't hold the device (and every later request) for ever: closing it ends the wait
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([fn(t), new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('Your Ledger didn’t answer in time, so nothing was sent. Try again.')), 180_000) })]) }
    finally { clearTimeout(timer); await t.close().catch(() => {}) }
  })
  busy = run.catch(() => {})
  return run
}

/** The app open on the device right now ("BOLOS" is the dashboard). Standard APDU b0 01, answered by every app. */
async function currentApp(t: Transport): Promise<string> {
  const r = await t.send(0xb0, 0x01, 0x00, 0x00)
  if (r[0] !== 1) return ''
  return r.subarray(2, 2 + r[1]).toString('ascii')
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
/**
 * Make sure the chain's app is open. From the dashboard the device is asked to open it (you confirm on the device),
 * the same request Ledger Live makes; another app open means you switch yourself, since closing it under you
 * would be rude. The device reconnects when an app starts, so this returns a fresh connection to use.
 */
async function ensureApp(chain: LedgerChain): Promise<void> {
  const want = APP[chain]
  const now = await withDevice(currentApp).catch((e) => { throw explain(e, chain) })
  if (now === want) return
  if (now !== 'BOLOS') throw new Error(`Your Ledger has the ${now || 'another'} app open. Close it and open the ${want} app, then try again.`)
  await withDevice((t) => t.send(0xe0, 0xd8, 0x00, 0x00, Buffer.from(want, 'ascii'))).catch((e) => {
    if (e?.statusCode === 0x6807) throw new Error(`The ${want} app isn't installed on your Ledger. Install it in Ledger Live (My Ledger), then try again.`)
    throw explain(e, chain)
  })
  // the device re-enumerates with the app running: wait for it to come back (up to 15 s for the confirmation)
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    const app = await withDevice(currentApp).catch(() => '')
    if (app === want) return
  }
  throw new Error(`Open the ${want} app on your Ledger and try again.`)
}

/** Run something with the chain's app open, turning the device's status codes into sentences. */
async function onApp<T>(chain: LedgerChain, fn: (t: Transport) => Promise<T>): Promise<T> {
  await ensureApp(chain)
  try { return await withDevice(fn) } catch (e) { throw explain(e, chain) }
}

export async function ledgerStatus(): Promise<{ supported: boolean; connected: boolean; app?: string; error?: string }> {
  try {
    const { T } = lib()
    if (!(await T.isSupported())) return { supported: false, connected: false }
    if (!(await T.list()).length) return { supported: true, connected: false }
    const app = await withDevice(currentApp)
    return { supported: true, connected: true, app: app === 'BOLOS' ? 'dashboard' : app }
  } catch (e) { return { supported: true, connected: false, error: explain(e).message } }
}

/** Read one chain's address from the device (display: also show it there to compare). */
export async function ledgerRead(chain: LedgerChain, account: number, display = false): Promise<Partial<HwAccount>> {
  const { Eth, Sol, Btc } = lib()
  const path = ledgerPath(chain, account)
  if (chain === 'evm') return onApp('evm', async (t) => ({ evm: (await new Eth(t).getAddress(path, display)).address }))
  if (chain === 'sol') return onApp('sol', async (t) => ({ sol: base58.encode((await new Sol(t).getAddress(path, display)).address) }))
  return onApp('btc', async (t) => {
    const app = new Btc.AppClient(t)
    const fingerprint = await app.getMasterFingerprint()
    const xpub = await app.getExtendedPubkey(`m/${btcAccountPath(account)}`, false)
    const policy = new Btc.DefaultWalletPolicy('wpkh(@0/**)', `[${fingerprint}/${btcAccountPath(account)}]${xpub}`)
    const address = await app.getWalletAddress(policy, null, 0, 0, display)
    const pubkey = Buffer.from(HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(0).publicKey!).toString('hex')
    return { btc: { address, pubkey, fingerprint, xpub } }
  })
}

/** Signers for core/send.ts: the device signs, the wallet builds and broadcasts. */
export function ledgerSigner(hw: HwAccount) {
  const { Eth, Sol, Btc } = lib()
  return {
    /** an unsigned EIP-1559 transaction, serialized: back come r, s and the y parity */
    evm: (unsigned: `0x${string}`) => onApp('evm', async (t) => {
      // null resolution: plain payments need none; a token transfer is shown as raw data (blind signing on the device)
      const s = await new Eth(t).signTransaction(ledgerPath('evm', hw.account), unsigned.slice(2), null)
      return { r: `0x${s.r.padStart(64, '0')}` as `0x${string}`, s: `0x${s.s.padStart(64, '0')}` as `0x${string}`, yParity: parseInt(s.v, 16) % 2 }
    }),
    /** the transaction message (what every signer signs): back comes the 64-byte signature */
    sol: (message: Uint8Array) => onApp('sol', async (t) => new Uint8Array((await new Sol(t).signTransaction(ledgerPath('sol', hw.account), Buffer.from(message))).signature)),
    /** a PSBT whose inputs carry this account's key origin: back come the signatures by input */
    btc: (psbt: Uint8Array) => onApp('btc', async (t) => {
      if (!hw.btc?.fingerprint || !hw.btc.xpub) throw new Error('This Ledger account has no Bitcoin address yet')
      const policy = new Btc.DefaultWalletPolicy('wpkh(@0/**)', `[${hw.btc.fingerprint}/${btcAccountPath(hw.account)}]${hw.btc.xpub}`)
      const sigs = await new Btc.AppClient(t).signPsbt(Buffer.from(psbt), policy, null)
      return sigs.map(([i, s]) => [i, { pubkey: new Uint8Array(s.pubkey), signature: new Uint8Array(s.signature) }] as [number, { pubkey: Uint8Array; signature: Uint8Array }])
    }),
    /** key origin for this account's one Bitcoin address, for the PSBT's inputs */
    btcOrigin: hw.btc?.fingerprint ? { pubkey: Buffer.from(hw.btc.pubkey, 'hex'), fingerprint: parseInt(hw.btc.fingerprint, 16), path: `m/${ledgerPath('btc', hw.account)}` } : undefined
  }
}
