// Astrala's own fee. Shown to the user before every swap/split, taken as a separate, normal transfer after the swap
// is broadcast, so it's visible on-chain and never hidden inside a quote.
import type { Family } from './assets'
import { feeAddressFrom, type FeeWallets } from './fee-wallets'

// Your fee wallets: src/core/fees.local.ts (gitignored, never exported), shaped like fees.local.example.ts.
// @ts-ignore: Vite fills this in at build time; it is {} when the file doesn't exist, and then no fee is taken.
const LOCAL = import.meta.glob('./fees.local.ts', { eager: true }) as Record<string, { default: FeeWallets }>
const WALLETS: FeeWallets = Object.values(LOCAL)[0]?.default ?? {}

export const FEES = {
  swapBps: 50, // 0.5% on a normal swap
  splitBps: 500, // 5% on a split
  routeBps: 200, // 2% on a route
  // Fees are taken in the coin being sent and go to today's address from your fee wallets (see above). A chain with
  // no wallet set takes no fee, and the screens show none. Keep this empty: addresses never go in the code.
  to: {} as Partial<Record<Family, string>>
}

// The built-in rates above are the defaults. The operator can adjust them from Astrala HQ without a new release
// (the wallet reads them from HQ's live config), but never above these hard ceilings, and never to a different
// address: only the percentage can move. Every screen still shows the fee before you confirm.
export const FEE_CEILING = { swapBps: 100, splitBps: 1000, routeBps: 300 } // 1% · 10% · 3%
const DEFAULT_BPS = { swapBps: FEES.swapBps, splitBps: FEES.splitBps, routeBps: FEES.routeBps }

/** Applies rates from HQ's live config, clamped to [0, ceiling]. Anything missing or invalid falls back to the default. */
export function applyRemoteFees(remote?: Partial<Record<keyof typeof FEE_CEILING, unknown>> | null) {
  for (const k of Object.keys(FEE_CEILING) as (keyof typeof FEE_CEILING)[]) {
    const v = Number(remote?.[k])
    FEES[k] = Number.isFinite(v) && remote?.[k] !== undefined && remote?.[k] !== null ? Math.round(Math.min(Math.max(v, 0), FEE_CEILING[k])) : DEFAULT_BPS[k]
  }
  return { swapBps: FEES.swapBps, splitBps: FEES.splitBps, routeBps: FEES.routeBps }
}

/** Below these a transfer would be dust or cost more than it's worth, so the fee is skipped. In base units. */
const MIN: Partial<Record<Family, bigint>> = { btc: 1000n, ltc: 10000n, doge: 1_000_000n }

export const feeAddress = (fam: Family, now = Date.now()) => FEES.to[fam] || feeAddressFrom(WALLETS, fam, now)

/** Splits an amount into Astrala's fee and what actually gets swapped. */
export function takeFee(amount: bigint, bps: number, fam: Family): { fee: bigint; net: bigint } {
  if (!feeAddress(fam) || bps <= 0) return { fee: 0n, net: amount }
  const fee = (amount * BigInt(Math.round(bps))) / 10_000n
  if (fee <= 0n || fee < (MIN[fam] ?? 1n)) return { fee: 0n, net: amount }
  return { fee, net: amount - fee }
}
