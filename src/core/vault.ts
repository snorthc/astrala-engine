// Encrypted vault: Argon2id (password stretching) + AES-256-GCM. Runs in the main process only.
import { argon2id } from 'hash-wasm'
import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import type { CustomToken } from './assets'

/** A hardware-wallet account (Ledger or Trezor): what the device told us (addresses, Bitcoin's key), never a private key. */
export interface HwAccount {
  vendor: 'ledger' | 'trezor'
  account: number // the device's account number (Ledger: 44'/60'/x'/0/0; Trezor: 44'/60'/0'/0/x)
  evm?: string
  sol?: string
  /** fingerprint and xpub: Ledger's Bitcoin app needs the account's key origin; a Trezor only the key */
  btc?: { address: string; pubkey: string; fingerprint?: string; xpub?: string }
}

export interface VaultSecrets {
  mnemonic: string
  createdAt: number
  accounts: { index: number; name: string; avatar?: Avatar; hidden?: boolean; xmrRestoreHeight?: number; type?: import('./account-types').AccountType; route?: string; hw?: HwAccount }[] // route: the id of the route that made this staging wallet, keeping it out of the account switcher. type: what the account is for (missing = Spending). xmrRestoreHeight: the block this account's Monero scan starts from (default: the wallet's birthday)
  /** Last scanned Monero balance per account. Monero scans one account at a time; this keeps the others' coins visible. */
  xmrLast?: Record<number, number>
  /** Last balances seen per account, so the wallet shows your money the moment it opens instead of
   *  after every chain has answered. Replaced as fresh ones arrive; never used to decide a send. */
  balanceCache?: Record<number, import('./chain').Balance[]>
  /** Websites connected through the browser extension, by origin. In the vault because which sites you use is private. */
  dapps?: Record<string, { account: number; chainId: number; at: number }>
  /** Last prices seen per currency, so values appear at once on open and survive a rate-limited price feed. */
  priceCache?: Record<string, Record<string, import('./chain').PriceInfo>>
  activity?: ActivityItem[]
  splits?: import('./split').SplitRecord[]
  routes?: import('./route').RouteRecord[]
  xmrKey?: string // encrypts the local Monero wallet cache
  birthday?: number // ms; Monero scans from here (defaults to createdAt)
  book?: Contact[]
  favs?: string[]
  sky?: string[] // coins pinned into the portfolio solar system
  arrived?: unknown[] // payments seen landing that no explorer lists (e.g. plain ETH on L2s)
  alerts?: PriceAlert[]
  watch?: Watched[]
  tokens?: CustomToken[] // coins the user added (search or pasted contract)
  duress?: { vault: Partial<Record<string, string>>; setAt: number } // Vault addresses only, never its keys
  // payment PIN (Argon2id hash only), wrong-PIN counters and the daily spend limit
  pay?: { pin?: { salt: string; hash: string }; fails?: number; lockUntil?: number; limit?: { amount: number; currency: string }; confirmOff?: boolean; guardOff?: boolean } // confirmOff: user turned off main's native payment confirmation (default on)
}

export interface Contact { id: string; name: string; address: string; family: string; note?: string; created: number }
export interface PriceAlert { id: string; asset: string; price: number; currency: string; created: number }
export interface Watched { id: string; name: string; address: string; family: string; created: number; last?: Record<string, number> } // last: balances when last checked, to spot changes

export type Avatar =
  | { kind: 'orb'; hue: number; hue2: number }
  | { kind: 'emoji'; emoji: string; hue: number }
  | { kind: 'image'; dataUrl: string } // ≤128px, stored inside the encrypted vault only

