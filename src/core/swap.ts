// Swaps: decentralized routes only, cheapest wins. No centralized exchange is ever contacted.
//   Same chain, EVM  → KyberSwap + ParaSwap aggregators (on-chain DEX liquidity)
//   Same chain, SOL  → Jupiter
//   Cross chain      → THORChain + Maya Protocol (native assets, no wrapped tokens)
// Quotes are read-only. Execution re-quotes, checks the price did not move, then signs locally.
import { parseUnits, formatUnits, encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { VersionedTransaction, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js'
import * as btc from '@scure/btc-signer'
import { bytesToHex } from '@noble/hashes/utils.js'
import { ASSET, NETWORKS, networkOf, type Asset } from './assets'
import { net, getJson, type Addresses } from './chain'
import { evmClient, solConn, utxoState, tronPost, tronSign, mul, UTXO_NET, execute as sendExecute, type KeyFor } from './send'
import { takeFee, feeAddress } from './fees'
import { KYBER_CHAIN, LIFI_CHAIN, THOR_CHAIN, MAYA_CHAIN, poolAsset, lifiToken, wagyuAsset, type Provider, type Thorlike } from './reach'

export type { Provider } from './reach'
export { poolAsset, directProviders } from './reach'

export interface SwapRequest { from: string; to: string; amount: string; slippageBps?: number; account?: number }
export interface SwapRoute {
  provider: Provider
  providerName: string
  from: string
  to: string
  amountIn: number
  amountOut: number // expected, after protocol fees
  minOut: number // worst case before the swap reverts / refunds
  networkFee: number // estimated source-chain fee, in networkFeeAsset units
  networkFeeAsset: string
  etaSec: number
  approval: boolean // ERC-20 needs an approve transaction first
  notes: string[]
  via?: string // the bridge or DEX doing the work, e.g. "Mayan" under LI.FI
  viaKey?: string
  score?: number // fiat value out minus fees, used for ranking
  ourFee?: number // Astrala's fee, in `from` units, taken from amountIn before the swap
  ourFeeBps?: number
}
export interface SwapQuote { ok: boolean; error?: string; routes: SwapRoute[] }

export const PROVIDER_NAME: Record<Provider, string> = { jupiter: 'Jupiter', kyber: 'KyberSwap', paraswap: 'ParaSwap', thorchain: 'THORChain', maya: 'Maya Protocol', lifi: 'LI.FI', wagyu: 'Wagyu' }
const NATIVE_EVM = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const THOR_BASES = ['https://gateway.liquify.com/chain/thorchain_api', 'https://thornode.ninerealms.com']
const MAYA_BASES = ['https://mayanode.mayachain.info']
const ROUTER_ABI = parseAbi(['function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration) payable'])
// Test hook: sign everything but never broadcast. Off in the app.
let DRY = false
export const _setDryRun = (on: boolean) => { DRY = on }
const dry = (what: string, payload: string) => `dry:${what}:${payload.slice(0, 400)}`
const units = (v: bigint | string, d: number) => Number(BigInt(v)) / 10 ** d

const evmToken = (a: Asset) => (a.kind === 'native' ? NATIVE_EVM : a.contract!)
const solMint = (a: Asset) => (a.kind === 'native' ? SOL_MINT : a.contract!)

// ---------- THORChain / Maya ----------
const THOR = { thorchain: { bases: THOR_BASES, path: 'thorchain' }, maya: { bases: MAYA_BASES, path: 'mayachain' } }
const poolCache: Partial<Record<Thorlike, { at: number; pools: Set<string> }>> = {}

export async function thorGet(p: Thorlike, path: string) {
  let last: unknown
  for (const b of THOR[p].bases) {
    try {
      const r = await net(`${b}/${THOR[p].path}/${path}`, { signal: AbortSignal.timeout(12000) } as RequestInit)
      const j = await r.json()
      if (!r.ok && !j?.message) throw new Error(`HTTP ${r.status}`)
      return j
    } catch (e) { last = e }
  }
  throw last
}

async function pools(p: Thorlike) {
  const c = poolCache[p]
  if (c && Date.now() - c.at < 300_000) return c.pools
  const list: any[] = await thorGet(p, 'pools')
  const set = new Set(list.filter((x) => x.status === 'Available').map((x) => String(x.asset).toUpperCase()))
  poolCache[p] = { at: Date.now(), pools: set }
  return set
}

async function thorQuote(p: Thorlike, from: Asset, to: Asset, amount: bigint, addrs: Addresses, slip: number, destAddrs: Addresses = addrs) {
  const fa = poolAsset(p, from), ta = poolAsset(p, to)
  if (!fa || !ta) return null
  const ps = await pools(p)
  for (const x of [fa, ta]) if (!ps.has(x.toUpperCase())) return null
  const dest = destAddrs[networkOf(to.id).family]
  const refund = addrs[networkOf(from.id).family]
  if (!dest || !refund) return null
  const amt8 = (amount * 10n ** 8n) / 10n ** BigInt(from.decimals) // both protocols quote in 1e8
  // UTXO memos are capped at 80 bytes: refunds go back to the sending address anyway, so leave it out there
  const utxo = ['btc', 'ltc', 'doge'].includes(networkOf(from.id).family)
  const ask = (stream: boolean) => thorGet(p, `quote/swap?from_asset=${fa}&to_asset=${ta}&amount=${amt8}&destination=${dest}${utxo ? '' : `&refund_address=${refund}`}${stream ? '&streaming_interval=1&streaming_quantity=0' : ''}&liquidity_tolerance_bps=${slip}`)
  let q = await ask(true)
  if (!q?.memo && /memo too long/i.test(q?.message ?? '')) q = await ask(false)
  if (!q?.memo || !q?.inbound_address) throw new Error(cleanThorError(q?.message ?? q?.error ?? 'No route'))
  if (new TextEncoder().encode(q.memo).length > 80 && ['btc', 'ltc', 'doge'].includes(networkOf(from.id).family)) throw new Error('Route memo too long for this chain')
  const out = units(q.expected_amount_out, 8)
  return { q, out, amt8 }
}
/** The memo is what THORChain / Maya act on: it names where the coins go. It comes from the quote API, so before
 *  signing, check it pays out to the user's own address, refunds to their own address, has a real price limit, and
 *  carries no affiliate cut. A hacked or spoofed API can then only make the swap fail, never redirect it.
 *  Format: =:ASSET:DEST[/REFUND]:LIMIT[/INTERVAL/QUANTITY][:AFFILIATE:BPS] (also "s:" or "SWAP:"). */
export function checkThorMemo(memo: string, dest: string, refund: string | undefined, minLimit8: bigint): string | null {
  const same = (a: string, b: string) => (/^(0x|bc1|ltc1)/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b)
  const parts = String(memo ?? '').split(':')
  if (!['=', 's', 'swap'].includes(parts[0]?.toLowerCase())) return 'not a swap memo'
  const [payTo, refundTo, ...rest] = String(parts[2] ?? '').split('/')
  if (rest.length || !payTo || !same(payTo, dest)) return 'pays out to an address that is not yours'
  if (refundTo && (!refund || !same(refundTo, refund))) return 'refunds to an address that is not yours'
  const lim = String(parts[3] ?? '').split('/')[0]
  if (!/^\d+$/.test(lim) || BigInt(lim) < minLimit8 || BigInt(lim) === 0n) return 'has no proper price limit'
  if (parts.length > 4 && parts.slice(5).some((b) => /[1-9]/.test(b))) return 'adds an affiliate fee'
  if (parts.length > 6) return 'has extra instructions'
  return null
}

const cleanThorError = (m: string) => {
  if (/not enough asset to pay for fees|less than|dust|recommended_min|amount less/i.test(m)) return 'Amount is below the minimum for this route'
  if (/trading.+halt|halted/i.test(m)) return 'This chain is paused on the protocol right now'
  if (/pool .*(does not exist|not available)/i.test(m)) return 'No liquidity pool for this pair'
  return m.replace(/^failed to simulate swap: /, '').slice(0, 140)
}

// ---------- helpers ----------
async function evmAllowance(network: string, token: string, owner: string, spender: string) {
  return evmClient(network).readContract({ address: token as Hex, abi: erc20Abi, functionName: 'allowance', args: [owner as Hex, spender as Hex] })
}
async function evmGasPrice(network: string) {
  const f = await evmClient(network).estimateFeesPerGas()
  const prio = mul(f.maxPriorityFeePerGas, 1.1)
  const max = mul(f.maxFeePerGas, 1.15)
  return { maxFeePerGas: max > prio ? max : prio, maxPriorityFeePerGas: prio }
}

type Built = SwapRoute & { exec: (k: KeyFor, addrs: Addresses) => Promise<{ txid: string; approveTxid?: string; ref?: string }> }

// ---------- providers ----------
// The aggregators' own contracts, the same address on every EVM chain Astrala uses (checked 23 Nov 2026). Their APIs
// build the transaction; a contract, spender or payout other than these means the API was spoofed, so nothing is signed.
export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
export const PARASWAP_AUGUSTUS = '0x6A000F20005980200259B80c5102003040001068'
const pins = (got: string | undefined, want: string) => { try { return getAddress(String(got)) === getAddress(want) } catch { return false } }
async function jupiter(from: Asset, to: Asset, amount: bigint, addrs: Addresses, slip: number, dest: Addresses = addrs): Promise<Built | null> {
  if (from.network !== 'solana' || to.network !== 'solana') return null
  if (dest.sol !== addrs.sol) return null // shortcut: Jupiter here always pays out to the signer; another wallet would need its token account set up first
  const q = await getJson(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${solMint(from)}&outputMint=${solMint(to)}&amount=${amount}&slippageBps=${slip}&restrictIntermediateTokens=true`)
  if (!q?.outAmount) throw new Error(q?.error ?? 'No Jupiter route')
  const route: SwapRoute = {
    provider: 'jupiter', providerName: PROVIDER_NAME.jupiter, from: from.id, to: to.id,
    amountIn: units(amount, from.decimals), amountOut: units(q.outAmount, to.decimals), minOut: units(q.otherAmountThreshold, to.decimals),
    networkFee: 0.0002, networkFeeAsset: 'sol', etaSec: 5, approval: false,
    notes: [`Routed through ${[...new Set((q.routePlan ?? []).map((r: any) => r.swapInfo?.label).filter(Boolean))].slice(0, 3).join(', ') || 'Solana DEXs'}`]
  }
  return {
    ...route,
    exec: async (keyFor) => {
      const kp = Keypair.fromSeed(keyFor('sol').priv)
      if (kp.publicKey.toBase58() !== addrs.sol) throw new Error('Key mismatch')
      const r = await getJson('https://lite-api.jup.ag/swap/v1/swap', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quoteResponse: q, userPublicKey: addrs.sol, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'medium' } } })
      })
      if (!r?.swapTransaction) throw new Error(r?.error ?? 'Jupiter could not build the swap')
      const tx = VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64'))
      if (!tx.message.staticAccountKeys[0].equals(kp.publicKey)) throw new Error('Swap transaction has the wrong fee payer')
      tx.sign([kp])
      if (DRY) return { txid: dry('sol', Buffer.from(tx.serialize()).toString('hex')) }
      const txid = await solConn().sendRawTransaction(tx.serialize(), { maxRetries: 5 })
      return { txid }
    }
  }
}

async function kyber(from: Asset, to: Asset, amount: bigint, addrs: Addresses, slip: number, dest: Addresses = addrs): Promise<Built | null> {
  const chain = KYBER_CHAIN[from.network]
  if (!chain || from.network !== to.network) return null
  const H = { 'x-client-id': 'astrala' }
  const j = await getJson(`https://aggregator-api.kyberswap.com/${chain}/api/v1/routes?tokenIn=${evmToken(from)}&tokenOut=${evmToken(to)}&amountIn=${amount}&gasInclude=true`, { headers: H })
  const rs = j?.data?.routeSummary
  if (!rs?.amountOut) throw new Error(j?.message ?? 'No KyberSwap route')
  const router = j.data.routerAddress as string
  if (!pins(router, KYBER_ROUTER)) throw new Error('KyberSwap answered with an unknown contract')
  const owner = addrs.evm!
  const needsApprove = from.kind === 'token' && (await evmAllowance(from.network, from.contract!, owner, router)) < amount
  const gasUnits = BigInt(rs.gas ?? 250000) + (needsApprove ? 60000n : 0n)
  const gp = await evmGasPrice(from.network)
  const out = units(rs.amountOut, to.decimals)
  return {
    provider: 'kyber', providerName: PROVIDER_NAME.kyber, from: from.id, to: to.id,
    amountIn: units(amount, from.decimals), amountOut: out, minOut: out * (1 - slip / 10_000),
    networkFee: units(gasUnits * gp.maxFeePerGas, 18), networkFeeAsset: NETWORKS[from.network].native, etaSec: 30, approval: needsApprove,
    notes: needsApprove ? [`First swap of ${from.symbol} here needs a one-time approval transaction`] : [],
    exec: async (keyFor) => {
      const b = await getJson(`https://aggregator-api.kyberswap.com/${chain}/api/v1/route/build`, {
        method: 'POST', headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ routeSummary: rs, sender: owner, recipient: dest.evm ?? owner, slippageTolerance: slip, deadline: Math.floor(Date.now() / 1000) + 1200, enableGasEstimation: false, source: 'astrala' })
      })
      const d = b?.data
      if (!d?.data || !pins(d.routerAddress, KYBER_ROUTER)) throw new Error(b?.message ?? 'KyberSwap could not build the swap')
      if (!lifiPaysTo(d.data, dest.evm ?? owner, 'evm')) throw new Error('KyberSwap returned a swap that does not pay out to your address, so nothing was sent')
      return evmSend(from, keyFor, owner, router, amount, { to: router, data: d.data, value: from.kind === 'native' ? amount : 0n })
    }
  }
}

async function paraswap(from: Asset, to: Asset, amount: bigint, addrs: Addresses, slip: number, dest: Addresses = addrs): Promise<Built | null> {
  const chainId = NETWORKS[from.network].chainId
  if (!chainId || from.network !== to.network || !KYBER_CHAIN[from.network]) return null
  const owner = addrs.evm!
  const j = await getJson(`https://api.paraswap.io/prices?srcToken=${evmToken(from)}&destToken=${evmToken(to)}&amount=${amount}&srcDecimals=${from.decimals}&destDecimals=${to.decimals}&side=SELL&network=${chainId}&userAddress=${owner}&version=6.2`)
  const pr = j?.priceRoute
  if (!pr?.destAmount) throw new Error(j?.error ?? 'No ParaSwap route')
  const spender = pr.tokenTransferProxy as string
  if (!pins(pr.contractAddress, PARASWAP_AUGUSTUS) || !pins(spender, PARASWAP_AUGUSTUS)) throw new Error('ParaSwap answered with an unknown contract')
  const needsApprove = from.kind === 'token' && (await evmAllowance(from.network, from.contract!, owner, spender)) < amount
  const gasUnits = BigInt(pr.gasCost ?? 250000) + (needsApprove ? 60000n : 0n)
  const gp = await evmGasPrice(from.network)
  const out = units(pr.destAmount, to.decimals)
  return {
    provider: 'paraswap', providerName: PROVIDER_NAME.paraswap, from: from.id, to: to.id,
    amountIn: units(amount, from.decimals), amountOut: out, minOut: out * (1 - slip / 10_000),
    networkFee: units(gasUnits * gp.maxFeePerGas, 18), networkFeeAsset: NETWORKS[from.network].native, etaSec: 30, approval: needsApprove,
    notes: needsApprove ? [`First swap of ${from.symbol} here needs a one-time approval transaction`] : [],
    exec: async (keyFor) => {
      const b = await getJson(`https://api.paraswap.io/transactions/${chainId}?ignoreChecks=true&ignoreGasEstimate=true`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ srcToken: evmToken(from), destToken: evmToken(to), srcAmount: String(amount), srcDecimals: from.decimals, destDecimals: to.decimals, slippage: slip, priceRoute: pr, userAddress: owner, receiver: dest.evm ?? owner, partner: 'astrala' })
      })
      if (!b?.data || !b?.to) throw new Error(b?.error ?? 'ParaSwap could not build the swap')
      if (!pins(b.to, PARASWAP_AUGUSTUS)) throw new Error('ParaSwap returned an unexpected contract, so nothing was sent')
      if (!lifiPaysTo(b.data, dest.evm ?? owner, 'evm')) throw new Error('ParaSwap returned a swap that does not pay out to your address, so nothing was sent')
      return evmSend(from, keyFor, owner, spender, amount, { to: b.to, data: b.data, value: BigInt(b.value ?? 0) })
    }
  }
}

