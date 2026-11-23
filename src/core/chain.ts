// Read-only network layer: balances, prices, history, tx status. Every request goes through `net()`
// so milestone 4 can route all of it through Astral Route (Tor) or a proxy, with a kill switch, in one place.
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from './spl'
import { ASSETS, NETWORKS, coingeckoIds, type Asset, type Family } from './assets'

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
let fetcher: Fetcher = (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(20000) })
export const setFetcher = (f: Fetcher) => { fetcher = f }
export const net: Fetcher = (u, i) => fetcher(u, i)

export interface Balance { asset: string; amount: number | null; status: 'ok' | 'error' | 'syncing'; note?: string }
export interface PriceInfo { price: number; change24h: number }
export type Addresses = Partial<Record<Family, string>>

export async function getJson(url: string, init?: RequestInit): Promise<any> {
  const r = await net(url, init)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/** JSON-RPC with endpoint fallback, so one rate-limited node never blanks a balance. */
// each launch starts at a random node in every list, so one provider never sees all of this wallet's traffic every session
const SESSION_SPIN = Math.floor(Math.random() * 1000)
export async function rpc(urls: string[], method: string, params: unknown[]): Promise<any> {
  let last: unknown
  const k = SESSION_SPIN % (urls.length || 1)
  for (const url of [...urls.slice(k), ...urls.slice(0, k)]) {
    try {
      const j = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      if (j.error) throw new Error(j.error.message)
      return j.result
    } catch (e) { last = e }
  }
  throw last
}

const units = (raw: bigint | number | string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals

async function esplora(base: string, address: string): Promise<bigint> {
  const j = await getJson(`${base}/api/address/${address}`)
  return BigInt(j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum + j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum)
}

// Fetch all EVM assets for one network in parallel (one call per asset, all fired at once).
// The once() cache means multiple getBalance() calls for the same network share one inflight batch.
const evmNetworkBalances = (network: string, assets: Asset[], owner: string): Promise<Record<string, number | null>> =>
  once(`evm:${network}:${owner}`, () => retry(async () => {
    const net = NETWORKS[network]
    const balOf = '0x70a08231' + owner.slice(2).toLowerCase().padStart(64, '0')
    const results = await Promise.all(assets.map(async (a) => {
      try {
        if (a.kind === 'native') return units(await rpc(net.rpc, 'eth_getBalance', [owner, 'latest']), a.decimals)
        const res: string = await rpc(net.rpc, 'eth_call', [{ to: a.contract, data: balOf }, 'latest'])
        return units(res === '0x' ? 0 : res, a.decimals)
      } catch { return null }
    }))
    const out: Record<string, number | null> = {}
    assets.forEach((a, i) => { out[a.id] = results[i] })
    return out
  }))

async function evmBalance(a: Asset, owner: string): Promise<number> {
  const evmAssets = ASSETS.filter((x) => x.network === a.network)
  const batch = await evmNetworkBalances(a.network, evmAssets, owner)
  const val = batch[a.id]
  if (val === null) throw new Error('evmBalance failed')
  return val
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e) { if (i >= tries - 1) throw e; await sleep(600 * (i + 1)) }
  }
}

// One shared in-flight request per owner, so several tokens on one chain cost a single call.
const shared = new Map<string, { at: number; p: Promise<any> }>()
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = shared.get(key)
  if (hit && Date.now() - hit.at < 8000) return hit.p
  const p = fn().catch((e) => { shared.delete(key); throw e })
  shared.set(key, { at: Date.now(), p })
  return p
}

// Token balances via the owner's associated token accounts (non-indexed call; public RPCs answer it reliably).
const solTokens = (owner: string): Promise<Record<string, number>> => once(`sol:${owner}`, () => retry(async () => {
  const mints = ASSETS.filter((a) => a.network === 'solana' && a.kind === 'token').map((a) => a.contract!)
  const atas = mints.map((m) => getAssociatedTokenAddressSync(new PublicKey(m), new PublicKey(owner)).toBase58())
  const res = await rpc(NETWORKS.solana.rpc, 'getMultipleAccounts', [atas, { encoding: 'jsonParsed' }])
  const map: Record<string, number> = {}
  res.value.forEach((acc: any, i: number) => { map[mints[i]] = acc ? Number(acc.data.parsed.info.tokenAmount.uiAmountString) : 0 })
  return map
}))

const tronAccount = (owner: string): Promise<any> => once(`trx:${owner}`, () => retry(async () => (await getJson(`${NETWORKS.tron.rpc[0]}/v1/accounts/${owner}`)).data?.[0] ?? null))

export async function getBalance(a: Asset, addrs: Addresses): Promise<Balance> {
  const fam = NETWORKS[a.network].family
  const owner = addrs[fam]
  if (fam === 'xmr') return { asset: a.id, amount: null, status: 'syncing' } // view-key scanning: next milestone
  if (!owner) return { asset: a.id, amount: null, status: 'error' }
  try {
    let amount = 0
    switch (fam) {
      case 'btc': amount = units(await retry(() => esplora(NETWORKS.bitcoin.rpc[0], owner)), 8); break
      case 'ltc': amount = units(await retry(() => esplora(NETWORKS.litecoin.rpc[0], owner)), 8); break
      case 'doge': amount = units((await retry(() => getJson(`${NETWORKS.dogecoin.rpc[0]}/addrs/${owner}/balance`))).final_balance, 8); break
      case 'evm': amount = await retry(() => evmBalance(a, owner)); break
      case 'sol':
        amount = a.kind === 'native' ? units((await retry(() => rpc(NETWORKS.solana.rpc, 'getBalance', [owner]))).value, 9) : (await solTokens(owner))[a.contract!] ?? 0
        break
      case 'trx': {
        const acc = await tronAccount(owner)
        if (!acc) amount = 0
        else if (a.kind === 'native') amount = units(acc.balance ?? 0, 6)
        else { const row = (acc.trc20 ?? []).find((r: Record<string, string>) => r[a.contract!]); amount = row ? units(row[a.contract!], a.decimals) : 0 }
        break
      }
    }
    return { asset: a.id, amount, status: 'ok' }
  } catch {
    return { asset: a.id, amount: null, status: 'error' }
  }
}

