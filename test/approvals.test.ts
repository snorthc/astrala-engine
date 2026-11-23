// Token approvals against a fake set of EVM nodes: the real scan (Multicall3 allowance reads + Approval logs) and the
// real revoke signer run; every "node" is answered here. Revokes are dry: signed, decoded, never broadcast.
import { describe, it, expect, beforeEach } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, erc20Abi, parseAbi, parseTransaction, recoverTransactionAddress, getAddress } from 'viem'
import { setFetcher } from '../src/core/chain'
import { NETWORKS } from '../src/core/assets'
import { deriveAccount, signingKey } from '../src/core/derive'
import { scanApprovals, revokeApproval, spenderName, MULTICALL3 } from '../src/core/approvals'

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const me = getAddress(deriveAccount(M, 0).find((a) => a.chain === 'evm')!.address)
const keyFor = (f: any) => signingKey(M, f, 0)

const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const USDT_ARB = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
const KYBER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', PARASWAP = '0x6A000F20005980200259B80c5102003040001068', LIFI = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const FOO = '0x00000000000000000000000000000000000F0F0F' // a token Astrala has never heard of, found only through logs
const STRANGER = '0x000000000000000000000000000000000000bEEF'
const THOR_LIVE = '0x0000000000000000000000000000000000007408' // a router THORChain only announces live
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
const MC_ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)'])

let allow: Record<string, bigint> = {}
let sent: string[] = []
let getLogsCalls: { network: string; filtered: boolean }[] = []
const k = (network: string, token: string, spender: string) => `${network}:${token.toLowerCase()}:${spender.toLowerCase()}`
const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } })
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16)
const topic = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
const log = (token: string, spender: string) => ({ address: token.toLowerCase(), topics: [APPROVAL, topic(me), topic(spender)], data: '0x', blockNumber: '0x1' })

function call(network: string, to: string, data: `0x${string}`): `0x${string}` | null {
  if (to.toLowerCase() === FOO.toLowerCase()) {
    const d = decodeFunctionData({ abi: erc20Abi, data })
    if (d.functionName === 'symbol') return encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'FOO‮' }) // hidden bidi char gets stripped
    if (d.functionName === 'decimals') return encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 9 })
  }
  const d = decodeFunctionData({ abi: erc20Abi, data })
  if (d.functionName === 'allowance') {
    expect(getAddress(d.args[0] as string)).toBe(me) // always asks about our own address
    return encodeAbiParameters([{ type: 'uint256' }], [allow[k(network, to, d.args[1] as string)] ?? 0n])
  }
  return null
}

function rpc(network: string, chainId: number, m: string, p: any[]): unknown {
  switch (m) {
    case 'eth_chainId': return hex(chainId)
    case 'eth_blockNumber': return hex(1_000_000)
    case 'eth_getLogs': {
      const q = p[0], filtered = Array.isArray(q.address)
      getLogsCalls.push({ network, filtered })
      expect(q.topics[0]).toBe(APPROVAL)
      expect(q.topics[1]).toBe(topic(me))
      expect(Number(q.toBlock) - Number(q.fromBlock)).toBeLessThan(5_000) // chunked
      // Ethereum's node insists on a token filter; Arbitrum's answers the open query
      if (network === 'ethereum' && !filtered) throw Object.assign(new Error('Please specify an address in your request'), { rpc: true })
      if (Number(q.toBlock) !== 1_000_000) return []
      if (network === 'ethereum') return [log(USDT_ETH, LIFI)].filter((l) => q.address.map((a: string) => a.toLowerCase()).includes(l.address)) // revoked since: allowance 0 now
      if (network === 'arbitrum') return [log(FOO, STRANGER)]
      return []
    }
    case 'eth_call': {
      const { to, data } = p[0]
      if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
        const d = decodeFunctionData({ abi: MC_ABI, data })
        const results = (d.args[0] as readonly { target: string; callData: `0x${string}` }[]).map((c) => { const r = call(network, c.target, c.callData); return { success: r != null, returnData: r ?? '0x' } })
        return encodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', result: results as any })
      }
      return call(network, to, data) ?? '0x'
    }
    case 'eth_getBalance': return hex(10n ** 18n)
    case 'eth_estimateGas': return hex(46_000)
    case 'eth_maxPriorityFeePerGas': return hex(1_000_000_000)
    case 'eth_gasPrice': return hex(20_000_000_000)
    case 'eth_getBlockByNumber': return { baseFeePerGas: hex(10_000_000_000), number: '0x1', hash: '0x' + '1'.repeat(64), timestamp: '0x1', transactions: [] }
    case 'eth_getTransactionCount': return '0x9'
    case 'eth_sendRawTransaction': sent.push(p[0]); return '0x' + 'ab'.repeat(32)
  }
  throw new Error('unhandled ' + m)
}

async function fake(url: string, init?: RequestInit): Promise<Response> {
  if (url.includes('/inbound_addresses')) return ok(url.includes('thorchain') ? [{ chain: 'ETH', router: THOR_LIVE }, { chain: 'BTC' }] : [])
  const n = Object.values(NETWORKS).find((x) => x.family === 'evm' && x.rpc.some((r) => url.startsWith(r)))
  if (!n) throw new Error('unexpected network call ' + url)
  if (n.id === 'avalanche') return new Response('down', { status: 503 }) // one chain down must not sink the rest
  const j = JSON.parse(String(init?.body))
  const one = (x: any) => { try { return { jsonrpc: '2.0', id: x.id, result: rpc(n.id, n.chainId!, x.method, x.params ?? []) } } catch (e: any) { if (!e.rpc) throw e; return { jsonrpc: '2.0', id: x.id, error: { code: -32701, message: e.message } } } }
  return ok(Array.isArray(j) ? j.map(one) : one(j))
}