async function thorlike(p: Thorlike, from: Asset, to: Asset, amount: bigint, addrs: Addresses, slip: number, dest: Addresses = addrs): Promise<Built | null> {
  const r = await thorQuote(p, from, to, amount, addrs, slip, dest)
  if (!r) return null
  const { q, out } = r
  const fam = networkOf(from.id).family
  const native = NETWORKS[from.network].native
  let networkFee = 0
  let approval = false
  if (fam === 'btc' || fam === 'ltc' || fam === 'doge') networkFee = (Number(q.recommended_gas_rate ?? 10) * (fam === 'doge' ? 300 : 200)) / 1e8
  if (fam === 'evm') {
    if (from.kind === 'token') approval = (await evmAllowance(from.network, from.contract!, addrs.evm!, q.router)) < amount
    const gp = await evmGasPrice(from.network)
    networkFee = units((from.kind === 'token' ? 130_000n : 90_000n) * gp.maxFeePerGas + (approval ? 60_000n * gp.maxFeePerGas : 0n), 18)
  }
  if (fam === 'trx') networkFee = 1.1
  if (fam === 'sol') networkFee = 0.00001
  const minOut = out * (1 - slip / 10_000)
  const fees = q.fees ? `Protocol + liquidity fees ${(Number(q.fees.total_bps ?? 0) / 100).toFixed(2)}%` : ''
  const notes = [fees, q.streaming_swap_blocks > 0 ? 'Streamed in small chunks for a better price' : '', 'If the price moves past your limit, funds are refunded automatically'].filter(Boolean)
  if (fam === 'evm' && from.kind === 'token') notes.unshift(...(approval ? [`One-time approval for ${from.symbol} first`] : []))
  return {
    provider: p, providerName: PROVIDER_NAME[p], from: from.id, to: to.id,
    amountIn: units(amount, from.decimals), amountOut: out, minOut,
    networkFee, networkFeeAsset: native, etaSec: Number(q.total_swap_seconds ?? 600) + Number(q.inbound_confirmation_seconds ?? 0), approval, notes,
    exec: async (keyFor) => {
      // fresh vault address right before signing; vaults rotate
      const fresh = await thorQuote(p, from, to, amount, addrs, slip, dest)
      if (!fresh) throw new Error('Route disappeared')
      const fq = fresh.q
      if (fresh.out < minOut) throw new Error('Price moved past your limit. Review the new quote.')
      if (Number(fq.expiry) * 1000 < Date.now() + 60_000) throw new Error('Quote expired, try again')
      const inbounds: any[] = await thorGet(p, 'inbound_addresses')
      const chain = (p === 'thorchain' ? THOR_CHAIN : MAYA_CHAIN)[from.network]
      const ib = inbounds.find((x) => x.chain === chain)
      if (!ib || ib.halted || ib.global_trading_paused || ib.chain_trading_paused) throw new Error('This chain is paused on the protocol right now')
      if (ib.address !== fq.inbound_address) throw new Error('Vault rotated mid-quote, try again')
      const memo: string = fq.memo
      const payTo = dest[networkOf(to.id).family]
      const bad = payTo ? checkThorMemo(memo, payTo, addrs[fam], BigInt(Math.floor(minOut * (1 - slip / 10_000) * 1e8))) : 'has no payout address'
      if (bad) throw new Error(`${PROVIDER_NAME[p]} returned a swap that ${bad}, so nothing was sent`)
      if (fam === 'btc' || fam === 'ltc' || fam === 'doge') return { txid: await utxoDeposit(fam, keyFor, addrs[fam]!, fq.inbound_address, amount, memo, Number(fq.recommended_gas_rate)) }
      if (fam === 'evm') {
        const router = getAddress(fq.router)
        if (getAddress(ib.router) !== router) throw new Error('Router mismatch')
        const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'depositWithExpiry', args: [getAddress(fq.inbound_address), from.kind === 'native' ? '0x0000000000000000000000000000000000000000' : getAddress(from.contract!), amount, memo, BigInt(Math.floor(Date.now() / 1000) + 900)] })
        return evmSend(from, keyFor, addrs.evm!, router, amount, { to: router, data, value: from.kind === 'native' ? amount : 0n })
      }
      if (fam === 'trx') {
        if (from.kind !== 'native') throw new Error('Swap TRX itself from Tron for now')
        return { txid: await tronDeposit(keyFor, addrs.trx!, fq.inbound_address, amount, memo) }
      }
      if (fam === 'sol') {
        if (from.kind !== 'native') throw new Error('Swap SOL itself for cross-chain routes')
        return { txid: await solDeposit(keyFor, addrs.sol!, fq.inbound_address, amount, memo) }
      }
      throw new Error('Unsupported source chain')
    }
  }
}

