// Split backup: your 24-word phrase's entropy, split with SLIP-39 into 3 shares (any 2 restore it).
// Each share is 33 words. Restoring gives back the exact same 24 words, so nothing else changes.
// @ts-expect-error the library ships without types
import slip39 from 'slip39'
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { normalise } from './derive'

export function splitPhrase(mnemonic: string, threshold = 2, total = 3): string[] {
  const entropy = Array.from(mnemonicToEntropy(normalise(mnemonic), wordlist))
  const s = slip39.fromArray(entropy, { passphrase: '', threshold: 1, groups: [[threshold, total]] })
  return Array.from({ length: total }, (_, i) => s.fromPath(`r/0/${i}`).mnemonics[0] as string)
}

export function joinShares(shares: string[]): string {
  const clean = shares.map((s) => s.trim().toLowerCase().split(/\s+/).join(' ')).filter(Boolean)
  const secret: number[] = slip39.recoverSecret(clean, '')
  return entropyToMnemonic(Uint8Array.from(secret), wordlist)
}

export const validShare = (s: string) => { try { return slip39.validateMnemonic(s.trim().toLowerCase().split(/\s+/).join(' ')) } catch { return false } }
