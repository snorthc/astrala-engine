// Route: a chain of swaps through any number of coins, each landing in a user-chosen account.
// The user can pause at any hop and resume later (or finish there).
// Fee: taken off the top before the first leg fires — see routeFeeBps for which rate applies.
import { parseUnits } from 'viem'
import { ASSET, networkOf } from './assets'
import { takeFee, FEES } from './fees'
import { swapQuote, roughFee, type SwapRoute, type PriceOf } from './swap'
import { canStage } from './reach'
import type { Addresses } from './chain'

export const MAX_HOPS = 8
export const ROUTE_FEE_BPS = FEES.routeBps

/** What a route costs: always the route fee (2%), whatever its shape. Worked out in the main process from
 *  the request, so the renderer can't ask for a different rate. */
export function routeFeeBps(_r: RouteRequest): number {
  return FEES.routeBps
}

export interface RouteHop {
  from: string   // coin id coming in
  to: string     // coin id going out
  account: number // account index that receives this hop's output
  pauseHere?: boolean // stop and wait for user confirmation before next hop
}

export interface RouteRequest {
  from: string        // source coin
  amount: string      // human-readable amount of source coin
  hops: RouteHop[]    // at least one hop
  slippageBps?: number
  account?: number    // source account (default: active)
  name?: string
}

export type HopStatus = 'waiting' | 'paused' | 'sending' | 'sent' | 'failed'

export interface RouteRecord {
  id: string
  name: string
  from: string
  amount: number
  fee: number
  feeBps: number
  feeTxid?: string
  feeError?: string
  account: number
  created: number
  status: 'running' | 'paused' | 'done' | 'failed'
  pausedAt?: number // hop index where route is currently paused
  slippageBps?: number
  feeUnits?: string // the route fee in base units, collected once when the route ends
  feeCollected?: boolean
  hops: {
    from: string
    to: string
    amountIn: number
    account: number
    status: HopStatus
    activityId?: string
    provider?: string
    providerName?: string
    expectedOut?: number
    error?: string
    etaSec?: number
    minOut?: number // the worst case the user accepted for this step, at the quoted input
    pauseHere?: boolean // stop after this step and wait for the user
  }[]
}

export interface RouteHopQuote {
  from: string
  to: string
  amountIn: number
  amountOut?: number
  route?: SwapRoute
  direct?: boolean
  error?: string
}

export interface RouteQuote {
  ok: boolean
  error?: string
  fee: number
  feeBps: number
  net: number
  hops: RouteHopQuote[]
  etaSec: number
  finalOut?: number
  finalCoin?: string
}

export function checkRoute(r: RouteRequest): string | null {
  const from = ASSET[r?.from]
  if (!from) return 'Pick a starting coin'
  if (!Array.isArray(r.hops) || r.hops.length < 1) return 'Add at least one hop'
  if (r.hops.length > MAX_HOPS) return `Up to ${MAX_HOPS} hops per route`
  for (let i = 0; i < r.hops.length; i++) {
    const h = r.hops[i]
    if (!ASSET[h.from]) return `Hop ${i + 1}: unknown source coin`
    if (!ASSET[h.to]) return `Hop ${i + 1}: unknown destination coin`
    if (i === 0 && h.from !== r.from) return 'First hop must start from your source coin'
    if (i > 0 && h.from !== r.hops[i - 1].to) return `Hop ${i + 1}: must continue from ${ASSET[r.hops[i - 1].to].symbol}`
    if (typeof h.account !== 'number') return `Hop ${i + 1}: pick an account`
    if (i < r.hops.length - 1 && !canStage(h.to)) return `Stop ${i + 1}: a route can only wait in a chain's own coin (like ETH, BTC or SOL), which pays the next network fee. Make ${ASSET[h.to].symbol} the last stop instead`
  }
  let amt: bigint
  try { amt = parseUnits(String(r.amount || '0'), from.decimals) } catch { return 'Enter a valid amount' }
  if (amt <= 0n) return 'Enter an amount'
  return null
}

const units = (v: bigint, d: number) => Number(v) / 10 ** d
const fmt = (v: bigint | number, d: number) =>
  (typeof v === 'bigint' ? Number(v) / 10 ** d : v).toFixed(Math.min(d, 10)).replace(/\.?0+$/, '')

/** Quote each hop in sequence, feeding the output of each into the next. */
export async function routeQuote(r: RouteRequest, addrs: Addresses, price: PriceOf): Promise<RouteQuote> {
  const bad = checkRoute(r)
  const bps = routeFeeBps(r)
  const empty: RouteQuote = { ok: false, fee: 0, feeBps: bps, net: 0, hops: [], etaSec: 0 }
  if (bad) return { ...empty, error: bad }

  const from = ASSET[r.from]
  const rawAmount = parseUnits(r.amount, from.decimals)
  const { fee, net } = takeFee(rawAmount, bps, networkOf(from.id).family)

  let currentAmount = net
  let currentCoin = r.from
  const hopQuotes: RouteHopQuote[] = []
  let totalEta = 0

  for (const hop of r.hops) {
    const hopFrom = ASSET[hop.from]
    const amountIn = units(currentAmount, hopFrom.decimals)
    const amountStr = fmt(currentAmount, hopFrom.decimals)

    if (hop.from === hop.to) {
      // self-send / move between accounts — no swap
      const networkFee = await roughFee(hopFrom)
      hopQuotes.push({
        from: hop.from, to: hop.to, amountIn, amountOut: amountIn, direct: true,
        route: { provider: 'wagyu', providerName: 'Direct move', from: hop.from, to: hop.to, amountIn, amountOut: amountIn, minOut: amountIn, networkFee, networkFeeAsset: networkOf(hop.from).native, etaSec: 60, approval: false, notes: [] }
      })
      // currentAmount unchanged (minus network fee, but we approximate as same)
    } else {
      const q = await swapQuote({ from: hop.from, to: hop.to, amount: amountStr, slippageBps: r.slippageBps, account: r.account }, addrs, price)
      if (!q.ok || !q.routes[0]) {
        hopQuotes.push({ from: hop.from, to: hop.to, amountIn, error: q.error ?? 'No route found' })
        return { ok: false, error: `${ASSET[hop.from].symbol}→${ASSET[hop.to].symbol}: ${q.error ?? 'No route found'}`, fee: units(fee, from.decimals), feeBps: fee > 0n ? bps : 0, net: units(net, from.decimals), hops: hopQuotes, etaSec: totalEta }
      }
      const best = q.routes[0]
      hopQuotes.push({ from: hop.from, to: hop.to, amountIn, amountOut: best.amountOut, route: best })
      totalEta = Math.max(totalEta, best.etaSec)
      // feed output into next hop
      const toAsset = ASSET[hop.to]
      currentAmount = parseUnits(String(best.amountOut.toFixed(toAsset.decimals)), toAsset.decimals)
      currentCoin = hop.to
    }
  }

  const lastHop = hopQuotes[hopQuotes.length - 1]
  return {
    ok: true,
    fee: units(fee, from.decimals),
    feeBps: fee > 0n ? bps : 0,
    net: units(net, from.decimals),
    hops: hopQuotes,
    etaSec: totalEta,
    finalOut: lastHop.amountOut,
    finalCoin: currentCoin,
  }
}

export const hopAmount = fmt
