// Find any token by name, symbol or pasted contract, and read its real metadata on-chain before it is added.
// Runs in the main process; every request goes through the routed `net` (Tor / proxy / kill switch).
import { hexToString } from 'viem'
import { ASSETS, NETWORKS, TOKEN_NETWORKS, assetByContract, type CustomToken } from './assets'
import { getJson, rpc, net, CG_PLATFORM } from './chain'

export interface TokenHit {
  name: string
  symbol: string
  logo?: string // remote URL, shown only after main has fetched it (see fetchLogo)
  cg?: string
  network?: string // absent = the coin lives on a chain Astrala can't hold yet
  contract?: string
  decimals?: number
  verified: boolean
  existing?: string // asset id already in the wallet
  unsupported?: boolean
}

const CG = 'https://api.coingecko.com/api/v3'
const NET_OF_PLATFORM = Object.fromEntries(Object.entries(CG_PLATFORM).map(([n, p]) => [p, n]))
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS5EPFLC1PEuoXuN8KCnt5Wb'

/** What kind of address the user pasted, if any. */
export function addressKind(q: string): 'evm' | 'trx' | 'sol' | null {
  q = q.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return 'evm'
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(q)) return 'trx'
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) return 'sol'
  return null
}

// ---------- on-chain metadata ----------
// ABI string return, or the old bytes32 style (MKR, SAI).
function abiString(hex: string): string {
  const h = hex.replace(/^0x/, '')
  if (!h) return ''
  if (h.length === 64) return hexToString(`0x${h}`).replace(/\0+$/, '')
  const len = parseInt(h.slice(64, 128), 16)
  return hexToString(`0x${h.slice(128, 128 + len * 2)}`)
}
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max)

async function evmMeta(network: string, contract: string) {
  const call = (data: string) => rpc(NETWORKS[network].rpc, 'eth_call', [{ to: contract, data }, 'latest'])
  const [d, s, n] = await Promise.all([call('0x313ce567'), call('0x95d89b41'), call('0x06fdde03').catch(() => '0x')])
  if (!d || d === '0x') throw new Error('Not a token')
  const decimals = Number(BigInt(d))
  const symbol = clean(abiString(s), 16)
  if (!symbol || decimals > 36) throw new Error('Not a token')
  return { decimals, symbol, name: clean(abiString(n), 48) || symbol }
}