// ---------- LI.FI: cross-chain bridges and intents (EVM + Solana sources) ----------
// Only on-chain bridges are allowed through. Anything that routes via an exchange account or a custodial deposit is excluded.
const LIFI = 'https://li.quest/v1'
const LIFI_BRIDGES = 'across,celercircle,celercirclefast,cctp,mayan,mayanWH,mayanMCTP,mayanFastMCTP,stargateV2,stargateV2Bus,symbiosis,glacis,chainflip,relaydepository,polymer,polymerStandard,eco,garden,allbridge,squid,arbitrum,polygon,gnosis,omni'
const LIFI_DENY_EXCHANGES = 'bitget,okx,paxosDex,smartDeposits'
// LI.FI's contract (the same "diamond" on every EVM chain Astrala uses). A transaction aimed anywhere else is refused.
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
/** Does LI.FI's calldata name the user's own payout address? EVM addresses appear as-is; Solana ones as their 32 raw bytes. */
export function lifiPaysTo(data: string, toAddr: string, tfam: string): boolean {
  const d = String(data ?? '').toLowerCase()
  if (tfam === 'evm') return /^0x[0-9a-f]{40}$/i.test(toAddr) && d.includes(toAddr.slice(2).toLowerCase())
  if (tfam === 'sol') { try { return d.includes(bytesToHex(new PublicKey(toAddr).toBytes())) } catch { return false } }
  return false
}
async function lifi(from: Asset, to: Asset, amount: bigint, addrs: Addresses, slip: number, dest: Addresses = addrs): Promise<Built | null> {
  const fc = LIFI_CHAIN[from.network], tc = LIFI_CHAIN[to.network]
  const ffam = NETWORKS[from.network].family, tfam = NETWORKS[to.network].family
  if (!fc || !tc || from.network === to.network || (ffam !== 'evm' && ffam !== 'sol')) return null
  // a Bitcoin payout goes through a deposit id, so the transaction can't be checked to pay the user; THORChain and Maya cover those pairs
  if (tfam !== 'evm' && tfam !== 'sol') return null
  const ft = lifiToken(from), tt = lifiToken(to)
  const fromAddr = addrs[ffam], toAddr = dest[tfam]
  if (!ft || !tt || !fromAddr || !toAddr) return null
  const q = await getJson(`${LIFI}/quote?fromChain=${fc}&toChain=${tc}&fromToken=${ft}&toToken=${tt}&fromAmount=${amount}&fromAddress=${fromAddr}&toAddress=${toAddr}&slippage=${slip / 10_000}&order=CHEAPEST&allowBridges=${LIFI_BRIDGES}&denyExchanges=${LIFI_DENY_EXCHANGES}`)
  const e = q?.estimate
  if (!e?.toAmount || !q.transactionRequest) throw new Error(q?.message ? String(q.message).slice(0, 140) : 'No LI.FI route')
  const native = NETWORKS[from.network].native
  const gas = (e.gasCosts ?? []).reduce((s: number, g: any) => s + Number(g.amount ?? 0) / 10 ** (g.token?.decimals ?? ASSET[native].decimals), 0)
  let approval = false
  if (ffam === 'evm' && from.kind === 'token' && e.approvalAddress) approval = (await evmAllowance(from.network, from.contract!, fromAddr, e.approvalAddress)) < amount
  const via = q.toolDetails?.name ?? q.tool
  const fees = (e.feeCosts ?? []).filter((f: any) => f.included).reduce((s: number, f: any) => s + Number(f.amountUSD ?? 0), 0)
  return {
    provider: 'lifi', providerName: PROVIDER_NAME.lifi, via, viaKey: String(q.tool ?? '').replace(/(WH|MCTP|FastMCTP|Bus|Standard|fast)$/i, '').toLowerCase(),
    from: from.id, to: to.id,
    amountIn: units(amount, from.decimals), amountOut: units(e.toAmount, to.decimals), minOut: units(e.toAmountMin, to.decimals),
    networkFee: gas, networkFeeAsset: native, etaSec: Number(e.executionDuration ?? 120), approval,
    notes: [`Bridged by ${via}${fees ? `, fees ≈ $${fees.toFixed(2)} included` : ''}`, ...(approval ? [`One-time approval for ${from.symbol} first`] : [])],
    exec: async (keyFor) => {
      const tx = q.transactionRequest
      if (ffam === 'evm') {
        if (Number(tx.chainId) !== NETWORKS[from.network].chainId) throw new Error('LI.FI returned a transaction for the wrong chain')
        if (getAddress(tx.to) !== LIFI_DIAMOND || (from.kind === 'token' && getAddress(e.approvalAddress ?? '0x0') !== LIFI_DIAMOND)) throw new Error('LI.FI returned an unexpected contract, so nothing was sent')
        if (!lifiPaysTo(tx.data, toAddr, tfam)) throw new Error('LI.FI returned a swap that does not pay out to your address, so nothing was sent')
        return evmSend(from, keyFor, fromAddr, LIFI_DIAMOND, amount, { to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) })
      }
      const kp = Keypair.fromSeed(keyFor('sol').priv)
      if (kp.publicKey.toBase58() !== fromAddr) throw new Error('Key mismatch')
      const vt = VersionedTransaction.deserialize(Buffer.from(tx.data, 'base64'))
      if (!vt.message.staticAccountKeys[0].equals(kp.publicKey)) throw new Error('Swap transaction has the wrong fee payer')
      vt.sign([kp])
      if (DRY) return { txid: dry('sol', Buffer.from(vt.serialize()).toString('hex')) }
      return { txid: await solConn().sendRawTransaction(vt.serialize(), { maxRetries: 5 }) }
    }
  }
}