beforeEach(() => {
  setFetcher(fake as any)
  sent = []; getLogsCalls = []
  allow = {
    [k('ethereum', USDC_ETH, KYBER)]: 2n ** 256n - 1n,
    [k('ethereum', USDT_ETH, LIFI)]: 0n,
    [k('ethereum', USDT_ETH, THOR_LIVE)]: 5_000_000n,
    [k('arbitrum', USDT_ARB, PARASWAP)]: 250_000_000n,
    [k('arbitrum', FOO, STRANGER)]: 7n * 10n ** 9n
  }
})

describe('token approvals: scan', () => {
  it('keeps only non-zero allowances, labels known routers, flags unlimited', async () => {
    const r = await scanApprovals(me)
    const by = (net: string, token: string) => r.approvals.find((a) => a.network === net && a.token.toLowerCase() === token.toLowerCase())
    expect(r.approvals).toHaveLength(4)
    expect(r.approvals.every((a) => BigInt(a.allowance) > 0n)).toBe(true)
    expect(by('ethereum', USDC_ETH)).toMatchObject({ symbol: 'USDC', known: true, spender: KYBER, spenderName: 'KyberSwap', unlimited: true })
    expect(by('arbitrum', USDT_ARB)).toMatchObject({ symbol: 'USDT', spenderName: 'ParaSwap', amount: 250, unlimited: false })
    // only on Ethereum, and only through THORChain's live list
    expect(r.approvals.find((a) => a.spender === getAddress(THOR_LIVE))).toMatchObject({ network: 'ethereum', symbol: 'USDT', spenderName: 'THORChain router', amount: 5 })
    // an unknown token and spender found through the logs: on-chain symbol (cleaned), not labelled, not "known"
    expect(by('arbitrum', FOO)).toMatchObject({ symbol: 'FOO', decimals: 9, known: false, spender: getAddress(STRANGER), amount: 7, unlimited: false })
    expect(by('arbitrum', FOO)!.spenderName).toBeUndefined()
    // the USDT → LI.FI approval shows in the logs but is 0 now: dropped
    expect(r.approvals.some((a) => a.spender === LIFI)).toBe(false)
  })

  it('reports the scanned window per network, falls back to a token filter, and survives a dead node', async () => {
    const r = await scanApprovals(me)
    const eth = r.networks.find((n) => n.network === 'ethereum')!
    expect(eth).toMatchObject({ ok: true, logsTo: 1_000_000 })
    expect(eth.logsTo! - eth.logsFrom! + 1).toBe(100_000)
    expect(getLogsCalls.some((c) => c.network === 'ethereum' && c.filtered)).toBe(true)
    expect(getLogsCalls.filter((c) => c.network === 'arbitrum').every((c) => !c.filtered)).toBe(true)
    expect(r.networks.find((n) => n.network === 'avalanche')!.ok).toBe(false)
    expect(r.networks).toHaveLength(7)
  })

  it('knows its spenders only on the chains where they live', () => {
    expect(spenderName('ethereum', KYBER.toLowerCase())).toBe('KyberSwap')
    expect(spenderName('bsc', '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146')).toBeUndefined() // the Ethereum THORChain router
    expect(spenderName('ethereum', STRANGER)).toBeUndefined()
  })
})

describe('token approvals: revoke', () => {
  it('signs approve(spender, 0) to the token contract from our address, never broadcast', async () => {
    const r = await revokeApproval({ network: 'ethereum', token: USDC_ETH.toLowerCase(), spender: KYBER.toLowerCase() }, me, keyFor, true)
    expect(sent).toHaveLength(0)
    expect(r.txid).toMatch(/^dry:revoke:0x/)
    const raw = r.raw as `0x02${string}`
    const tx = parseTransaction(raw)
    expect(await recoverTransactionAddress({ serializedTransaction: raw })).toBe(me)
    expect(getAddress(tx.to!)).toBe(USDC_ETH)
    expect(tx.value ?? 0n).toBe(0n)
    expect(tx.chainId).toBe(1)
    expect(tx.nonce).toBe(9)
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.data! })
    expect(d.functionName).toBe('approve')
    expect(getAddress(d.args[0] as string)).toBe(KYBER)
    expect(d.args[1]).toBe(0n)
  })

  it('refuses when there is nothing to revoke, on non-EVM networks and with bad addresses', async () => {
    await expect(revokeApproval({ network: 'ethereum', token: USDT_ETH, spender: LIFI }, me, keyFor, true)).rejects.toThrow(/Already revoked/)
    await expect(revokeApproval({ network: 'solana', token: USDC_ETH, spender: KYBER }, me, keyFor, true)).rejects.toThrow(/EVM/)
    await expect(revokeApproval({ network: 'ethereum', token: 'nope', spender: KYBER }, me, keyFor, true)).rejects.toThrow(/valid/)
    expect(sent).toHaveLength(0)
  })
})