async function tronMeta(contract: string) {
  const call = async (fn: string) => {
    const r = await getJson(`${NETWORKS.tron.rpc[0]}/wallet/triggerconstantcontract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner_address: contract, contract_address: contract, function_selector: fn, visible: true }) })
    return r?.constant_result?.[0] as string | undefined
  }
  const [d, s, n] = await Promise.all([call('decimals()'), call('symbol()'), call('name()')])
  if (!d) throw new Error('Not a token')
  const decimals = Number(BigInt(`0x${d}`))
  const symbol = clean(abiString(s ?? ''), 16)
  if (!symbol || decimals > 36) throw new Error('Not a token')
  return { decimals, symbol, name: clean(abiString(n ?? ''), 48) || symbol }
}

async function solMint(mint: string) {
  const r = await rpc(NETWORKS.solana.rpc, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }])
  const v = r?.value
  if (!v || v.data?.parsed?.type !== 'mint') throw new Error('Not a token')
  return { decimals: Number(v.data.parsed.info.decimals), program: String(v.owner) }
}
const jupiter = async (q: string): Promise<any[]> => getJson(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`).catch(() => [])

/**
 * The source of truth before saving: decimals and symbol come from the chain, never from a search API,
 * so a wrong listing can't make the wallet mis-scale amounts.
 */
export async function readToken(network: string, contract: string): Promise<Pick<CustomToken, 'decimals' | 'symbol' | 'name'>> {
  if (!TOKEN_NETWORKS.includes(network)) throw new Error('Astrala can’t hold tokens on this network yet')
  const fam = NETWORKS[network].family
  if (fam === 'evm') { if (addressKind(contract) !== 'evm') throw new Error('Not a valid contract address'); return evmMeta(network, contract) }
  if (fam === 'trx') { if (addressKind(contract) !== 'trx') throw new Error('Not a valid TRC-20 address'); return tronMeta(contract) }
  if (addressKind(contract) !== 'sol') throw new Error('Not a valid Solana mint')
  const m = await solMint(contract)
  // shortcut: send/balance use the classic SPL program; upgrade when Token-2022 transfers are wired in send.ts
  if (m.program === TOKEN_2022) throw new Error('Token-2022 tokens aren’t supported yet')
  const j = (await jupiter(contract)).find((t) => t.id === contract)
  return { decimals: m.decimals, symbol: clean(j?.symbol ?? contract.slice(0, 4), 16), name: clean(j?.name ?? 'Unknown token', 48) }
}

// ---------- search ----------
const existingFor = (network: string, contract: string) => assetByContract(network, contract)?.id

async function byAddress(q: string): Promise<TokenHit[]> {
  const kind = addressKind(q)
  const nets = kind === 'evm' ? TOKEN_NETWORKS.filter((n) => NETWORKS[n].family === 'evm') : kind === 'trx' ? ['tron'] : ['solana']
  const hits = await Promise.all(nets.map(async (network): Promise<TokenHit | null> => {
    const meta = await readToken(network, q).catch(() => null)
    if (!meta) return null
    let cg: any = null
    if (network === 'solana') {
      const j = (await jupiter(q)).find((t) => t.id === q)
      if (j) return { network, contract: q, ...meta, logo: j.icon, verified: !!j.isVerified, existing: existingFor(network, q) }
    } else cg = await getJson(`${CG}/coins/${CG_PLATFORM[network]}/contract/${network === 'tron' ? q : q.toLowerCase()}`).catch(() => null)
    return { network, contract: q, ...meta, cg: cg?.id, logo: cg?.image?.small, verified: !!cg?.id, existing: existingFor(network, q) }
  }))
  return hits.filter((h): h is TokenHit => !!h)
}

const details = new Map<string, Promise<any>>()
const coinDetails = (id: string) => {
  if (!details.has(id)) details.set(id, getJson(`${CG}/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`).catch(() => { details.delete(id); return null }))
  return details.get(id)!
}

async function byName(q: string): Promise<TokenHit[]> {
  const [cg, jup] = await Promise.all([getJson(`${CG}/search?query=${encodeURIComponent(q)}`).catch(() => null), jupiter(q)])
  const coins: any[] = (cg?.coins ?? []).slice(0, 6)
  const out: TokenHit[] = []
  await Promise.all(coins.map(async (c, i) => {
    const native = ASSETS.filter((a) => a.cg === c.id && !a.custom)
    if (native.length) { out.push({ name: c.name, symbol: c.symbol, logo: c.thumb, cg: c.id, verified: true, existing: native[0].id, _o: i } as any); return }
    const d = await coinDetails(c.id)
    const plats = Object.entries(d?.detail_platforms ?? {}).filter(([p, v]: any) => NET_OF_PLATFORM[p] && v?.contract_address)
    if (!plats.length) { out.push({ name: c.name, symbol: c.symbol, logo: c.thumb, cg: c.id, verified: true, unsupported: true, _o: i } as any); return }
    for (const [p, v] of plats as [string, any][]) {
      const network = NET_OF_PLATFORM[p]
      out.push({ name: c.name, symbol: c.symbol.toUpperCase(), logo: d?.image?.small ?? c.thumb, cg: c.id, network, contract: v.contract_address, decimals: v.decimal_place ?? undefined, verified: true, existing: existingFor(network, v.contract_address), _o: i } as any)
    }
  }))
  // Solana tokens CoinGecko doesn't list (memecoins); Jupiter's verified flag marks the real one
  for (const j of jup.slice(0, 4)) {
    // unverified look-alikes only show up when the user pastes the exact mint
    if (!j.isVerified || out.some((h) => h.network === 'solana' && h.contract === j.id) || j.tokenProgram === TOKEN_2022) continue
    out.push({ name: j.name, symbol: j.symbol, logo: j.icon, network: 'solana', contract: j.id, decimals: j.decimals, verified: !!j.isVerified, existing: existingFor('solana', j.id), _o: 50 } as any)
  }
  return out.sort((a: any, b: any) => a._o - b._o).map(({ _o, ...h }: any) => h)
}

// CoinGecko's free tier throttles hard; repeat searches (typing, backspacing) are served from here
const searches = new Map<string, { at: number; hits: TokenHit[] }>()
export async function searchTokens(q: string): Promise<TokenHit[]> {
  q = q.trim()
  if (q.length < 2) return []
  const key = addressKind(q) ? q : q.toLowerCase(), hit = searches.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.hits.map((h) => ({ ...h, existing: h.network && h.contract ? existingFor(h.network, h.contract) : h.existing }))
  const hits = addressKind(q) ? await byAddress(q) : await byName(q)
  if (hits.length) searches.set(key, { at: Date.now(), hits: hits.map((h) => ({ ...h })) })
  return hits
}

/** Fetch a token logo once, through the routed network, and keep it as a small data URL (no remote image loads in the UI). */
export async function fetchLogo(url?: string): Promise<string | undefined> {
  if (!url || !/^https:\/\//.test(url)) return undefined
  try {
    const r = await net(url)
    const type = r.headers.get('content-type') ?? ''
    if (!r.ok || !/^image\/(png|jpe?g|webp|gif|svg\+xml)/.test(type)) return undefined
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 60_000 || /svg/.test(type)) return undefined // svg can carry script; skip it
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`
  } catch { return undefined }
}
