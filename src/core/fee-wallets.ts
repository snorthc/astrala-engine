// Where Astrala's fees land, worked out from PUBLIC keys only (an account xpub per chain), so no fee address is ever
// written into the code, the public repo or the screens. The keys live in src/core/fees.local.ts, which is gitignored
// and left out of the public export. The address changes every day, cycling through the first `pool` addresses of
// the account so a normal wallet (which looks about 20 addresses ahead) always finds the money.
import { HDKey } from '@scure/bip32'
import { bech32, createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { toChecksumAddress, tronFromPub } from './derive'
import type { Family } from './assets'

export interface FeeWallets {
  /** Account-level extended public keys: btc m/84'/0'/0', ltc m/84'/2'/0', evm m/44'/60'/0', doge m/44'/3'/0', trx m/44'/195'/0'.
   *  Any prefix works (xpub, zpub, Ltub, dgub…); only the key inside is used. */
  xpub?: Partial<Record<'btc' | 'ltc' | 'evm' | 'doge' | 'trx', string>>
  /** One fixed address per chain. Required for sol/xmr (no public-key derivation); for the others it's the fallback
   *  when no xpub is set, so that chain's fee always goes to this one address instead of rotating. */
  fixed?: Partial<Record<Family, string>>
  /** How many addresses to rotate through (default 20). */
  pool?: number
}

const b58c = createBase58check(sha256)
const hash160 = (b: Uint8Array) => ripemd160(sha256(b))
const XPUB_VERSION = new Uint8Array([0x04, 0x88, 0xb2, 0x1e])

/** Reads any SLIP-132 flavoured extended public key as a plain xpub. Throws on a private key. */
function readXpub(s: string): HDKey {
  const raw = b58c.decode(s.trim())
  if (raw.length !== 78) throw new Error('Not an extended public key')
  if (raw[45] !== 0x02 && raw[45] !== 0x03) throw new Error('That is a private key. Only paste the public key (xpub)')
  return HDKey.fromExtendedKey(b58c.encode(new Uint8Array([...XPUB_VERSION, ...raw.slice(4)])))
}

/** Which slot today is: whole days since 1 Jan 2026 (UTC), wrapped into the pool. */
export const slotFor = (now: number, pool = 20) => Math.floor((now - Date.UTC(2026, 0, 1)) / 86_400_000) % Math.max(1, pool)

export function feeAddressFrom(w: FeeWallets, fam: Family, now = Date.now()): string {
  const fixed = w.fixed?.[fam]?.trim() ?? ''
  if (fam === 'sol' || fam === 'xmr') return fixed
  const x = w.xpub?.[fam as keyof NonNullable<FeeWallets['xpub']>]
  if (!x) return fixed
  const pub = readXpub(x).deriveChild(0).deriveChild(slotFor(now, w.pool)).publicKey!
  if (fam === 'btc' || fam === 'ltc') return bech32.encode(fam === 'btc' ? 'bc' : 'ltc', [0, ...bech32.toWords(hash160(pub))])
  if (fam === 'doge') return b58c.encode(new Uint8Array([0x1e, ...hash160(pub)]))
  const full = secp256k1.Point.fromBytes(pub).toBytes(false).slice(1)
  if (fam === 'evm') return toChecksumAddress(bytesToHex(keccak_256(full).slice(-20)))
  if (fam === 'trx') return tronFromPub(full)
  return ''
}
