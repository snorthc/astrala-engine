// Payment URIs: what a Receive QR encodes, and what Send accepts when one is pasted.
// Pure (no network, no keys), shared by the UI and tests.
//
//   BTC / LTC / DOGE   bitcoin:<addr>?amount=0.01&message=…             BIP-21 (litecoin:, dogecoin: follow it)
//   XMR                monero:<addr>?tx_amount=0.5&tx_description=…      Monero URI scheme
//   ETH + EVM natives  ethereum:<addr>@<chainId>?value=<wei>              EIP-681
//   ERC-20             ethereum:<token>@<chainId>/transfer?address=<addr>&uint256=<atomic>
//   SOL / SPL          solana:<addr>?amount=1.5&spl-token=<mint>&message=…  Solana Pay transfer request
//   TRX / TRC-20       tron:<addr>?amount=150&token=<contract>
//
// Amounts are written as exact decimals (or atomic integers for EIP-681): never a float artefact, never 1e-7.
import { ASSET, NETWORKS, assetByContract, type Family } from './assets'

export type PayScheme = 'bitcoin' | 'litecoin' | 'dogecoin' | 'monero' | 'ethereum' | 'solana' | 'tron'
const SCHEME: Record<Family, PayScheme> = { btc: 'bitcoin', ltc: 'litecoin', doge: 'dogecoin', xmr: 'monero', evm: 'ethereum', sol: 'solana', trx: 'tron' }
const NATIVE: Partial<Record<PayScheme, string>> = { bitcoin: 'btc', litecoin: 'ltc', dogecoin: 'doge', monero: 'xmr', solana: 'sol', tron: 'trx' }

// ---------- exact decimals ----------

const DEC = /^(\d+\.?\d*|\.\d+)(?:e([+-]?\d+))?$/i

/** A non-negative decimal as a plain digit string ("0.000001", never "1e-6"). Numbers are read to 15 significant
 *  digits, which is all a double holds, so 0.1 + 0.2 becomes "0.3". Null for anything that isn't a valid amount. */
export function plainDecimal(v: number | string | bigint | null | undefined): string | null {
  if (v == null) return null
  if (typeof v === 'bigint') return v < 0n ? null : v.toString()
  let s: string
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null
    if (v === 0) return '0'
    s = v.toPrecision(15)
  } else s = v.trim()
  const m = DEC.exec(s)
  if (!m) return null
  let [int, frac = ''] = m[1].split('.')
  let exp = m[2] ? Number(m[2]) : 0
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) return null
  // shift the decimal point by the exponent, in the string, so nothing is lost
  if (exp > 0) { const take = frac.slice(0, exp); int += take.padEnd(exp, '0'); frac = frac.slice(exp) }
  else if (exp < 0) { const n = -exp; const pad = int.padStart(n + 1, '0'); frac = pad.slice(pad.length - n) + frac; int = pad.slice(0, pad.length - n) }
  int = int.replace(/^0+(?=\d)/, '') || '0'
  frac = frac.replace(/0+$/, '')
  return frac ? `${int}.${frac}` : int
}

/** Amount in atomic units (sats, wei, piconero…), rounded half-up to `decimals`. Null if invalid. */
export function toAtomic(v: number | string | null | undefined, decimals: number): bigint | null {
  const s = plainDecimal(v)
  if (s == null) return null
  const [int, frac = ''] = s.split('.')
  if (frac.length <= decimals) return BigInt(int + frac.padEnd(decimals, '0'))
  const base = BigInt(int + frac.slice(0, decimals))
  return frac.charCodeAt(decimals) >= 53 /* '5' */ ? base + 1n : base
}

/** Atomic units back to a trimmed decimal string: fromAtomic(1500000n, 8) → "0.015". */
export function fromAtomic(atomic: bigint | string, decimals: number): string {
  const a = typeof atomic === 'bigint' ? atomic : BigInt(atomic)
  if (a < 0n) throw new Error('negative amount')
  const s = a.toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals), frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : ''
  return frac ? `${int}.${frac}` : int
}

/** The amount exactly as a URI writes it, at the coin's precision. '' when there is no (or a zero) amount. */
export function formatAmount(v: number | string | null | undefined, decimals: number): string {
  const a = toAtomic(v, decimals)
  return a && a > 0n ? fromAtomic(a, decimals) : ''
}

// ---------- build ----------

export interface PayRequest {
  assetId: string
  address: string
  /** in whole coins; omitted, zero or invalid means "any amount" */
  amount?: number | string | null
  note?: string
}

const q = (pairs: [string, string | undefined][]) => {
  const p = pairs.filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
  return p.length ? `?${p.join('&')}` : ''
}

export function payScheme(assetId: string): PayScheme {
  const a = ASSET[assetId]
  if (!a) throw new Error(`Unknown asset ${assetId}`)
  return SCHEME[NETWORKS[a.network].family]
}

