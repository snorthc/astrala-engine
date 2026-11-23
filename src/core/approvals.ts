// Token approvals (ERC-20 allowances) this wallet has granted on every EVM network, and revoking them.
// Free public RPCs only, so the scan has two halves:
//  1. every registry token (built-in + user-added) × every spender Astrala knows (its swap routers, plus the big
//     common ones), read straight from allowance(). This always finds anything an Astrala swap approved.
//  2. Approval(owner = us) logs over the most recent SCAN_BLOCKS blocks, to catch other spenders and other tokens.
//     Public nodes refuse wide or old log ranges (some need a token filter, Ethereum's serve only ~10k recent blocks),
//     so the scan stops at the first refusal and reports the window it covered. Older approvals to spenders and tokens Astrala doesn't know about can be missed. The UI says so.
// Then the current allowance of every (token, spender) pair is read and only the non-zero ones are kept.
import { encodeFunctionData, decodeFunctionResult, erc20Abi, parseAbi, getAddress, isAddress, keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bytesToHex } from '@noble/hashes/utils.js'
import { ASSET, ASSETS, NETWORKS, assetByContract } from './assets'
import { rpc } from './chain'
import { evmClient, mul, type KeyFor } from './send'
import { thorGet } from './swap'

export interface TokenApproval {
  network: string
  token: string // checksummed contract
  symbol: string
  decimals: number
  known: boolean // token is in the registry (its symbol can be trusted; an on-chain symbol() can say anything)
  spender: string // checksummed
  spenderName?: string
  allowance: string // raw, decimal string
  amount: number // in token units (meaningless when unlimited)
  unlimited: boolean // ≥ 2^255
}
export interface ApprovalScan {
  approvals: TokenApproval[]
  networks: { network: string; ok: boolean; logsFrom?: number; logsTo?: number; error?: string }[]
}
export interface RevokeRequest { network: string; token: string; spender: string }

export const SCAN_BLOCKS = 100_000
const CHUNK = 5_000
export const UNLIMITED = 2n ** 255n
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' // same address on every network Astrala supports
const MC_ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)'])
const SYMBOL_B32 = parseAbi(['function symbol() view returns (bytes32)'])

// lowercase address → name; nets limits a label to the chains where that address is known to be that contract
const SPENDERS: Record<string, { name: string; nets?: string[] }> = {
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': { name: 'KyberSwap' },
  '0x6a000f20005980200259b80c5102003040001068': { name: 'ParaSwap' },
  '0x216b4b4ba9f3e719726886d34a177484278bfcae': { name: 'ParaSwap (v5)' },
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae': { name: 'LI.FI' },
  '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146': { name: 'THORChain router', nets: ['ethereum'] },
  '0x3624525075b88b24ecc29ce226b0cec1ffcb6976': { name: 'THORChain router (old)', nets: ['ethereum'] },
  '0x00dc6100103bc402d490aee3f9a5560cbd91f1d4': { name: 'THORChain router', nets: ['base', 'avalanche'] },
  '0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b': { name: 'THORChain router', nets: ['bsc'] },
  '0xe3985e6b61b814f7cdb188766562ba71b446b46d': { name: 'Maya router', nets: ['ethereum'] },
  '0x700e97ef07219440487840dc472e7120a7ff11f4': { name: 'Maya router', nets: ['arbitrum'] },
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Uniswap Permit2' },
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { name: 'Uniswap V2 router', nets: ['ethereum'] },
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': { name: 'Uniswap router' },
  '0x1111111254eeb25477b68fb85ed929f73a960582': { name: '1inch (v5)' },
  '0x111111125421ca6dc452d289314280a0f8842a65': { name: '1inch (v6)' },
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': { name: '0x Exchange', nets: ['ethereum'] }
}
// THORChain/Maya move their routers now and then: the live ones are added on each scan (main's own lookup, never UI text)
const live: Record<string, Record<string, string>> = {}
const THOR_NET: Record<string, string> = { ETH: 'ethereum', BASE: 'base', BSC: 'bsc', AVAX: 'avalanche', ARB: 'arbitrum' }

/** Label for a spender Astrala knows on this network, or undefined. */
export function spenderName(network: string, spender: string): string | undefined {
  const a = String(spender ?? '').toLowerCase()
  const s = SPENDERS[a]
  if (s && (!s.nets || s.nets.includes(network))) return s.name
  return live[network]?.[a]
}

