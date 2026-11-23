// Which provider can serve which pair, and how to get anywhere from anywhere.
//
// Pure data and graph work over assets.ts — no network, no keys, no crypto libraries — so the
// renderer can import it to explain a route without pulling the swap engine into its bundle.
// swap.ts imports the same chain maps, so capability and execution can't drift apart.
import { ASSETS, ASSET, NETWORKS, networkOf, type Asset } from './assets'

export type Provider = 'jupiter' | 'kyber' | 'paraswap' | 'thorchain' | 'maya' | 'lifi' | 'wagyu'
export type Thorlike = 'thorchain' | 'maya'

export const KYBER_CHAIN: Record<string, string> = { ethereum: 'ethereum', arbitrum: 'arbitrum', base: 'base', optimism: 'optimism', polygon: 'polygon', bsc: 'bsc', avalanche: 'avalanche' }
export const THOR_CHAIN: Record<string, string> = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE', ethereum: 'ETH', base: 'BASE', bsc: 'BSC', avalanche: 'AVAX', tron: 'TRON', solana: 'SOL' }
export const MAYA_CHAIN: Record<string, string> = { bitcoin: 'BTC', ethereum: 'ETH', arbitrum: 'ARB' }
export const LIFI_CHAIN: Record<string, string | number> = { ethereum: 1, arbitrum: 42161, base: 8453, optimism: 10, polygon: 137, bsc: 56, avalanche: 43114, solana: 'SOL', bitcoin: 'BTC' }
export const WAGYU_CHAIN: Record<string, { id: number; native: string }> = {
  monero: { id: 0, native: 'XMR' }, bitcoin: { id: 20000000000001, native: 'bitcoin' }, ethereum: { id: 1, native: '0x0000000000000000000000000000000000000000' },
  arbitrum: { id: 42161, native: '0x0000000000000000000000000000000000000000' }, base: { id: 8453, native: '0x0000000000000000000000000000000000000000' },
  bsc: { id: 56, native: '0x0000000000000000000000000000000000000000' }, solana: { id: 1151111081099710, native: '11111111111111111111111111111111' },
  tron: { id: 728126428, native: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' }
}
const THOR_CHAINS: Record<Thorlike, Record<string, string>> = { thorchain: THOR_CHAIN, maya: MAYA_CHAIN }

export function poolAsset(p: Thorlike, a: Asset): string | null {
  const c = THOR_CHAINS[p][a.network]
  if (!c) return null
  return a.kind === 'native' ? `${c}.${a.symbol}` : `${c}.${a.symbol}-${a.contract!.toUpperCase()}`
}

export const lifiToken = (a: Asset) => {
  const fam = NETWORKS[a.network].family
  if (fam === 'evm') return a.kind === 'native' ? '0x0000000000000000000000000000000000000000' : a.contract!
  if (fam === 'sol') return a.kind === 'native' ? '11111111111111111111111111111111' : a.contract!
  if (fam === 'btc') return 'bitcoin'
  return null
}

export const wagyuAsset = (a: Asset) => {
  const c = WAGYU_CHAIN[a.network]
  return c ? { chainId: c.id, token: a.kind === 'native' ? c.native : a.contract! } : null
}

/** Providers that could serve this pair at all, judged on chains and tokens only.
 *  Mirrors the early `return null` guards in each provider in swap.ts, so the two stay in step.
 *  Live pool status, liquidity and minimums are still decided when the pair is actually quoted. */
export function directProviders(fromId: string, toId: string): Provider[] {
  const from = ASSET[fromId], to = ASSET[toId]
  if (!from || !to || from.id === to.id) return []
  const sameNet = from.network === to.network
  const ffam = networkOf(from.id).family
  const out: Provider[] = []
  if (from.network === 'solana' && to.network === 'solana') out.push('jupiter')
  if (KYBER_CHAIN[from.network] && sameNet) out.push('kyber', 'paraswap')
  if (poolAsset('thorchain', from) && poolAsset('thorchain', to)) out.push('thorchain')
  if (poolAsset('maya', from) && poolAsset('maya', to)) out.push('maya')
  const tfam = networkOf(to.id).family
  if (LIFI_CHAIN[from.network] && LIFI_CHAIN[to.network] && !sameNet && (ffam === 'evm' || ffam === 'sol') && (tfam === 'evm' || tfam === 'sol') && lifiToken(from) && lifiToken(to)) out.push('lifi')
  if ((from.id === 'xmr' || to.id === 'xmr') && wagyuAsset(from) && wagyuAsset(to)) out.push('wagyu')
  return out
}

// ---------- getting anywhere from anywhere ----------
// No single protocol covers every pair Astrala lists: Monero only reaches Bitcoin and a few majors,
// THORChain has no Arbitrum/Optimism/Polygon pools, LI.FI has no Tron. Rather than telling the user
// "no route", find the shortest chain of swaps that does exist. Every pair is reachable in two legs.

/** Can coins wait here between two swaps? Only a chain's own coin can: the next swap pays its network fee out of
 *  the same balance. A token (USDC on Ethereum, USDT on Tron) would sit in a one-time wallet holding no gas, unable
 *  to move on. Monero is excluded too: its wallet only syncs for the account the user is looking at. */
export const canStage = (id: string) => ASSET[id]?.kind === 'native' && networkOf(id).family !== 'xmr'

/** Coins deep enough to land in mid-route. Ordered: ties in path length break towards the top. */
export const PIVOTS = ['btc', 'eth', 'sol', 'ltc', 'bnb', 'trx']

export interface PathLeg { from: string; to: string; providers: Provider[] }
export interface SwapPath { coins: string[]; legs: PathLeg[] }

const MAX_LEGS = 4

/** Neighbours of a coin, liquid pivots first so equal-length paths prefer the deeper market. */
function neighbours(id: string): string[] {
  const out: string[] = []
  for (const p of PIVOTS) if (p !== id && directProviders(id, p).length) out.push(p)
  for (const a of ASSETS) if (a.id !== id && !PIVOTS.includes(a.id) && directProviders(id, a.id).length) out.push(a.id)
  return out
}

const legsOf = (coins: string[]): PathLeg[] =>
  coins.slice(1).map((to, i) => ({ from: coins[i], to, providers: directProviders(coins[i], to) }))

/** Shortest chain of swaps from one coin to another, or null if even multi-leg can't get there.
 *  A pair one provider already serves comes back as a single leg. */
export function findPath(fromId: string, toId: string, maxLegs = MAX_LEGS): SwapPath | null {
  if (fromId === toId) return null
  const direct = directProviders(fromId, toId)
  if (direct.length) return { coins: [fromId, toId], legs: [{ from: fromId, to: toId, providers: direct }] }

  // Breadth-first: the first time we reach the target it is by the fewest legs possible.
  const prev = new Map<string, string>([[fromId, '']])
  let frontier = [fromId]
  for (let depth = 1; depth < maxLegs && frontier.length; depth++) {
    const next: string[] = []
    for (const cur of frontier) {
      for (const n of neighbours(cur)) {
        if (prev.has(n)) continue
        prev.set(n, cur)
        if (n === toId) {
          const coins = [n]
          for (let at = cur; at; at = prev.get(at)!) coins.unshift(at)
          return { coins, legs: legsOf(coins) }
        }
        if (canStage(n)) next.push(n) // only a coin that can pay its own way onward may be a stop on the path
      }
    }
    frontier = next
  }
  return null
}

/** True when the pair needs more than one leg — the Swap screen uses this to explain itself. */
export const needsPath = (fromId: string, toId: string) => !directProviders(fromId, toId).length