/** A standard payment URI any phone wallet opens pre-filled. */
export function buildPayUri({ assetId, address, amount, note }: PayRequest): string {
  const a = ASSET[assetId]
  if (!a) throw new Error(`Unknown asset ${assetId}`)
  const net = NETWORKS[a.network]
  const addr = address.trim()
  if (!addr) throw new Error('No address')
  const amt = formatAmount(amount, a.decimals)
  const memo = note?.trim().slice(0, 140) || undefined
  switch (net.family) {
    case 'btc': case 'ltc': case 'doge':
      return `${SCHEME[net.family]}:${addr}${q([['amount', amt], ['message', memo]])}`
    case 'xmr':
      return `monero:${addr}${q([['tx_amount', amt], ['tx_description', memo]])}`
    case 'sol':
      return `solana:${addr}${q([['amount', amt], ['spl-token', a.kind === 'token' ? a.contract : undefined], ['message', memo]])}`
    case 'trx':
      return `tron:${addr}${q([['amount', amt], ['token', a.kind === 'token' ? a.contract : undefined]])}`
    case 'evm': {
      const wei = amt ? toAtomic(amt, a.decimals)!.toString() : undefined
      if (a.kind === 'token') return `ethereum:${a.contract}@${net.chainId}/transfer${q([['address', addr], ['uint256', wei]])}`
      return `ethereum:${addr}@${net.chainId}${q([['value', wei]])}`
    }
  }
}

/** "Pay 0.01 BTC to bc1q…: bitcoin:bc1q…?amount=0.01" — plain text to paste into any chat. */
export function payText(r: PayRequest, uri = buildPayUri(r)): string {
  const a = ASSET[r.assetId]
  const net = NETWORKS[a.network]
  const amt = formatAmount(r.amount, a.decimals)
  const home = a.kind === 'native' && (net.family !== 'evm' || net.id === 'ethereum' || a.symbol !== 'ETH')
  const what = `${amt ? `${amt} ` : ''}${a.symbol}${home ? '' : ` on ${net.name}`}`
  const note = r.note?.trim() ? ` for “${r.note.trim().slice(0, 140)}”` : ''
  return `Pay ${what} to ${r.address.trim()}${note}: ${uri}`
}

// ---------- parse ----------

export interface ParsedPay {
  scheme: PayScheme
  /** the Astrala asset this pays in, or null for a token Astrala doesn't know */
  assetId: string | null
  address: string
  /** whole coins, exact decimal string */
  amount?: string
  note?: string
  chainId?: number
  token?: string
}

const SCHEMES = new Set<string>(['bitcoin', 'litecoin', 'dogecoin', 'monero', 'ethereum', 'solana', 'tron'])

function params(query: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const part of query.split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const k = (i < 0 ? part : part.slice(0, i)).toLowerCase()
    let v = i < 0 ? '' : part.slice(i + 1)
    try { v = decodeURIComponent(v.replace(/\+/g, ' ')) } catch { /* keep raw */ }
    if (!m.has(k)) m.set(k, v)
  }
  return m
}

const decimalParam = (v: string | undefined) => { const s = v ? plainDecimal(v) : null; return s && s !== '0' ? s : undefined }

/** Read a payment URI (bitcoin:, ethereum:, solana:…). Null for anything else, including a bare address. */
export function parsePayUri(text: string): ParsedPay | null {
  const raw = text.trim()
  const c = raw.indexOf(':')
  if (c < 2) return null
  const scheme = raw.slice(0, c).toLowerCase()
  if (!SCHEMES.has(scheme)) return null
  let rest = raw.slice(c + 1).replace(/^\/\//, '')
  const qi = rest.indexOf('?')
  const path = qi < 0 ? rest : rest.slice(0, qi)
  const p = params(qi < 0 ? '' : rest.slice(qi + 1))
  const s = scheme as PayScheme

  if (s === 'ethereum') {
    const m = /^(?:pay-)?([^@/]+)(?:@(\d+))?(?:\/(\w+))?$/.exec(path)
    if (!m) return null
    const chainId = m[2] ? Number(m[2]) : 1
    const net = Object.values(NETWORKS).find((n) => n.chainId === chainId)
    if (m[3] === 'transfer') {
      const token = m[1], to = p.get('address')
      if (!to) return null
      const asset = net ? assetByContract(net.id, token) : undefined
      const atomic = p.get('uint256')
      const units = atomic ? plainDecimal(atomic) : null
      const amount = asset && units && !units.includes('.') && units !== '0' ? fromAtomic(BigInt(units), asset.decimals) : undefined
      return { scheme: s, assetId: asset?.id ?? null, address: to, amount, chainId, token }
    }
    if (m[3]) return null // a contract call Astrala doesn't send from a link
    const wei = p.get('value')
    const units = wei ? plainDecimal(wei) : null
    const amount = units && !units.includes('.') && units !== '0' ? fromAtomic(BigInt(units), 18) : decimalParam(p.get('amount'))
    return { scheme: s, assetId: net?.native ?? null, address: m[1], amount, chainId }
  }

  const address = decodeURIComponent(path)
  if (!address || /[\s/]/.test(address)) return null
  const note = (s === 'monero' ? p.get('tx_description') ?? p.get('recipient_name') : p.get('message') ?? p.get('memo') ?? p.get('label')) || undefined
  if (s === 'monero') return { scheme: s, assetId: 'xmr', address, amount: decimalParam(p.get('tx_amount')), note }
  if (s === 'solana' || s === 'tron') {
    const token = p.get(s === 'solana' ? 'spl-token' : 'token') || undefined
    const assetId = token ? assetByContract(s, token)?.id ?? null : NATIVE[s]!
    return { scheme: s, assetId, address, amount: decimalParam(p.get('amount')), note, ...(token ? { token } : {}) }
  }
  return { scheme: s, assetId: NATIVE[s]!, address, amount: decimalParam(p.get('amount')), note }
}