let liveAt = 0
async function refreshRouters() {
  if (Date.now() - liveAt < 10 * 60_000) return
  liveAt = Date.now()
  await Promise.all((['thorchain', 'maya'] as const).map(async (p) => {
    try {
      const list: any[] = await thorGet(p, 'inbound_addresses')
      for (const x of list ?? []) {
        const n = THOR_NET[x?.chain]
        if (n && typeof x.router === 'string' && isAddress(x.router)) (live[n] ??= {})[x.router.toLowerCase()] = p === 'thorchain' ? 'THORChain router' : 'Maya router'
      }
    } catch { /* the static list still applies */ }
  }))
}

const hex = (n: number) => '0x' + n.toString(16)
const topicAddr = (t: string) => getAddress('0x' + String(t).slice(-40))
// on-chain symbols are attacker-written text: printable ASCII only, short
const cleanSym = (s: string) => s.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 12) || '???'

/** Many eth_calls in one request via Multicall3; a failed call comes back as null. */
async function multicall(network: string, calls: { target: string; data: Hex }[]): Promise<(Hex | null)[]> {
  const out: (Hex | null)[] = []
  for (let i = 0; i < calls.length; i += 150) {
    const part = calls.slice(i, i + 150)
    const data = encodeFunctionData({ abi: MC_ABI, functionName: 'aggregate3', args: [part.map((c) => ({ target: getAddress(c.target), allowFailure: true, callData: c.data }))] })
    const res = await rpc(NETWORKS[network].rpc, 'eth_call', [{ to: MULTICALL3, data }, 'latest'])
    const r = decodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', data: res }) as readonly { success: boolean; returnData: Hex }[]
    out.push(...r.map((x) => (x.success && x.returnData.length >= 66 ? x.returnData : null)))
  }
  return out
}

/** Approval logs naming us as owner, newest SCAN_BLOCKS blocks, in chunks. Falls back to a token filter when the node demands one. */
async function scanLogs(network: string, owner: string, tokens: string[]) {
  const n = NETWORKS[network]
  const head = Number(await rpc(n.rpc, 'eth_blockNumber', []))
  const topics = [APPROVAL_TOPIC, '0x' + owner.slice(2).toLowerCase().padStart(64, '0')]
  const pairs: { token: string; spender: string }[] = []
  let from = head + 1, error: string | undefined, needFilter = false
  for (let to = head; to > head - SCAN_BLOCKS && to >= 0; to -= CHUNK) {
    const f = Math.max(0, to - CHUNK + 1, head - SCAN_BLOCKS + 1)
    const q = (address?: string[]) => rpc(n.rpc, 'eth_getLogs', [{ fromBlock: hex(f), toBlock: hex(to), topics, ...(address ? { address } : {}) }])
    let logs: any[]
    try {
      if (needFilter) throw new Error('filter')
      logs = await q()
    } catch (e: any) {
      if (!tokens.length) { error = String(e?.message ?? e).slice(0, 120); break }
      try { logs = await q(tokens); needFilter = true } catch (e2: any) { error = String(e2?.message ?? e2).slice(0, 120); break }
    }
    for (const l of logs ?? []) if (l?.address && l.topics?.length >= 3) pairs.push({ token: getAddress(l.address), spender: topicAddr(l.topics[2]) })
    from = f
  }
  return { pairs, from, to: head, error, filtered: needFilter }
}

