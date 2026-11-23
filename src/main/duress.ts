// Duress PIN. Typed on the lock screen instead of the password, it opens an empty decoy wallet
// while everything is quietly swept to the Vault: a separate 24-word phrase shown once at setup
// and never stored. Astrala keeps only the Vault's addresses, so the swept coins can't be pulled
// back out of this Mac by anyone, including you under pressure.
import { safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { seal, open, type VaultFile } from '../core/vault'
import { deriveAccount, signingKey, moneroKeysFromSpend, newMnemonic } from '../core/derive'
import { getAllBalances, type Addresses } from '../core/chain'
import { execute, type SendRequest } from '../core/send'
import { ASSET, networkOf } from '../core/assets'
import { MoneroService } from '../core/monero'
import type { Family } from '../core/assets'

export interface DuressBlob {
  mnemonic: string // the real wallet, so the sweep can sign
  accounts: number[]
  vault: Partial<Record<Family, string>> // Vault receive addresses (no keys)
  xmrKey?: string
  birthday?: number
  decoy?: string // decoy phrase, fixed after first use so it stays consistent
  decoyName?: string
}

let file = ''
export const setDuressPath = (p: string) => { file = p }
export const duressEnabled = () => !!file && existsSync(file)

// The duress file holds the real recovery phrase behind a 6-digit PIN. Without the Keychain layer that is 10^6 offline
// guesses away, so there is no plaintext fallback: no Keychain, no duress PIN.
// Linux: with no keyring (libsecret / KWallet) Electron falls back to 'basic_text', a key hard-coded in Chromium. That
// is no protection, so it counts as no Keychain. Windows uses DPAPI (bound to the user's login), macOS the Keychain.
export const duressAvailable = () => safeStorage.isEncryptionAvailable() &&
  !(process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))
const wrap = (b: Buffer) => { if (!duressAvailable()) throw new Error('Duress PIN needs the system keychain, which is not available'); return safeStorage.encryptString(b.toString('base64')) }
const unwrap = (b: Buffer) => { if (!duressAvailable()) throw new Error('System keychain not available'); return Buffer.from(safeStorage.decryptString(b), 'base64') }

export const vaultAddresses = (vaultMnemonic: string): DuressBlob['vault'] =>
  Object.fromEntries(deriveAccount(vaultMnemonic, 0).map((a) => [a.chain, a.address]))

/** Sealed with the PIN (Argon2id + AES-GCM), then wrapped by the OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret/KWallet) so a copied file can't be brute-forced offline. */
export async function writeDuress(blob: DuressBlob, pin: string) {
  const sealed = await seal(blob as any, pin)
  await writeFile(file, wrap(Buffer.from(JSON.stringify(sealed))), { mode: 0o600 })
}

export async function openDuress(pin: string): Promise<DuressBlob | null> {
  if (!duressEnabled()) return null
  try {
    const sealed = JSON.parse(unwrap(await readFile(file)).toString()) as VaultFile
    return (await open(sealed, pin)) as unknown as DuressBlob
  } catch { return null }
}

export const removeDuress = () => rm(file, { force: true })
export const newVaultPhrase = () => newMnemonic()

export async function ensureDecoy(blob: DuressBlob, pin: string, name: () => string) {
  if (!blob.decoy || !blob.decoyName) { blob.decoy ??= newMnemonic(); blob.decoyName ??= name(); await writeDuress(blob, pin) }
  return { mnemonic: blob.decoy, name: blob.decoyName }
}

// ---------- the sweep ----------
type Log = (line: string) => void
const FAMILY_ORDER: Family[] = ['evm', 'sol', 'trx', 'btc', 'ltc', 'doge']

