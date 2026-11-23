// Split: one coin into several coins at once. Each leg is one direct swap (or a plain move, if the target is the
// coin itself) that lands in its own brand-new wallet. No intermediate hops, nothing routed back to the source.
import { parseUnits } from 'viem'
import { ASSET, networkOf } from './assets'
import { takeFee, FEES } from './fees'
import { swapQuote, roughFee, type SwapRoute, type PriceOf } from './swap'
import type { Addresses } from './chain'

export const MAX_LEGS = 12
export interface SplitLeg { to: string; pct: number }
export interface SplitRequest { from: string; amount: string; legs: SplitLeg[]; slippageBps?: number; account?: number; name?: string }
export interface SplitLegQuote { to: string; pct: number; amountIn: number; route?: SwapRoute; direct?: boolean; error?: string }
export type LegStatus = 'waiting' | 'sending' | 'sent' | 'failed'
export interface SplitRecord {
  id: string; name: string; from: string; amount: number; fee: number; feeBps: number; feeTxid?: string; feeError?: string
  account: number; created: number; status: 'running' | 'done' | 'partial' | 'failed'
  legs: { to: string; pct: number; amountIn: number; account: number; status: LegStatus; activityId?: string; provider?: string; providerName?: string; expectedOut?: number; error?: string; etaSec?: number }[]
}
export interface SplitQuote { ok: boolean; error?: string; fee: number; feeBps: number; net: number; legs: SplitLegQuote[]; etaSec: number }

/** Why a split can't run, or null. */
export function checkSplit(r: SplitRequest): string | null {
  const from = ASSET[r?.from]
  if (!from) return 'Pick a coin to split'
  if (from.id === 'xmr') return 'Monero has no decentralized swap route yet'
  if (!Array.isArray(r.legs) || r.legs.length < 2) return 'Split into at least two coins'
  if (r.legs.length > MAX_LEGS) return `Up to ${MAX_LEGS} coins per split`
  if (new Set(r.legs.map((l) => l.to)).size !== r.legs.length) return 'Each coin can only appear once'
  for (const l of r.legs) {
    if (!ASSET[l.to]) return 'Unknown coin in the split'
    if (l.to === 'xmr') return 'Monero has no decentralized swap route yet'
    if (!(Number.isInteger(l.pct) && l.pct >= 1 && l.pct <= 100)) return 'Each share must be a whole percent, 1–100'
  }
  if (r.legs.reduce((s, l) => s + l.pct, 0) !== 100) return 'Shares must add up to 100%'
  let amt: bigint
  try { amt = parseUnits(String(r.amount || '0'), from.decimals) } catch { return 'Enter a valid amount' }
  if (amt <= 0n) return 'Enter an amount'
  return null
}

/** Astrala's fee off the top, then the rest shared by percent. The last leg takes the rounding dust so nothing is left over. */
export function splitAmounts(amount: bigint, pcts: number[], bps: number, fam: Parameters<typeof takeFee>[2]) {
  const { fee, net } = takeFee(amount, bps, fam)
  const parts = pcts.map((p) => (net * BigInt(p)) / 100n)
  parts[parts.length - 1] += net - parts.reduce((s, x) => s + x, 0n)
  return { fee, net, parts }
}

const units = (v: bigint, d: number) => Number(v) / 10 ** d
const fmt = (v: bigint, d: number) => (Number(v) / 10 ** d).toFixed(Math.min(d, 10)).replace(/\.?0+$/, '')

/** Best route for every leg, quoted from the source wallet (the new wallets don't exist until the user confirms). */
export async function splitQuote(r: SplitRequest, addrs: Addresses, price: PriceOf): Promise<SplitQuote> {
  const bad = checkSplit(r)
  const empty = { fee: 0, feeBps: FEES.splitBps, net: 0, legs: [], etaSec: 0 }
  if (bad) return { ok: false, error: bad, ...empty }
  const from = ASSET[r.from]
  const { fee, net, parts } = splitAmounts(parseUnits(r.amount, from.decimals), r.legs.map((l) => l.pct), FEES.splitBps, networkOf(from.id).family)
  const legs: SplitLegQuote[] = []
  // four at a time: a 12-leg split asks every provider for every leg, and public APIs rate-limit
  for (let i = 0; i < r.legs.length; i += 4) {
    legs.push(...(await Promise.all(r.legs.slice(i, i + 4).map(async (l, k): Promise<SplitLegQuote> => {
      const part = parts[i + k], amountIn = units(part, from.decimals)
      if (l.to === r.from) return { to: l.to, pct: l.pct, amountIn, direct: true, route: { provider: 'wagyu', providerName: 'Direct move', from: r.from, to: l.to, amountIn, amountOut: amountIn, minOut: amountIn, networkFee: await roughFee(from), networkFeeAsset: networkOf(r.from).native, etaSec: 60, approval: false, notes: [] } }
      const q = await swapQuote({ from: r.from, to: l.to, amount: fmt(part, from.decimals), slippageBps: r.slippageBps, account: r.account }, addrs, price)
      return q.ok ? { to: l.to, pct: l.pct, amountIn, route: q.routes[0] } : { to: l.to, pct: l.pct, amountIn, error: q.error }
    }))))
  }
  const err = legs.find((l) => l.error)
  return {
    ok: !err, error: err ? `${ASSET[err.to].symbol}: ${err.error}` : undefined,
    fee: units(fee, from.decimals), feeBps: fee > 0n ? FEES.splitBps : 0, net: units(net, from.decimals), legs,
    etaSec: Math.max(0, ...legs.map((l) => l.route?.etaSec ?? 0))
  }
}

export const legAmount = fmt