async function roughFee(from: Asset): Promise<number> {
  const fam = networkOf(from.id).family
  try {
    if (fam === 'evm') { const g = await evmGasPrice(from.network); return units((from.kind === 'token' ? 65_000n : 21_000n) * g.maxFeePerGas, 18) }
    if (fam === 'doge') return 0.01
    if (fam === 'btc' || fam === 'ltc') { const r = await getJson(`${NETWORKS[from.network].rpc[0]}/api/v1/fees/recommended`).catch(() => null); return ((r?.halfHourFee ?? (fam === 'btc' ? 6 : 2)) * 145) / 1e8 }
    if (fam === 'sol') return 0.00002
    if (fam === 'trx') return from.kind === 'token' ? 14 : 1.1
  } catch { /* estimate */ }
  return 0
}

// ---------- Wagyu: swaps into and out of Monero ----------
// You send coins to a one-time deposit address and Wagyu pays native XMR (or pays out from XMR) to your own address.
// No account, no key, no KYC; its policy is to freeze only on a binding court order, and flagged deposits are refunded
// before the swap runs rather than held. Wagyu fills some legs through other services, so only legs that run on
// Hyperliquid directly or through on-chain bridges are allowed: the NEAR Intents and Layerswap legs are skipped,
// because those services can hold funds for compliance checks.
const WAGYU = 'https://api-beta.wagyu.xyz/v2'
const WAGYU_TOOLS = new Set(['direct', 'relaydepository', 'mayan', 'across'])
async function wagyuPost(path: string, body: unknown) {
  const r = await net(`${WAGYU}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => null)
  // Wagyu answers 503 "unavailable" when its Monero side is paused; say so plainly instead of a bare server error
  if (!r.ok && (j?.code === 'unavailable' || r.status === 503)) throw new Error('Monero swaps are paused at Wagyu right now. Other coins still work; try XMR again later')
  if (!r.ok) throw new Error(String(j?.error ?? `Wagyu answered ${r.status}`).slice(0, 140))
  return j
}
function wagyuBody(from: Asset, to: Asset, amount: bigint, addrs: Addresses, dest: Addresses) {
  const f = wagyuAsset(from), t = wagyuAsset(to)
  const toAddress = dest[networkOf(to.id).family], refundAddress = addrs[networkOf(from.id).family]
  if (!f || !t || !toAddress || !refundAddress) return null
  return { fromChainId: f.chainId, toChainId: t.chainId, fromToken: f.token, toToken: t.token, fromAmount: String(amount), toAddress, refundAddress }
}
async function wagyuQuote(from: Asset, to: Asset, amount: bigint, body: NonNullable<ReturnType<typeof wagyuBody>>) {
  const { refundAddress: _r, ...q } = body
  const r = await wagyuPost('/swaps/quote', q)
  if (!WAGYU_TOOLS.has(String(r?.toolUsed))) return null // this pair would run through a service that can hold funds
  if (Number(r.fromAmountUsd) < Number(r.minDepositUsd)) throw new Error(`Amount is below the minimum for this route (at least $${r.minDepositUsd} of ${from.symbol})`)
  if (!(BigInt(r.toAmount ?? '0') > 0n)) return null
  return r as { toAmount: string; feeFraction: number; toolUsed: string }
}

async function wagyu(from: Asset, to: Asset, amount: bigint, addrs: Addresses, slip: number, dest: Addresses = addrs): Promise<Built | null> {
  if (from.id !== 'xmr' && to.id !== 'xmr') return null // Wagyu is for Monero; everything else has cheaper on-chain routes
  const body = wagyuBody(from, to, amount, addrs, dest)
  if (!body) return null
  const q = await wagyuQuote(from, to, amount, body)
  if (!q) return null
  const out = units(q.toAmount, to.decimals)
  const minOut = out * (1 - slip / 10_000)
  return {
    provider: 'wagyu', providerName: PROVIDER_NAME.wagyu, via: { direct: 'Hyperliquid', mayan: 'Hyperliquid + Mayan', across: 'Hyperliquid + Across', relaydepository: 'Hyperliquid + Relay' }[q.toolUsed] ?? 'Hyperliquid', viaKey: 'wagyu',
    from: from.id, to: to.id,
    amountIn: units(amount, from.decimals), amountOut: out, minOut,
    networkFee: await roughFee(from), networkFeeAsset: NETWORKS[from.network].native, etaSec: from.id === 'xmr' ? 1500 : 900, approval: false,
    notes: [`Wagyu's ${Math.round(q.feeFraction * 1000) / 10}% fee is already in this price`, 'No account or ID. If a deposit fails their checks it is sent back before the swap, not held'],
    exec: async (keyFor, a) => {
      const b = wagyuBody(from, to, amount, a, dest)
      if (!b) throw new Error('Missing an address for this swap')
      const live = await wagyuQuote(from, to, amount, b)
      if (!live) throw new Error('Wagyu changed how it fills this swap, so Astrala stopped. Try again later')
      if (units(live.toAmount, to.decimals) < minOut) throw new Error('Price moved past your limit. Review the new quote.')
      if (DRY) return { txid: dry('wagyu', JSON.stringify(b)), ref: 'dry' }
      const order = await wagyuPost('/swaps', b) // never retried: a second call would open a second order
      const f = wagyuAsset(from)!
      // only send if the order asks for exactly what the user approved, on the right chain, in the right coin
      if (order.depositChainId !== f.chainId || String(order.depositToken).toLowerCase() !== f.token.toLowerCase() || BigInt(order.depositAmount) !== amount || !order.depositAddress)
        throw new Error('Wagyu returned an order that does not match your swap, so nothing was sent')
      const sent = await sendExecute({ assetId: from.id, to: order.depositAddress, amount: formatUnits(amount, from.decimals), speed: 'normal' }, a, keyFor)
      return { txid: sent.txid, ref: `${order.orderId}|${order.sessionId}` }
    }
  }
}

