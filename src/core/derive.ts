// Astrala wallet core: key + address derivation for every supported chain.
// Pure TypeScript on audited @noble / @scure libraries. No custom curve maths.
import { mnemonicToSeedSync, generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { bech32, base58, createBase58check } from '@scure/base'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { hmac } from '@noble/hashes/hmac.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import type { Family } from './assets'
export type ChainId = Family

export interface DerivedAddress {
  chain: ChainId
  address: string
  path: string
}

export const WORDLIST = wordlist

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 256) // 24 words
}

export function isValidMnemonic(m: string): boolean {
  return validateMnemonic(normalise(m), wordlist)
}

export function normalise(m: string): string {
  return m.trim().toLowerCase().split(/\s+/).join(' ')
}

const hash160 = (b: Uint8Array) => ripemd160(sha256(b))

// ---------- BTC / LTC (native segwit, BIP84) ----------
function segwitAddress(seed: Uint8Array, coinType: number, hrp: string, index: number): DerivedAddress {
  const path = `m/84'/${coinType}'/0'/0/${index}`
  const node = HDKey.fromMasterSeed(seed).derive(path)
  const words = bech32.toWords(hash160(node.publicKey!))
  return { chain: hrp === 'bc' ? 'btc' : 'ltc', address: bech32.encode(hrp, [0, ...words]), path }
}

// ---------- ETH + every EVM chain (BIP44, coin 60) ----------
export function toChecksumAddress(hexNoPrefix: string): string {
  const lower = hexNoPrefix.toLowerCase()
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)))
  let out = '0x'
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i]
  return out
}

function ethAddress(seed: Uint8Array, account: number): DerivedAddress {
  const path = `m/44'/60'/0'/0/${account}`
  const node = HDKey.fromMasterSeed(seed).derive(path)
  const pub = secp256k1.getPublicKey(node.privateKey!, false).slice(1)
  return { chain: 'evm', address: toChecksumAddress(bytesToHex(keccak_256(pub).slice(-20))), path }
}

// ---------- SOL (SLIP-0010 ed25519, Phantom-compatible path) ----------
function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  let key = I.slice(0, 32)
  let chain = I.slice(32)
  for (const seg of path.split('/').slice(1)) {
    const idx = (parseInt(seg.replace("'", ''), 10) | 0x80000000) >>> 0
    const data = new Uint8Array(37)
    data.set(key, 1)
    new DataView(data.buffer).setUint32(33, idx, false)
    I = hmac(sha512, chain, data)
    key = I.slice(0, 32)
    chain = I.slice(32)
  }
  return key
}

function solAddress(seed: Uint8Array, account: number): DerivedAddress {
  const path = `m/44'/501'/${account}'/0'`
  const priv = slip10Ed25519(seed, path)
  return { chain: 'sol', address: base58.encode(ed25519.getPublicKey(priv)), path }
}

// ---------- XMR ----------
// Spend key = sc_reduce32(keccak256(BIP32 secp key at m/44'/128'/account'/0/0)), view = sc_reduce32(keccak256(spend)).
// NOTE: cross-wallet compatibility of this BIP39->Monero scheme is verified in milestone 2 against monero-ts.
const L = 2n ** 252n + 27742317777372353535851937790883648493n
const leToBig = (b: Uint8Array) => b.reduceRight((acc, v) => (acc << 8n) | BigInt(v), 0n)
const bigToLe32 = (n: bigint) => {
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n }
  return out
}
const scReduce32 = (b: Uint8Array) => bigToLe32(leToBig(b) % L)
const scalarMultBase = (s: Uint8Array) => ed25519.Point.BASE.multiply(leToBig(s) || 1n).toBytes()

const XMR_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const XMR_BLOCK_CHARS = [0, 2, 3, 5, 6, 7, 9, 10, 11]
export function moneroBase58(data: Uint8Array): string {
  let out = ''
  for (let i = 0; i < data.length; i += 8) {
    const block = data.slice(i, i + 8)
    let num = block.reduce((acc, v) => (acc << 8n) | BigInt(v), 0n)
    const len = XMR_BLOCK_CHARS[block.length]
    let chunk = ''
    for (let j = 0; j < len; j++) { chunk = XMR_ALPHABET[Number(num % 58n)] + chunk; num /= 58n }
    out += chunk
  }
  return out
}

export function moneroBase58Decode(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i += 11) {
    const chunk = s.slice(i, i + 11)
    const size = XMR_BLOCK_CHARS.indexOf(chunk.length)
    if (size < 0) throw new Error('bad length')
    let num = 0n
    for (const c of chunk) { const v = XMR_ALPHABET.indexOf(c); if (v < 0) throw new Error('bad char'); num = num * 58n + BigInt(v) }
    const bytes: number[] = []
    for (let j = 0; j < size; j++) { bytes.unshift(Number(num & 0xffn)); num >>= 8n }
    if (num !== 0n) throw new Error('overflow')
    out.push(...bytes)
  }
  const b = new Uint8Array(out)
  const sum = keccak_256(b.slice(0, -4)).slice(0, 4)
  if (!sum.every((v, i) => v === b[b.length - 4 + i])) throw new Error('checksum')
  return b
}