async function scanNetwork(network: string, owner: string): Promise<{ approvals: TokenApproval[]; info: ApprovalScan['networks'][number] }> {
  const tokens = ASSETS.filter((a) => a.network === network && a.kind === 'token' && a.contract).map((a) => getAddress(a.contract!))
  const spenders = Object.keys(SPENDERS).concat(Object.keys(live[network] ?? {})).filter((s) => spenderName(network, s)).map((s) => getAddress(s))
  const pairs = new Map<string, { token: string; spender: string }>()
  const add = (token: string, spender: string) => pairs.set(`${token.toLowerCase()}:${spender.toLowerCase()}`, { token, spender })
  for (const t of tokens) for (const s of spenders) add(t, s)
  const logs = await scanLogs(network, owner, tokens).catch((e: any) => ({ pairs: [], from: undefined, to: undefined, error: String(e?.message ?? e).slice(0, 120), filtered: false }))
  for (const p of logs.pairs) add(p.token, p.spender)
  const list = [...pairs.values()]
  const res = await multicall(network, list.map((p) => ({ target: p.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [owner as Hex, p.spender as Hex] }) })))
  const held = list.map((p, i) => ({ ...p, allowance: res[i] ? BigInt(res[i]!.slice(0, 66)) : 0n })).filter((p) => p.allowance > 0n)
  // symbol + decimals: from the registry when we know the token, otherwise asked on-chain (and marked as unverified)
  const unknown = [...new Set(held.filter((p) => !assetByContract(network, p.token)).map((p) => p.token))]
  const meta = new Map<string, { symbol: string; decimals: number }>()
  if (unknown.length) {
    const r = await multicall(network, unknown.flatMap((t) => [{ target: t, data: encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' }) }, { target: t, data: encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }) }])).catch(() => [] as (Hex | null)[])
    unknown.forEach((t, i) => {
      const s = r[i * 2], d = r[i * 2 + 1]
      let symbol = '???'
      if (s) {
        try { symbol = cleanSym(decodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', data: s }) as string) } catch {
          try { symbol = cleanSym(Buffer.from((decodeFunctionResult({ abi: SYMBOL_B32, functionName: 'symbol', data: s }) as string).slice(2), 'hex').toString('latin1')) } catch { /* keep ??? */ }
        }
      }
      const dec = d ? Number(BigInt(d.slice(0, 66))) : 18
      meta.set(t, { symbol, decimals: dec >= 0 && dec <= 36 ? dec : 18 })
    })
  }
  const approvals = held.map((p): TokenApproval => {
    const a = assetByContract(network, p.token)
    const m = a ? { symbol: a.symbol, decimals: a.decimals } : meta.get(p.token) ?? { symbol: '???', decimals: 18 }
    return { network, token: p.token, symbol: m.symbol, decimals: m.decimals, known: !!a, spender: p.spender, spenderName: spenderName(network, p.spender), allowance: p.allowance.toString(), amount: Number(p.allowance) / 10 ** m.decimals, unlimited: p.allowance >= UNLIMITED }
  })
  // ok = the log scan covered at least one chunk; error says why it stopped early (e.g. the node won't serve older blocks)
  return { approvals, info: { network, ok: logs.from != null && logs.to != null && logs.from <= logs.to, logsFrom: logs.from, logsTo: logs.to, error: logs.error } }
}

/** Every non-zero ERC-20 allowance `owner` has granted, across all EVM networks. Read-only. */
export async function scanApprovals(owner: string, networks = Object.values(NETWORKS).filter((n) => n.family === 'evm').map((n) => n.id)): Promise<ApprovalScan> {
  if (!isAddress(owner)) throw new Error('Not an EVM address')
  await refreshRouters()
  const per = await Promise.all(networks.map((n) => scanNetwork(n, getAddress(owner)).catch((e: any) => ({ approvals: [] as TokenApproval[], info: { network: n, ok: false, error: String(e?.message ?? e).slice(0, 120) } }))))
  return { approvals: per.flatMap((p) => p.approvals), networks: per.map((p) => p.info) }
}

/** Revoke one approval: approve(spender, 0) on the token contract, signed here with our EVM key. */
export async function revokeApproval(req: RevokeRequest, from: string, keyFor: KeyFor, dry = false): Promise<{ txid: string; raw?: string }> {
  const n = NETWORKS[req?.network]
  if (n?.family !== 'evm') throw new Error('Approvals exist only on EVM networks')
  if (!isAddress(req.token) || !isAddress(req.spender)) throw new Error("That isn't a valid contract address")
  const token = getAddress(req.token), spender = getAddress(req.spender), owner = getAddress(from)
  const c = evmClient(req.network)
  const current = await c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
  if (current === 0n) throw new Error('Already revoked, nothing to do')
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] })
  const [fees, nonce, bal] = await Promise.all([c.estimateFeesPerGas(), c.getTransactionCount({ address: owner, blockTag: 'pending' }), c.getBalance({ address: owner })])
  let gas: bigint
  try { gas = mul(await c.estimateGas({ account: owner, to: token, data }), 1.3) } catch { gas = 70_000n }
  const maxPriorityFeePerGas = mul(fees.maxPriorityFeePerGas, 1.1)
  const maxFeePerGas = mul(fees.maxFeePerGas, 1.15) > maxPriorityFeePerGas ? mul(fees.maxFeePerGas, 1.15) : maxPriorityFeePerGas
  if (bal < gas * maxFeePerGas) throw new Error(`You need a little ${ASSET[n.native].symbol} on ${n.name} to pay the network fee`)
  const { priv } = keyFor('evm')
  try {
    const account = privateKeyToAccount(`0x${bytesToHex(priv)}`)
    if (account.address !== owner) throw new Error('Key mismatch')
    const signed = await account.signTransaction({ chainId: n.chainId!, type: 'eip1559', nonce, gas, maxFeePerGas, maxPriorityFeePerGas, to: token, value: 0n, data })
    if (dry) return { txid: `dry:revoke:${keccak256(signed)}`, raw: signed }
    return { txid: await c.sendRawTransaction({ serializedTransaction: signed }) }
  } finally { priv.fill(0) }
}
