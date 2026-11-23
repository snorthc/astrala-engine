// The four things src/core takes from node:crypto, for a browser (the extension's background worker).
// The bundler points `node:crypto` here; in Node (the desktop app, the tests) the real module is used.
// AES-256-GCM comes from @noble/ciphers and SHA-256 from @noble/hashes, so a vault sealed here opens in the
// desktop app and the other way round (test/web-engine.test.ts checks both directions against node:crypto).
import { gcm } from '@noble/ciphers/aes'
import { sha256 } from '@noble/hashes/sha2.js'
import { Buffer } from 'buffer'

export function randomBytes(n: number): Buffer {
  const b = Buffer.alloc(n)
  globalThis.crypto.getRandomValues(b)
  return b
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length')
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

export function createHash(alg: string) {
  if (alg !== 'sha256') throw new Error(`createHash: only sha256 is available here, not ${alg}`)
  const parts: Uint8Array[] = []
  const h = {
    update(d: string | Uint8Array) { parts.push(typeof d === 'string' ? Buffer.from(d, 'utf8') : d); return h },
    digest(enc?: 'hex'): any { const out = Buffer.from(sha256(Buffer.concat(parts))); return enc === 'hex' ? out.toString('hex') : out }
  }
  return h
}

const TAG = 16
const need = (alg: string, key: Uint8Array, iv: Uint8Array) => {
  if (alg !== 'aes-256-gcm') throw new Error(`only aes-256-gcm is available here, not ${alg}`)
  if (key.length !== 32 || iv.length !== 12) throw new Error('aes-256-gcm needs a 32-byte key and a 12-byte iv')
}

/** Node's streaming cipher shape over a one-shot AEAD: everything given to update() is sealed in final(). */
export function createCipheriv(alg: string, key: Uint8Array, iv: Uint8Array) {
  need(alg, key, iv)
  const parts: Buffer[] = []
  let tag: Buffer | null = null
  return {
    update(d: string | Uint8Array, enc?: 'utf8'): Buffer { parts.push(typeof d === 'string' ? Buffer.from(d, enc ?? 'utf8') : Buffer.from(d)); return Buffer.alloc(0) },
    final(): Buffer {
      const sealed = gcm(key, iv).encrypt(Buffer.concat(parts)) // ciphertext with the 16-byte tag at the end
      tag = Buffer.from(sealed.subarray(sealed.length - TAG))
      return Buffer.from(sealed.subarray(0, sealed.length - TAG))
    },
    getAuthTag(): Buffer { if (!tag) throw new Error('getAuthTag before final'); return tag }
  }
}

export function createDecipheriv(alg: string, key: Uint8Array, iv: Uint8Array) {
  need(alg, key, iv)
  const parts: Buffer[] = []
  let tag: Uint8Array | null = null
  return {
    setAuthTag(t: Uint8Array) { tag = t },
    update(d: Uint8Array): Buffer { parts.push(Buffer.from(d)); return Buffer.alloc(0) },
    /** Throws when the tag does not match (a wrong password, or a changed file): nothing is returned unverified. */
    final(): Buffer {
      if (!tag || tag.length !== TAG) throw new Error('Unsupported state or unable to authenticate data')
      return Buffer.from(gcm(key, iv).decrypt(Buffer.concat([...parts, Buffer.from(tag)])))
    }
  }
}