// ---------- signing per chain ----------
async function evmSend(from: Asset, keyFor: KeyFor, owner: string, spender: string, amount: bigint, call: { to: string; data: Hex | string; value: bigint }) {
  const c = evmClient(from.network)
  const account = privateKeyToAccount(`0x${bytesToHex(keyFor('evm').priv)}`)
  if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error('Key mismatch')
  const chainId = NETWORKS[from.network].chainId!
  let nonce = await c.getTransactionCount({ address: account.address, blockTag: 'pending' })
  let approveTxid: string | undefined
  if (from.kind === 'token') {
    const allowance = await evmAllowance(from.network, from.contract!, owner, spender)
    if (allowance < amount && DRY) approveTxid = 'dry:approve'
    else if (allowance < amount) {
      const gp = await evmGasPrice(from.network)
      // USDT on Ethereum refuses to change a non-zero allowance directly
      if (allowance > 0n && from.id === 'usdt-ethereum') {
        const z = await account.signTransaction({ chainId, type: 'eip1559', nonce: nonce++, gas: 70_000n, ...gp, to: from.contract as Hex, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as Hex, 0n] }) })
        await c.waitForTransactionReceipt({ hash: await c.sendRawTransaction({ serializedTransaction: z }), timeout: 180_000 })
      }
      const signed = await account.signTransaction({ chainId, type: 'eip1559', nonce: nonce++, gas: 80_000n, ...gp, to: from.contract as Hex, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as Hex, amount] }) })
      approveTxid = await c.sendRawTransaction({ serializedTransaction: signed })
      const rc = await c.waitForTransactionReceipt({ hash: approveTxid as Hex, timeout: 180_000 })
      if (rc.status !== 'success') throw new Error('Approval failed on-chain')
    }
  }
  const gp = await evmGasPrice(from.network)
  let gas: bigint
  try { gas = mul(await c.estimateGas({ account: account.address, to: call.to as Hex, data: call.data as Hex, value: call.value }), 1.25) } catch (e: any) {
    const m = String(e?.shortMessage ?? e?.message ?? '')
    if (DRY) gas = 500_000n
    else if (/exceeds the balance|insufficient funds/i.test(m)) throw new Error(`Not enough ${ASSET[NETWORKS[from.network].native].symbol} for this swap plus the network fee`)
    else throw new Error(`The swap would fail on-chain, so nothing was sent: ${m.slice(0, 120)}`)
  }
  const signed = await account.signTransaction({ chainId, type: 'eip1559', nonce, gas, ...gp, to: call.to as Hex, data: call.data as Hex, value: call.value })
  if (DRY) return { txid: dry('evm', `${call.to}:${call.value}:${call.data}`), approveTxid, signed }
  return { txid: await c.sendRawTransaction({ serializedTransaction: signed }), approveTxid }
}