export async function sweep(blob: DuressBlob, opts: { route: { proxy: string | null; blocked: boolean }; xmrCache: (acct: number) => string; log?: Log }) {
  const log = opts.log ?? (() => {})
  const accounts = [...new Set([...blob.accounts, ...Array.from({ length: Math.max(...blob.accounts, 0) + 3 }, (_, i) => i)])]
  for (const acct of accounts) {
    const addrs: Addresses = Object.fromEntries(deriveAccount(blob.mnemonic, acct).map((a) => [a.chain, a.address]))
    let bals
    try { bals = await getAllBalances(addrs) } catch { continue }
    // tokens first (they need native gas), then the native coins, Monero handled separately
    const todo = bals
      .filter((b) => (b.amount ?? 0) > 0 && b.asset !== 'xmr')
      .sort((a, b) => (ASSET[a.asset].kind === 'token' ? 0 : 1) - (ASSET[b.asset].kind === 'token' ? 0 : 1) || FAMILY_ORDER.indexOf(networkOf(a.asset).family) - FAMILY_ORDER.indexOf(networkOf(b.asset).family))
    for (const b of todo) {
      const fam = networkOf(b.asset).family
      const to = blob.vault[fam]
      if (!to) continue
      const req: SendRequest = { assetId: b.asset, to, amount: '0', speed: 'fast', max: true, account: acct }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await execute(req, addrs, (f) => signingKey(blob.mnemonic, f, acct))
          log(`swept ${b.asset} #${acct} ${r.txid}`)
          break
        } catch (e: any) {
          log(`sweep ${b.asset} #${acct} failed: ${e?.message ?? e}`)
          await new Promise((ok) => setTimeout(ok, 4000))
        }
      }
    }
    if ((bals.find((b) => b.asset === 'xmr')?.amount ?? 0) > 0 || existsSync(opts.xmrCache(acct)) || acct === 0) await sweepMonero(blob, acct, opts, log)
  }
}

async function sweepMonero(blob: DuressBlob, acct: number, opts: { route: { proxy: string | null; blocked: boolean }; xmrCache: (acct: number) => string }, log: Log) {
  if (!blob.vault.xmr) return
  const k = moneroKeysFromSpend(signingKey(blob.mnemonic, 'xmr', acct).priv)
  let cached: { keys: Uint8Array; cache: Uint8Array; restoreHeight: number } | null = null
  if (blob.xmrKey) {
    try {
      const { createDecipheriv } = await import('node:crypto')
      const raw = await readFile(opts.xmrCache(acct))
      const d = createDecipheriv('aes-256-gcm', Buffer.from(blob.xmrKey, 'hex'), raw.subarray(0, 12))
      d.setAuthTag(raw.subarray(12, 28))
      const j = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString())
      cached = { keys: new Uint8Array(Buffer.from(j.k, 'base64')), cache: new Uint8Array(Buffer.from(j.c, 'base64')), restoreHeight: j.h }
    } catch { /* full scan from birthday */ }
  }
  const svc = new MoneroService(() => {}, async () => {})
  svc.proxy = opts.route.proxy
  svc.blocked = opts.route.blocked
  // locked outputs need 10 confirmations, so keep trying for a while
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      if (svc.status.state !== 'synced') {
        svc.open({ address: k.address, viewSec: k.viewSec, spendSec: k.spendSec, birthday: blob.birthday }, cached).catch(() => {})
        const t0 = Date.now()
        while ((svc.status.state as string) !== 'synced' && Date.now() - t0 < 30 * 60_000) await new Promise((ok) => setTimeout(ok, 3000))
      }
      const bal = await svc.balance()
      if (!bal || bal.total <= 0) break
      if (bal.unlocked > 0) {
        const r = await svc.send(blob.vault.xmr, '0', 'fast', true)
        log(`swept xmr #${acct} ${r.txid}`)
      }
      if (bal.total - bal.unlocked <= 0) break
    } catch (e: any) { log(`xmr sweep #${acct}: ${e?.message ?? e}`) }
    await new Promise((ok) => setTimeout(ok, 10 * 60_000))
  }
  await svc.stop()
}