export interface ActivityItem {
  id: string
  kind: 'send' | 'swap'
  asset: string
  network: string
  amount: number
  fee: number
  feeAsset: string
  to: string
  txid: string
  time: number
  status: 'pending' | 'confirmed' | 'failed'
  account?: number
  swap?: { toAsset: string; expectedOut: number; minOut: number; provider: string; providerName: string; stage?: 'pending' | 'swapping' | 'done' | 'refunded' | 'unknown'; approveTxid?: string; ref?: string; ourFee?: number; feeTxid?: string }
  split?: string // the split this leg belongs to
  bumped?: string[] // earlier txids this payment replaced when its fee was raised
  cancel?: { of: string; outcome?: 'done' | 'late' } // a cancel replaced txid `of`; done = the money came back, late = the payment confirmed first
}

export interface VaultFile {
  v: 1
  kdf: { alg: 'argon2id'; salt: string; m: number; t: number; p: number }
  iv: string
  tag: string
  ct: string
}

const KDF = { m: 64 * 1024, t: 3, p: 1 } // 64 MiB, 3 passes

async function deriveKey(password: string, salt: Buffer, k = KDF): Promise<Buffer> {
  const hex = await argon2id({ password, salt, parallelism: k.p, iterations: k.t, memorySize: k.m, hashLength: 32, outputType: 'hex' })
  return Buffer.from(hex, 'hex')
}

export async function seal(secrets: VaultSecrets, password: string): Promise<VaultFile> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(password, salt)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()])
  key.fill(0)
  return { v: 1, kdf: { alg: 'argon2id', salt: salt.toString('hex'), ...KDF }, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('base64') }
}

/** A derived key kept in memory while unlocked, so saving changes doesn't re-run Argon2 (≈0.5 s) every time. */
export interface SealKey { key: Buffer; salt: Buffer; kdf: typeof KDF }
export async function sealKeyFor(password: string, file?: VaultFile): Promise<SealKey> {
  const salt = file ? Buffer.from(file.kdf.salt, 'hex') : randomBytes(16)
  const kdf = file ? { m: file.kdf.m, t: file.kdf.t, p: file.kdf.p } : KDF
  return { key: await deriveKey(password, salt, kdf), salt, kdf }
}
export function sealWith(secrets: VaultSecrets, sk: SealKey): VaultFile {
  const iv = randomBytes(12) // fresh IV every save
  const c = createCipheriv('aes-256-gcm', sk.key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()])
  return { v: 1, kdf: { alg: 'argon2id', salt: sk.salt.toString('hex'), ...sk.kdf }, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('base64') }
}
export function openWith(file: VaultFile, sk: SealKey): VaultSecrets {
  try {
    const d = createDecipheriv('aes-256-gcm', sk.key, Buffer.from(file.iv, 'hex'))
    d.setAuthTag(Buffer.from(file.tag, 'hex'))
    return JSON.parse(Buffer.concat([d.update(Buffer.from(file.ct, 'base64')), d.final()]).toString('utf8'))
  } catch { throw new Error('WRONG_PASSWORD') }
}

export async function open(file: VaultFile, password: string): Promise<VaultSecrets> {
  const key = await deriveKey(password, Buffer.from(file.kdf.salt, 'hex'), file.kdf)
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'hex'))
    d.setAuthTag(Buffer.from(file.tag, 'hex'))
    const pt = Buffer.concat([d.update(Buffer.from(file.ct, 'base64')), d.final()])
    return JSON.parse(pt.toString('utf8'))
  } catch {
    throw new Error('WRONG_PASSWORD')
  } finally {
    key.fill(0)
  }
}

// ---------- payment PIN ----------
// Lighter Argon2 than the vault (it's checked on every payment) but still far too slow to brute-force offline.
const PIN_KDF = { m: 19 * 1024, t: 2, p: 1 }
export async function hashPin(pin: string, salt = randomBytes(16)): Promise<{ salt: string; hash: string }> {
  return { salt: salt.toString('hex'), hash: (await deriveKey(`astrala-pin:${pin}`, salt, PIN_KDF)).toString('hex') }
}
export async function checkPin(pin: string, stored: { salt: string; hash: string }): Promise<boolean> {
  const h = (await hashPin(pin, Buffer.from(stored.salt, 'hex'))).hash
  const a = Buffer.from(h, 'hex'), b = Buffer.from(stored.hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