/** All balances, with modest concurrency so public endpoints don't rate-limit us. */
/** onOne fires per asset the moment that asset answers, so the interface can show each coin as it
 *  lands rather than waiting on the slowest chain — one dead RPC used to hold up the whole balance. */
export async function getAllBalances(addrs: Addresses, onOne?: (b: Balance) => void): Promise<Balance[]> {
  const out: Balance[] = []
  const queue = [...ASSETS]
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const a = queue.shift()!
      const b = await getBalance(a, addrs)
      out.push(b)
      try { onOne?.(b) } catch { /* a listener must never stall the remaining reads */ }
    }
  }))
  return out
}

/** CoinGecko platform id for each network that can hold tokens. */
export const CG_PLATFORM: Record<string, string> = { ethereum: 'ethereum', arbitrum: 'arbitrum-one', base: 'base', optimism: 'optimistic-ethereum', polygon: 'polygon-pos', bsc: 'binance-smart-chain', avalanche: 'avalanche', solana: 'solana', tron: 'tron' }

const tokenPrices = new Map<string, { at: number; p: PriceInfo }>()

export async function getPrices(currency: string): Promise<Record<string, PriceInfo> | null> {
  try {
    const cur = currency.toLowerCase()
    const ids = coingeckoIds()
    const j = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=${cur}&include_24hr_change=true`)
    const out: Record<string, PriceInfo> = {}
    for (const id of ids) out[id] = { price: j[id]?.[cur] ?? 0, change24h: j[id]?.[`${cur}_24h_change`] ?? 0 }
    // unlisted custom tokens: priced by contract (the free API takes one contract per call, so cache for 2 min)
    await Promise.all(ASSETS.filter((a) => a.cg.startsWith('ct:')).map(async (a) => {
      const key = `${a.cg}:${cur}`, hit = tokenPrices.get(key)
      if (hit && Date.now() - hit.at < 120_000) { out[a.cg] = hit.p; return }
      const t = await getJson(`https://api.coingecko.com/api/v3/simple/token_price/${CG_PLATFORM[a.network]}?contract_addresses=${a.contract}&vs_currencies=${cur}&include_24hr_change=true`).catch(() => null)
      if (!t && hit) { out[a.cg] = hit.p; return } // rate-limited: keep the last price rather than showing $0
      const r: any = t && Object.entries(t).find(([k]) => k.toLowerCase() === a.contract!.toLowerCase())?.[1]
      out[a.cg] = { price: r?.[cur] ?? 0, change24h: r?.[`${cur}_24h_change`] ?? 0 }
      if (t) tokenPrices.set(key, { at: Date.now(), p: out[a.cg] })
    }))
    return out
  } catch {
    return null
  }
}

export async function getHistory(cg: string, currency: string, days: number): Promise<[number, number][]> {
  try {
    const [, network, contract] = cg.startsWith('ct:') ? cg.split(':') : []
    const path = network ? `coins/${CG_PLATFORM[network]}/contract/${contract}` : `coins/${cg}`
    return (await getJson(`https://api.coingecko.com/api/v3/${path}/market_chart?vs_currency=${currency.toLowerCase()}&days=${days}`)).prices ?? []
  } catch {
    return []
  }
}

export type TxState = 'pending' | 'confirmed' | 'failed'
/** Where a broadcast transaction is: pending → confirmed (or failed). */
export async function txStatus(network: string, txid: string): Promise<TxState> {
  const n = NETWORKS[network]
  try {
    switch (n.family) {
      case 'btc': case 'ltc': return (await getJson(`${n.rpc[0]}/api/tx/${txid}/status`)).confirmed ? 'confirmed' : 'pending'
      case 'doge': return ((await getJson(`${n.rpc[0]}/txs/${txid}`)).confirmations ?? 0) > 0 ? 'confirmed' : 'pending'
      case 'evm': { const r = await rpc(n.rpc, 'eth_getTransactionReceipt', [txid]); return !r ? 'pending' : r.status === '0x1' ? 'confirmed' : 'failed' }
      case 'sol': { const r = (await rpc(n.rpc, 'getSignatureStatuses', [[txid], { searchTransactionHistory: true }])).value[0]; return !r ? 'pending' : r.err ? 'failed' : r.confirmationStatus === 'finalized' || r.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending' }
      case 'trx': { const r = await getJson(`${n.rpc[0]}/wallet/gettransactioninfobyid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: txid }) }); return !r.id ? 'pending' : r.receipt?.result && r.receipt.result !== 'SUCCESS' ? 'failed' : 'confirmed' }
      default: return 'pending'
    }
  } catch {
    return 'pending'
  }
}