export function buildUtxoDeposit(fam: 'btc' | 'ltc' | 'doge', pub: Uint8Array, from: string, utxos: { txid: string; vout: number; value: number }[], vault: string, amount: bigint, memo: string, feePerByte: number) {
  const network = UTXO_NET[fam]
  const script = fam === 'doge' ? btc.p2pkh(pub, network).script : btc.p2wpkh(pub, network).script
  const inputs = utxos.map((u) => ({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: BigInt(u.value) }, ...(fam === 'doge' ? {} : { sequence: 0xfffffffd }) }))
  const memoScript = btc.Script.encode(['RETURN', new TextEncoder().encode(memo)])
  // order matters to the protocol: vault first, memo, then change back to us
  return btc.selectUTXO(inputs, [{ address: vault, amount }, { script: memoScript, amount: 0n }], 'default', {
    feePerByte: BigInt(feePerByte), network, createTx: true, bip69: false, allowUnknownOutputs: true, allowLegacyWitnessUtxo: fam === 'doge', dust: fam === 'doge' ? 1_000_000n : undefined, changeAddress: from
  })
}

async function utxoDeposit(fam: 'btc' | 'ltc' | 'doge', keyFor: KeyFor, from: string, vault: string, amount: bigint, memo: string, rate: number) {
  const { priv, pub } = keyFor(fam)
  const s = await utxoState(fam, from, 'normal')
  const feePerByte = Math.max(s.feePerByte, fam === 'doge' ? s.feePerByte : rate || 1)
  const sel = buildUtxoDeposit(fam, pub, from, s.utxos, vault, amount, memo, feePerByte)
  if (!sel?.tx) throw new Error('Not enough funds for the amount plus network fee')
  sel.tx.sign(priv)
  sel.tx.finalize()
  const hex = sel.tx.hex
  if (DRY) return dry(fam, hex)
  if (fam === 'doge') {
    const r = await getJson(`${s.network.rpc[0]}/txs/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: hex }) })
    return r.tx?.hash ?? sel.tx.id
  }
  const r = await net(`${s.network.rpc[0]}/api/tx`, { method: 'POST', body: hex })
  const text = await r.text()
  if (!r.ok) throw new Error(text.slice(0, 200))
  return text.trim()
}

async function tronDeposit(keyFor: KeyFor, from: string, vault: string, amount: bigint, memo: string) {
  const extra = bytesToHex(new TextEncoder().encode(memo))
  const tx = await tronPost('/wallet/createtransaction', { owner_address: from, to_address: vault, amount: Number(amount), extra_data: extra, visible: true })
  if (!tx?.txID) throw new Error(tx?.Error ?? 'Tron node refused the transaction')
  const v = tx.raw_data.contract[0].parameter.value
  if (v.owner_address !== from || v.to_address !== vault || BigInt(v.amount) !== amount || (tx.raw_data.data ?? '').toLowerCase() !== extra) throw new Error('Tron node returned a transaction that does not match')
  const sig = tronSign(tx.txID, tx.raw_data_hex, keyFor('trx').priv)
  if (DRY) return dry('trx', tx.raw_data.data)
  const r = await tronPost('/wallet/broadcasttransaction', { ...tx, signature: [sig] })
  if (!r.result) throw new Error(r.message ? Buffer.from(r.message, 'hex').toString() : 'Broadcast failed')
  return tx.txID as string
}

async function solDeposit(keyFor: KeyFor, from: string, vault: string, amount: bigint, memo: string) {
  const kp = Keypair.fromSeed(keyFor('sol').priv)
  if (kp.publicKey.toBase58() !== from) throw new Error('Key mismatch')
  const conn = solConn()
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(vault), lamports: amount }),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(memo) })
  )
  tx.sign(kp)
  if (DRY) return dry('sol', memo)
  return conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 })
}

// ---------- public API ----------
export type PriceOf = (assetId: string) => number | undefined
/** dest: the wallet the swapped coins land in (default: the sending wallet). feeBps: Astrala's cut, taken before routing. */
export interface SwapOpts { dest?: Addresses; feeBps?: number }


async function allRoutes(req: SwapRequest, addrs: Addresses, o: SwapOpts = {}): Promise<{ built: Built[]; errors: string[]; fee: bigint }> {
  const from = ASSET[req.from], to = ASSET[req.to]
  if (!from || !to) throw new Error('Unknown asset')
  if (from.id === to.id) throw new Error('Pick two different assets')
  const gross = parseUnits(req.amount || '0', from.decimals)
  if (gross <= 0n) throw new Error('Enter an amount')
  const { fee, net: amount } = takeFee(gross, o.feeBps ?? 0, networkOf(from.id).family)
  const dest = o.dest ?? addrs
  const slip = Math.min(500, Math.max(10, req.slippageBps ?? (from.network === to.network ? 50 : 100)))
  const tries: Promise<Built | null>[] = [
    jupiter(from, to, amount, addrs, slip, dest),
    kyber(from, to, amount, addrs, slip, dest),
    paraswap(from, to, amount, addrs, slip, dest),
    thorlike('thorchain', from, to, amount, addrs, slip, dest),
    thorlike('maya', from, to, amount, addrs, slip, dest),
    lifi(from, to, amount, addrs, slip, dest),
    wagyu(from, to, amount, addrs, slip, dest)
  ]
  const res = await Promise.allSettled(tries)
  const built: Built[] = []
  const errors: string[] = []
  res.forEach((r) => (r.status === 'fulfilled' ? r.value && built.push(r.value) : errors.push(String((r.reason as any)?.message ?? r.reason))))
  for (const b of built) { b.ourFee = units(fee, from.decimals); b.ourFeeBps = fee > 0n ? o.feeBps : 0 }
  return { built, errors, fee }
}

const rank = (rs: Built[], price: PriceOf) => {
  for (const r of rs) {
    const pt = price(r.to) ?? 0, pf = price(r.networkFeeAsset) ?? 0
    r.score = pt ? r.amountOut * pt - r.networkFee * pf : r.amountOut
  }
  return rs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

export async function swapQuote(req: SwapRequest, addrs: Addresses, price: PriceOf = () => undefined, o: SwapOpts = {}): Promise<SwapQuote> {
  try {
    const { built, errors } = await allRoutes(req, addrs, o)
    if (!built.length) return { ok: false, error: (errors.find((e) => /minimum.*\(at least/i.test(e)) ?? errors.find((e) => /minimum|liquidity/i.test(e)) ?? errors.find((e) => /paused/i.test(e))) ?? (errors[0] ? errors[0].slice(0, 140) : 'No decentralized route for this pair yet'), routes: [] }
    return { ok: true, routes: rank(built, price).map(({ exec: _e, ...r }) => r) }
  } catch (e: any) {
    const m = String(e?.message ?? e)
    return { ok: false, error: m.slice(0, 140), routes: [] }
  }
}

/** Re-quotes the chosen provider, refuses if the price slipped below what the user accepted, then signs and broadcasts.
 *  Astrala's fee goes out afterwards as its own transfer, only once the swap itself was sent. */
export async function swapExecute(req: SwapRequest, provider: Provider, acceptedMinOut: number, addrs: Addresses, keyFor: KeyFor, o: SwapOpts = {}) {
  const { built, fee } = await allRoutes(req, addrs, o)
  const r = built.find((b) => b.provider === provider)
  if (!r) throw new Error(`${PROVIDER_NAME[provider]} no longer offers this route`)
  if (r.amountOut < acceptedMinOut) throw new Error('Price moved past your limit. Review the new quote.')
  const res = await r.exec(keyFor, addrs)
  const { exec: _e, ...route } = r
  const paid = fee > 0n ? await collectFee(req.from, fee, addrs, keyFor) : undefined
  return { ...res, route, network: ASSET[req.from].network, feeTxid: paid?.txid, feeError: paid?.error }
}

/** Sends Astrala's fee as a plain transfer. Never throws: the user's swap already went out, so a failed fee is only logged. */
export async function collectFee(assetId: string, fee: bigint, addrs: Addresses, keyFor: KeyFor): Promise<{ txid?: string; error?: string }> {
  const a = ASSET[assetId], fam = networkOf(assetId).family, to = feeAddress(fam)
  if (!to || fee <= 0n) return {}
  if (DRY) return { txid: dry('fee', `${to}:${fee}`) }
  // shortcut: UTXO chains wait a moment so the explorer sees the swap's change before we spend from it; a proper fix
  // is one transaction with an extra output, if fee sends ever collide
  if (fam === 'btc' || fam === 'ltc' || fam === 'doge') await new Promise((ok) => setTimeout(ok, 4000))
  try {
    const r = await sendExecute({ assetId, to, amount: formatUnits(fee, a.decimals), speed: 'normal' }, addrs, keyFor)
    return { txid: r.txid }
  } catch (e: any) { return { error: String(e?.message ?? e).slice(0, 160) } }
}

/** Plain move of one coin into another of the user's wallets (a split leg whose target is the coin itself). */
export async function moveTo(assetId: string, amount: bigint, addrs: Addresses, dest: Addresses, keyFor: KeyFor) {
  const a = ASSET[assetId], to = dest[networkOf(assetId).family]
  if (!to) throw new Error('No address for that coin in the new wallet')
  if (DRY) return { txid: dry('move', `${to}:${amount}`) }
  return sendExecute({ assetId, to, amount: formatUnits(amount, a.decimals), speed: 'normal' }, addrs, keyFor)
}

export { roughFee }

/** Cross-chain progress from THORChain / Maya: inbound seen → swapping → outbound sent. */
export async function crossChainStatus(provider: Provider, txid: string, ref?: string): Promise<'pending' | 'swapping' | 'done' | 'refunded' | 'unknown'> {
  if (provider === 'wagyu') {
    const [id, session] = String(ref ?? '').split('|')
    if (!id || !session) return 'unknown'
    try {
      const o = await getJson(`${WAGYU}/swaps/${encodeURIComponent(id)}`, { headers: { 'x-session-id': session } })
      const st = String(o?.status ?? '')
      return st === 'completed' ? 'done' : st === 'refunded' || st === 'failed' || st === 'expired' ? 'refunded' : st === 'awaiting_deposit' ? 'pending' : 'swapping'
    } catch { return 'unknown' }
  }
  if (provider === 'lifi') {
    try {
      const s = await getJson(`${LIFI}/status?txHash=${txid}`)
      if (s?.status === 'DONE') return s.substatus === 'REFUNDED' ? 'refunded' : 'done'
      if (s?.status === 'FAILED') return 'refunded'
      return s?.sending ? 'swapping' : 'pending'
    } catch { return 'unknown' }
  }
  if (provider !== 'thorchain' && provider !== 'maya') return 'unknown'
  try {
    const s = await thorGet(provider, `tx/status/${txid.replace(/^0x/, '').toUpperCase()}`)
    const st = s?.stages ?? {}
    if (s?.out_txs?.some((o: any) => /REFUND/i.test(o.memo ?? ''))) return 'refunded'
    if (st.outbound_signed?.completed || (st.swap_finalised?.completed && !st.outbound_signed)) return 'done'
    if (st.inbound_observed?.completed) return 'swapping'
    return 'pending'
  } catch { return 'unknown' }
}