export interface MoneroKeys { spendSec: string; viewSec: string; spendPub: string; viewPub: string; address: string }

export function moneroKeysFromSpend(spendSec: Uint8Array): MoneroKeys {
  const viewSec = scReduce32(keccak_256(spendSec))
  const spendPub = scalarMultBase(spendSec)
  const viewPub = scalarMultBase(viewSec)
  const body = new Uint8Array([0x12, ...spendPub, ...viewPub])
  const address = moneroBase58(new Uint8Array([...body, ...keccak_256(body).slice(0, 4)]))
  return { spendSec: bytesToHex(spendSec), viewSec: bytesToHex(viewSec), spendPub: bytesToHex(spendPub), viewPub: bytesToHex(viewPub), address }
}

function xmrAddress(seed: Uint8Array, account: number): DerivedAddress {
  const path = `m/44'/128'/${account}'/0/0`
  const node = HDKey.fromMasterSeed(seed).derive(path)
  const spend = scReduce32(keccak_256(node.privateKey!))
  return { chain: 'xmr', address: moneroKeysFromSpend(spend).address, path }
}

// ---------- DOGE (BIP44 legacy P2PKH, coin 3) ----------
const b58c = createBase58check(sha256)
function dogeAddress(seed: Uint8Array, account: number): DerivedAddress {
  const path = `m/44'/3'/${account}'/0/0`
  const node = HDKey.fromMasterSeed(seed).derive(path)
  return { chain: 'doge', address: b58c.encode(new Uint8Array([0x1e, ...hash160(node.publicKey!)])), path }
}

// ---------- TRX (BIP44 coin 195) ----------
export function tronFromPub(uncompressedNoPrefix: Uint8Array): string {
  return b58c.encode(new Uint8Array([0x41, ...keccak_256(uncompressedNoPrefix).slice(-20)]))
}
function trxAddress(seed: Uint8Array, account: number): DerivedAddress {
  const path = `m/44'/195'/${account}'/0/0`
  const node = HDKey.fromMasterSeed(seed).derive(path)
  return { chain: 'trx', address: tronFromPub(secp256k1.getPublicKey(node.privateKey!, false).slice(1)), path }
}
export const tronDecode = (a: string) => b58c.decode(a)
export const tronFromHex = (hex: string) => b58c.encode(Uint8Array.from(hex.match(/../g)!.map((x) => parseInt(x, 16))))

// ---------- Private keys (main process only, used for signing then discarded) ----------
// PBKDF2 (2048 rounds) is slow; keep the last seed while unlocked instead of recomputing it for every address and signature.
let seedMemo: { k: string; seed: Uint8Array } | null = null
export function seedOf(mnemonic: string, passphrase = ''): Uint8Array {
  const k = normalise(mnemonic) + '\u0000' + passphrase
  if (seedMemo?.k === k) return seedMemo.seed
  const seed = mnemonicToSeedSync(normalise(mnemonic), passphrase)
  seedMemo = { k, seed }
  return seed
}
export function clearSeedCache() { seedMemo?.seed.fill(0); seedMemo = null }

export function signingKey(mnemonic: string, family: ChainId, account = 0): { priv: Uint8Array; pub: Uint8Array } {
  const seed = seedOf(mnemonic)
  const hd = (p: string) => { const k = HDKey.fromMasterSeed(seed).derive(p); return { priv: k.privateKey!, pub: k.publicKey! } }
  switch (family) {
    case 'evm': return hd(`m/44'/60'/0'/0/${account}`)
    // BTC/LTC accounts live at successive address indices of BIP84 account 0 (matches segwitAddress), so any BIP84 wallet finds them
    case 'btc': return hd(`m/84'/0'/0'/0/${account}`)
    case 'ltc': return hd(`m/84'/2'/0'/0/${account}`)
    case 'doge': return hd(`m/44'/3'/${account}'/0/0`)
    case 'trx': return hd(`m/44'/195'/${account}'/0/0`)
    case 'sol': { const priv = slip10Ed25519(seed, `m/44'/501'/${account}'/0'`); return { priv, pub: ed25519.getPublicKey(priv) } }
    case 'xmr': { const k = HDKey.fromMasterSeed(seed).derive(`m/44'/128'/${account}'/0/0`); const spend = scReduce32(keccak_256(k.privateKey!)); return { priv: spend, pub: hexToBytesLocal(moneroKeysFromSpend(spend).spendPub) } }
  }
}
const hexToBytesLocal = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))

// ---------- Everything for one account ----------
export function deriveAccount(mnemonic: string, account = 0, passphrase = ''): DerivedAddress[] {
  const seed = seedOf(mnemonic, passphrase)
  return [
    xmrAddress(seed, account),
    ethAddress(seed, account),
    solAddress(seed, account),
    segwitAddress(seed, 2, 'ltc', account),
    segwitAddress(seed, 0, 'bc', account),
    dogeAddress(seed, account),
    trxAddress(seed, account)
  ]
}

// Exposed for tests
export const _internal = { segwitAddress, ethAddress, solAddress, xmrAddress, dogeAddress, trxAddress, scReduce32 }
