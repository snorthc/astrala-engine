// Sending: quote (fees, max, validation) and execute (build → sign locally → broadcast) for every family.
// Keys are passed in per call by the main process and never stored here.
import { createPublicClient, http, fallback, parseUnits, encodeFunctionData, erc20Abi, isAddress, getAddress, keccak256, serializeTransaction, recoverTransactionAddress, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, arbitrum, base, optimism, polygon, bsc, avalanche } from 'viem/chains'
import { publicActionsL2 } from 'viem/op-stack'
import { Connection, PublicKey, SystemProgram, Transaction, Keypair, ComputeBudgetProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from './spl'
import * as btc from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { ASSET, NETWORKS, networkOf, type Asset, type Family } from './assets'
import { net, getJson, type Addresses } from './chain'
import { tronDecode, moneroBase58Decode } from './derive'

export type Speed = 'slow' | 'normal' | 'fast'
export interface SendRequest { assetId: string; to: string; amount: string; speed: Speed; max?: boolean; account?: number }
export interface Quote {
  ok: boolean
  error?: string
  amount: number // what the recipient gets (asset units)
  fee: number // in fee-asset units
  feeAsset: string
  maxAmount: number
  eta: string
  notes: string[]
}
/**
 * A hardware wallet's signers (main/ledger.ts). The device signs; this file builds and broadcasts, the same as for
 * a key held here. A key for a hardware account carries `hw`, and its `priv` throws if anything reaches for it.
 */
export interface HwSigner {
  evm?: (unsigned: `0x${string}`) => Promise<{ r: `0x${string}`; s: `0x${string}`; yParity: number }>
  sol?: (message: Uint8Array) => Promise<Uint8Array>
  btc?: (psbt: Uint8Array) => Promise<[number, { pubkey: Uint8Array; signature: Uint8Array }][]>
  btcOrigin?: { pubkey: Uint8Array; fingerprint: number; path: string }
}
export type KeyFor = (f: Family) => { priv: Uint8Array; pub: Uint8Array; hw?: HwSigner }

// Monero is signed by the running wallet (it needs its synced outputs), injected by the main process.
type XmrBackend = { quote: (to: string, amount: string, speed: Speed, max: boolean) => Promise<{ amount: number; fee: number; txid: string }>; send: (to: string, amount: string, speed: Speed, max: boolean) => Promise<{ amount: number; fee: number; txid: string }>; unlocked: () => Promise<number | null> }
let xmrBackend: XmrBackend | null = null
export const setXmrBackend = (b: XmrBackend | null) => { xmrBackend = b }

const ETA: Record<Family, Record<Speed, string>> = {
  btc: { slow: '~1 hour', normal: '~30 min', fast: '~10 min' },
  ltc: { slow: '~10 min', normal: '~5 min', fast: '~2.5 min' },
  doge: { slow: '~5 min', normal: '~2 min', fast: '~1 min' },
  evm: { slow: '~1 min', normal: '~30 sec', fast: '~15 sec' },
  sol: { slow: '~10 sec', normal: '~3 sec', fast: '~1 sec' },
  trx: { slow: '~3 sec', normal: '~3 sec', fast: '~3 sec' },
  xmr: { slow: '~20 min', normal: '~20 min', fast: '~20 min' }
}

const fail = (a: Asset, error: string, extra: Partial<Quote> = {}): Quote => ({ ok: false, error, amount: 0, fee: 0, feeAsset: networkOf(a.id).native, maxAmount: 0, eta: '', notes: [], ...extra })
const toNum = (v: bigint, d: number) => Number(v) / 10 ** d

// ---------- address validation ----------
const LTC_NET = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 }
const DOGE_NET = { bech32: 'doge', pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e }
const UTXO_NET = { btc: btc.NETWORK, ltc: LTC_NET, doge: DOGE_NET } as const

export function validateAddress(assetId: string, to: string): boolean {
  const fam = networkOf(assetId).family
  to = to.trim()
  try {
    switch (fam) {
      case 'evm': return isAddress(to, { strict: false })
      case 'sol': return new PublicKey(to).toBytes().length === 32 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)
      case 'btc': case 'ltc': case 'doge': btc.Address(UTXO_NET[fam]).decode(to); return true
      case 'trx': { const b = tronDecode(to); return b.length === 21 && b[0] === 0x41 }
      case 'xmr': { const b = moneroBase58Decode(to); return (b.length === 69 || b.length === 77) && [0x12, 0x2a, 0x13].includes(b[0]) }
    }
  } catch {
    return false
  }
}

// ---------- EVM ----------
const CHAINS: Record<string, Chain> = { ethereum: mainnet, arbitrum, base, optimism, polygon, bsc, avalanche }
const evmClient = (network: string) => createPublicClient({
  chain: CHAINS[network],
  transport: fallback(NETWORKS[network].rpc.map((u) => http(u, { fetchFn: (url, init) => net(String(url), init) })))
})
const SPEED_MULT: Record<Speed, number> = { slow: 0.9, normal: 1.1, fast: 1.5 }
const mul = (v: bigint, m: number) => (v * BigInt(Math.round(m * 1000))) / 1000n

async function evmPlan(a: Asset, req: SendRequest, from: `0x${string}`) {
  const c = evmClient(a.network)
  const net = NETWORKS[a.network]
  const native = ASSET[net.native]
  const [fees, nativeBal] = await Promise.all([c.estimateFeesPerGas(), c.getBalance({ address: from })])
  const maxPriorityFeePerGas = mul(fees.maxPriorityFeePerGas, SPEED_MULT[req.speed])
  const maxFeePerGas = mul(fees.maxFeePerGas, SPEED_MULT[req.speed]) > maxPriorityFeePerGas ? mul(fees.maxFeePerGas, SPEED_MULT[req.speed]) : maxPriorityFeePerGas
  const to = getAddress(req.to.trim())
  let tokenBal = 0n
  if (a.kind === 'token') tokenBal = await c.readContract({ address: a.contract as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [from] })
  const amountFor = (gasCost: bigint) => a.kind === 'native' ? (req.max ? nativeBal - gasCost : parseUnits(req.amount || '0', a.decimals)) : (req.max ? tokenBal : parseUnits(req.amount || '0', a.decimals))
  const txFor = (value: bigint) => a.kind === 'native'
    ? { to, value, data: undefined as `0x${string}` | undefined }
    : { to: a.contract as `0x${string}`, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, value] }) }
  let gas: bigint
  try {
    const probe = txFor(a.kind === 'native' ? 1n : amountFor(0n) > 0n ? amountFor(0n) : 1n)
    gas = mul(await c.estimateGas({ account: from, ...probe }), 1.2)
  } catch {
    gas = a.kind === 'native' ? 21000n : 90000n
  }
  if (a.kind === 'native' && gas < 21000n) gas = 21000n
  let l1Fee = 0n
  if (a.network === 'base' || a.network === 'optimism') {
    try { l1Fee = mul(await c.extend(publicActionsL2()).estimateL1Fee({ account: from, ...txFor(1n) } as any), 1.5) } catch { l1Fee = 30_000_000_000_000n }
  }
  const feeWei = gas * maxFeePerGas + l1Fee
  const amount = amountFor(feeWei)
  return { c, net, native, gas, maxFeePerGas, maxPriorityFeePerGas, feeWei, amount, nativeBal, tokenBal, tx: txFor(amount > 0n ? amount : 0n) }
}

// ---------- Solana ----------
const solConn = () => new Connection(NETWORKS.solana.rpc[0], { commitment: 'confirmed', fetch: (u: any, i: any) => net(String(u), i) as any })
const SOL_PRICE: Record<Speed, number> = { slow: 0, normal: 50_000, fast: 500_000 } // micro-lamports per CU
const TOKEN_ACCOUNT_RENT = 2_039_280

async function solPlan(a: Asset, req: SendRequest, fromB58: string) {
  const conn = solConn()
  const from = new PublicKey(fromB58)
  const to = new PublicKey(req.to.trim())
  const cuLimit = a.kind === 'native' ? 1_000 : 60_000
  const priority = Math.ceil((SOL_PRICE[req.speed] * cuLimit) / 1e6)
  const lamports = BigInt(await conn.getBalance(from))
  const notes: string[] = []
  let rent = 0
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit })]
  if (priority > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SOL_PRICE[req.speed] }))
  let amount: bigint
  if (a.kind === 'native') {
    const fee = BigInt(5000 + priority)
    amount = req.max ? lamports - fee : parseUnits(req.amount || '0', 9)
    const exists = await conn.getAccountInfo(to)
    const minRent = BigInt(await conn.getMinimumBalanceForRentExemption(0))
    if (!exists && amount > 0n && amount < minRent) throw new Error(`This address is empty, so the first transfer must be at least ${toNum(minRent, 9)} SOL`)
    const left = lamports - amount - fee
    if (left > 0n && left < minRent && !req.max) notes.push('Leaves less than the rent minimum. Send max instead, or keep at least 0.00089 SOL.')
    ixs.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: amount }))
    return { conn, ixs, fee: 5000 + priority, amount, lamports, notes, decimals: 9, tokenBal: 0n }
  }
  if (!PublicKey.isOnCurve(to.toBytes())) throw new Error('That address is a program account, not a wallet. Tokens sent there could be lost.')
  const mint = new PublicKey(a.contract!)
  const fromAta = getAssociatedTokenAddressSync(mint, from)
  const toAta = getAssociatedTokenAddressSync(mint, to)
  const [bal, toInfo] = await Promise.all([conn.getTokenAccountBalance(fromAta).catch(() => null), conn.getAccountInfo(toAta)])
  const tokenBal = BigInt(bal?.value.amount ?? '0')
  amount = req.max ? tokenBal : parseUnits(req.amount || '0', a.decimals)
  if (!toInfo) {
    rent = TOKEN_ACCOUNT_RENT
    notes.push(`The recipient has no ${a.symbol} account yet. Creating it costs ~0.002 SOL rent, included in the fee.`)
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(from, toAta, to, mint))
  }
  ixs.push(createTransferCheckedInstruction(fromAta, mint, toAta, from, amount, a.decimals))
  return { conn, ixs, fee: 5000 + priority + rent, amount, lamports, notes, decimals: a.decimals, tokenBal }
}

// ---------- UTXO: BTC / LTC / DOGE ----------
interface Utxo { txid: string; vout: number; value: number }
async function utxoState(fam: 'btc' | 'ltc' | 'doge', address: string, speed: Speed) {
  const n = NETWORKS[fam === 'btc' ? 'bitcoin' : fam === 'ltc' ? 'litecoin' : 'dogecoin']
  let utxos: Utxo[]
  let feePerByte: number
  if (fam === 'doge') {
    const [j, info] = await Promise.all([getJson(`${n.rpc[0]}/addrs/${address}?unspentOnly=true&limit=200`), getJson(n.rpc[0])])
    utxos = [...(j.txrefs ?? []), ...(j.unconfirmed_txrefs ?? [])].map((r: any) => ({ txid: r.tx_hash, vout: r.tx_output_n, value: r.value }))
    const perKb = { slow: info.low_fee_per_kb, normal: info.medium_fee_per_kb, fast: info.high_fee_per_kb }[speed] ?? 1_000_000
    feePerByte = Math.max(1000, Math.ceil(perKb / 1000))
  } else {
    utxos = (await getJson(`${n.rpc[0]}/api/address/${address}/utxo`)).map((u: any) => ({ txid: u.txid, vout: u.vout, value: u.value }))
    let rec: any = null
    try { rec = await getJson(`${n.rpc[0]}/api/v1/fees/recommended`) } catch { /* fall back */ }
    const fallbackRate = fam === 'btc' ? { slow: 3, normal: 6, fast: 12 } : { slow: 1, normal: 2, fast: 4 }
    feePerByte = rec ? { slow: rec.hourFee, normal: rec.halfHourFee, fast: rec.fastestFee }[speed] : fallbackRate[speed]
    feePerByte = Math.max(1, Math.ceil(feePerByte))
    // a fee rate no real network has asked for: a broken or hostile explorer, not a busy mempool
    if (feePerByte > (fam === 'btc' ? 1000 : 500)) throw new Error(`The fee rate from the explorer (${feePerByte} sat/vB) looks wrong. Try again later`)
  }
  return { utxos, feePerByte, network: n }
}

function utxoSelect(fam: 'btc' | 'ltc' | 'doge', pub: Uint8Array, from: string, utxos: Utxo[], to: string, amount: bigint, max: boolean, feePerByte: number) {
  const network = UTXO_NET[fam]
  const script = fam === 'doge' ? btc.p2pkh(pub, network).script : btc.p2wpkh(pub, network).script
  // BTC/LTC signal replace-by-fee, so a stuck payment can be sped up later
  const inputs = utxos.map((u) => ({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: BigInt(u.value) }, ...(fam === 'doge' ? {} : { sequence: RBF_SEQ }) }))
  const opts = { feePerByte: BigInt(feePerByte), network, createTx: true, bip69: true, allowLegacyWitnessUtxo: fam === 'doge', dust: fam === 'doge' ? 1_000_000n : undefined, changeAddress: max ? to : from }
  return max ? btc.selectUTXO(inputs, [], 'all', opts) : btc.selectUTXO(inputs, [{ address: to, amount }], 'default', opts)
}

// ---------- Tron ----------
const TRON = NETWORKS.tron.rpc[0]
const tronPost = (path: string, body: unknown) => getJson(`${TRON}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const tronParam = (to: string, amount: bigint) => bytesToHex(tronDecode(to).slice(1)).padStart(64, '0') + amount.toString(16).padStart(64, '0')

async function tronPlan(a: Asset, req: SendRequest, from: string) {
  const [res, params, toAcc, fromAcc] = await Promise.all([
    tronPost('/wallet/getaccountresource', { address: from, visible: true }),
    getJson(`${TRON}/wallet/getchainparameters`),
    tronPost('/wallet/getaccount', { address: req.to.trim(), visible: true }),
    tronPost('/wallet/getaccount', { address: from, visible: true })
  ])
  const p = (k: string) => params.chainParameter.find((x: any) => x.key === k)?.value ?? 0
  const bandwidthLeft = (res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0) + (res.NetLimit ?? 0) - (res.NetUsed ?? 0)
  const trxBal = BigInt(fromAcc.balance ?? 0)
  const notes: string[] = []
  const recipientNew = !toAcc.address
  if (a.kind === 'native') {
    const bw = bandwidthLeft >= 300 ? 0 : 300 * p('getTransactionFee')
    const activation = recipientNew ? p('getCreateNewAccountFeeInSystemContract') + p('getCreateAccountFee') : 0
    if (recipientNew) notes.push('The recipient address is new to Tron, so a one-time activation fee applies.')
    const fee = BigInt(bw + activation)
    const amount = req.max ? trxBal - fee : parseUnits(req.amount || '0', 6)
    return { fee, amount, trxBal, tokenBal: 0n, feeLimit: 0, notes }
  }
  let tokenBal = 0n
  if (fromAcc.address) {
    const r = await tronPost('/wallet/triggerconstantcontract', { owner_address: from, contract_address: a.contract, function_selector: 'balanceOf(address)', parameter: bytesToHex(tronDecode(from).slice(1)).padStart(64, '0'), visible: true })
    if (r.constant_result?.[0]) tokenBal = BigInt('0x' + r.constant_result[0])
  }
  const amount = req.max ? tokenBal : parseUnits(req.amount || '0', a.decimals)
  const sim = await tronPost('/wallet/triggerconstantcontract', { owner_address: from, contract_address: a.contract, function_selector: 'transfer(address,uint256)', parameter: tronParam(req.to.trim(), amount > 0n ? amount : 1n), visible: true })
  const energy = sim.energy_used ?? (recipientNew ? 130_000 : 65_000)
  const energyLeft = (res.EnergyLimit ?? 0) - (res.EnergyUsed ?? 0)
  const energyCost = Math.max(0, energy - energyLeft) * p('getEnergyFee')
  const bw = bandwidthLeft >= 350 ? 0 : 350 * p('getTransactionFee')
  const fee = BigInt(energyCost + bw)
  if (energyCost > 0) notes.push(`Tron burns TRX for energy on token transfers (${energy.toLocaleString()} energy).`)
  return { fee, amount, trxBal, tokenBal, feeLimit: Math.min(150_000_000, Math.max(Number(fee) * 2, 20_000_000)), notes }
}

function tronSign(txID: string, rawHex: string, priv: Uint8Array): string {
  if (bytesToHex(sha256(hexToBytes(rawHex))) !== txID) throw new Error('Tron node returned a mismatched transaction')
  const sig = secp256k1.sign(hexToBytes(txID), priv, { prehash: false, format: 'recovered' }) // [rec, r, s]
  return bytesToHex(sig.slice(1)) + (sig[0] + 27).toString(16).padStart(2, '0')
}

// ---------- public API ----------
export async function quote(req: SendRequest, addrs: Addresses, keyFor?: KeyFor): Promise<Quote> {
  const a = ASSET[req.assetId]
  if (!a) throw new Error('Unknown asset')
  const fam = networkOf(a.id).family
  const feeAsset = networkOf(a.id).native
  if (!validateAddress(a.id, req.to)) return fail(a, req.to ? `That isn't a valid ${NETWORKS[a.network].name} address` : '')
  if (fam === 'xmr') {
    if (!xmrBackend) return fail(a, 'Monero is still connecting')
    const max = Number((await xmrBackend.unlocked()) ?? 0)
    if (!req.max && !(Number(req.amount) > 0)) return { ...fail(a, 'Enter an amount'), maxAmount: max, eta: ETA.xmr[req.speed] }
    try {
      const q = await xmrBackend.quote(req.to.trim(), req.amount, req.speed, !!req.max)
      return { ok: true, amount: q.amount, fee: q.fee, feeAsset: 'xmr', maxAmount: Math.max(0, max - q.fee), eta: ETA.xmr[req.speed], notes: ['Monero hides sender, receiver and amount. Funds become spendable after 10 confirmations (~20 min).'] }
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      return { ...fail(a, /not enough|insufficient/i.test(msg) ? 'Not enough unlocked XMR (new funds unlock after ~20 min)' : msg.slice(0, 160)), maxAmount: max, eta: ETA.xmr[req.speed] }
    }
  }
  const from = addrs[fam]!
  if (req.to.trim() === from) return fail(a, "That's your own address")
  const base: Omit<Quote, 'ok' | 'amount' | 'fee' | 'maxAmount'> = { feeAsset, eta: ETA[fam][req.speed], notes: [] }
  try {
    if (fam === 'evm') {
      const p = await evmPlan(a, req, from as `0x${string}`)
      const max = a.kind === 'native' ? p.nativeBal - p.feeWei : p.tokenBal
      const q: Quote = { ...base, ok: true, amount: toNum(p.amount, a.decimals), fee: toNum(p.feeWei, 18), maxAmount: toNum(max > 0n ? max : 0n, a.decimals) }
      if (p.amount <= 0n) return { ...q, ok: false, error: 'Enter an amount' }
      if (a.kind === 'native' ? p.amount + p.feeWei > p.nativeBal : p.amount > p.tokenBal) return { ...q, ok: false, error: `Not enough ${a.symbol}` }
      if (a.kind === 'token' && p.feeWei > p.nativeBal) return { ...q, ok: false, error: `You need ${ASSET[feeAsset].symbol} on ${p.net.name} to pay the network fee` }
      return q
    }
    if (fam === 'sol') {
      const p = await solPlan(a, req, from)
      const max = a.kind === 'native' ? p.lamports - BigInt(p.fee) : p.tokenBal
      const q: Quote = { ...base, notes: p.notes, ok: true, amount: toNum(p.amount, p.decimals), fee: p.fee / 1e9, maxAmount: toNum(max > 0n ? max : 0n, p.decimals) }
      if (p.amount <= 0n) return { ...q, ok: false, error: 'Enter an amount' }
      if (a.kind === 'native' ? p.amount + BigInt(p.fee) > p.lamports : p.amount > p.tokenBal) return { ...q, ok: false, error: `Not enough ${a.symbol}` }
      if (a.kind === 'token' && BigInt(p.fee) > p.lamports) return { ...q, ok: false, error: 'You need a little SOL to pay the network fee' }
      return q
    }
    if (fam === 'btc' || fam === 'ltc' || fam === 'doge') {
      const s = await utxoState(fam, from, req.speed)
      const pub = keyFor?.(fam).pub
      if (!pub) return { ...base, ok: false, error: 'Locked', amount: 0, fee: 0, maxAmount: 0 }
      const total = s.utxos.reduce((x, u) => x + BigInt(u.value), 0n)
      const all = s.utxos.length ? utxoSelect(fam, pub, from, s.utxos, req.to.trim(), 0n, true, s.feePerByte) : undefined
      const maxAmount = all?.change ? toNum(all.tx!.getOutput(0).amount!, 8) : 0
      const amount = req.max ? BigInt(Math.round(maxAmount * 1e8)) : parseUnits(req.amount || '0', 8)
      if (amount <= 0n) return { ...base, ok: false, error: total ? 'Enter an amount' : `No ${a.symbol} to send`, amount: 0, fee: 0, maxAmount }
      const sel = req.max ? all : utxoSelect(fam, pub, from, s.utxos, req.to.trim(), amount, false, s.feePerByte)
      if (!sel) return { ...base, ok: false, error: `Not enough ${a.symbol} (including the network fee)`, amount: toNum(amount, 8), fee: 0, maxAmount }
      return { ...base, ok: true, amount: toNum(amount, 8), fee: toNum(sel.fee!, 8), maxAmount }
    }
    if (fam === 'trx') {
      const p = await tronPlan(a, req, from)
      const max = a.kind === 'native' ? p.trxBal - p.fee : p.tokenBal
      const q: Quote = { ...base, notes: p.notes, ok: true, amount: toNum(p.amount, a.decimals), fee: toNum(p.fee, 6), maxAmount: toNum(max > 0n ? max : 0n, a.decimals) }
      if (p.amount <= 0n) return { ...q, ok: false, error: 'Enter an amount' }
      if (a.kind === 'native' ? p.amount + p.fee > p.trxBal : p.amount > p.tokenBal) return { ...q, ok: false, error: `Not enough ${a.symbol}` }
      if (a.kind === 'token' && p.fee > p.trxBal) return { ...q, ok: false, error: 'You need TRX to pay for energy on this transfer' }
      return q
    }
  } catch (e: any) {
    return fail(a, e?.shortMessage ?? e?.message ?? 'Could not reach the network')
  }
  return fail(a, 'Unsupported')
}

export async function execute(req: SendRequest, addrs: Addresses, keyFor: KeyFor): Promise<{ txid: string; network: string }> {
  const a = ASSET[req.assetId]
  const fam = networkOf(a.id).family
  const q = await quote(req, addrs, keyFor)
  if (!q.ok) throw new Error(q.error || 'Cannot send')
  if (fam === 'xmr') {
    if (!xmrBackend) throw new Error('Monero is still connecting')
    const r = await xmrBackend.send(req.to.trim(), req.amount, req.speed, !!req.max)
    return { txid: r.txid, network: 'monero' }
  }
  const from = addrs[fam]!
  const key = keyFor(fam)
  if (key.hw) return sendWithDevice(a, fam, req, from, key.pub, key.hw)
  const { priv, pub } = key
  try {
    if (fam === 'evm') {
      const p = await evmPlan(a, req, from as `0x${string}`)
      const account = privateKeyToAccount(`0x${bytesToHex(priv)}`)
      if (account.address.toLowerCase() !== from.toLowerCase()) throw new Error('Key mismatch')
      const nonce = await p.c.getTransactionCount({ address: account.address, blockTag: 'pending' })
      const signed = await account.signTransaction({ chainId: p.net.chainId!, type: 'eip1559', nonce, gas: p.gas, maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas, ...p.tx })
      return { txid: await p.c.sendRawTransaction({ serializedTransaction: signed }), network: a.network }
    }
    if (fam === 'sol') {
      const p = await solPlan(a, req, from)
      const kp = Keypair.fromSeed(priv)
      if (kp.publicKey.toBase58() !== from) throw new Error('Key mismatch')
      const { blockhash, lastValidBlockHeight } = await p.conn.getLatestBlockhash()
      const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(...p.ixs)
      tx.sign(kp)
      return { txid: await p.conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 }), network: a.network }
    }
    if (fam === 'btc' || fam === 'ltc' || fam === 'doge') {
      const s = await utxoState(fam, from, req.speed)
      const amount = req.max ? 0n : parseUnits(req.amount || '0', 8)
      const sel = utxoSelect(fam, pub, from, s.utxos, req.to.trim(), amount, !!req.max, s.feePerByte)
      if (!sel?.tx) throw new Error('Not enough funds')
      sel.tx.sign(priv)
      sel.tx.finalize()
      const hex = sel.tx.hex
      if (fam === 'doge') {
        const r = await getJson(`${s.network.rpc[0]}/txs/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: hex }) })
        return { txid: r.tx?.hash ?? sel.tx.id, network: s.network.id }
      }
      const r = await net(`${s.network.rpc[0]}/api/tx`, { method: 'POST', body: hex })
      const text = await r.text()
      if (!r.ok) throw new Error(text.slice(0, 200))
      return { txid: text.trim(), network: s.network.id }
    }
    if (fam === 'trx') {
      const p = await tronPlan(a, req, from)
      const tx = a.kind === 'native'
        ? await tronPost('/wallet/createtransaction', { owner_address: from, to_address: req.to.trim(), amount: Number(p.amount), visible: true })
        : (await tronPost('/wallet/triggersmartcontract', { owner_address: from, contract_address: a.contract, function_selector: 'transfer(address,uint256)', parameter: tronParam(req.to.trim(), p.amount), fee_limit: p.feeLimit, call_value: 0, visible: true })).transaction
      if (!tx?.txID) throw new Error(tx?.Error ?? 'Tron node refused the transaction')
      const v = tx.raw_data.contract[0].parameter.value
      const ok = a.kind === 'native'
        ? v.owner_address === from && v.to_address === req.to.trim() && BigInt(v.amount) === p.amount
        : v.owner_address === from && v.contract_address === a.contract && v.data?.toLowerCase().endsWith(tronParam(req.to.trim(), p.amount).toLowerCase())
      if (!ok) throw new Error('Tron node returned a transaction that does not match your request')
      const r = await tronPost('/wallet/broadcasttransaction', { ...tx, signature: [tronSign(tx.txID, tx.raw_data_hex, priv)] })
      if (!r.result) throw new Error(r.message ? Buffer.from(r.message, 'hex').toString() : 'Broadcast failed')
      return { txid: tx.txID, network: a.network }
    }
  } finally {
    priv.fill(0)
  }
  throw new Error('Unsupported')
}

/** A device's signature for one SegWit input: must be by this account's key, over this input's own hash, SIGHASH_ALL. */
function checkDeviceSig(tx: btc.Transaction, i: number, pub: Uint8Array, sig: { pubkey: Uint8Array; signature: Uint8Array }) {
  const prevOut = tx.getInput(i).witnessUtxo
  if (!prevOut) throw new Error('Missing the coin this input spends')
  if (bytesToHex(sig.pubkey) !== bytesToHex(pub) || bytesToHex(btc.p2wpkh(pub).script) !== bytesToHex(prevOut.script)) throw new Error('The device signed with a key that is not this account’s')
  if (sig.signature[sig.signature.length - 1] !== btc.SigHash.ALL) throw new Error('The device used an unexpected signature type')
  const hash = tx.preimageWitnessV0(i, btc.p2pkh(pub).script, btc.SigHash.ALL, prevOut.amount)
  if (!secp256k1.verify(sig.signature.subarray(0, -1), hash, pub, { prehash: false, format: 'der' })) throw new Error('The device returned a signature that does not match this payment')
}

/**
 * The same payments as execute(), signed on a hardware wallet. Each one is checked after signing: the signature
 * must come from this account's address for exactly this transaction, or nothing is broadcast.
 */
async function sendWithDevice(a: Asset, fam: Family, req: SendRequest, from: string, pub: Uint8Array, hw: HwSigner): Promise<{ txid: string; network: string }> {
  if (fam === 'evm' && hw.evm) {
    const p = await evmPlan(a, req, from as `0x${string}`)
    const nonce = await p.c.getTransactionCount({ address: from as `0x${string}`, blockTag: 'pending' })
    const tx = { chainId: p.net.chainId!, type: 'eip1559' as const, nonce, gas: p.gas, maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas, ...p.tx }
    const signed = serializeTransaction(tx, await hw.evm(serializeTransaction(tx)))
    if ((await recoverTransactionAddress({ serializedTransaction: signed })).toLowerCase() !== from.toLowerCase()) throw new Error('The device signed with a different address than this account')
    return { txid: await p.c.sendRawTransaction({ serializedTransaction: signed }), network: a.network }
  }
  if (fam === 'sol' && hw.sol) {
    const p = await solPlan(a, req, from)
    const payer = new PublicKey(from)
    const { blockhash, lastValidBlockHeight } = await p.conn.getLatestBlockhash()
    const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...p.ixs)
    tx.addSignature(payer, Buffer.from(await hw.sol(tx.serializeMessage())))
    if (!tx.verifySignatures()) throw new Error('The device signature does not match this account')
    return { txid: await p.conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 }), network: a.network }
  }
  if (fam === 'btc' && hw.btc && hw.btcOrigin) {
    if (btc.p2wpkh(hw.btcOrigin.pubkey).address !== from) throw new Error('This account’s Bitcoin key and address don’t match. Nothing was sent')
    const s = await utxoState('btc', from, req.speed)
    const amount = req.max ? 0n : parseUnits(req.amount || '0', 8)
    const sel = utxoSelect('btc', pub, from, s.utxos, req.to.trim(), amount, !!req.max, s.feePerByte)
    if (!sel?.tx) throw new Error('Not enough funds')
    const tx = sel.tx, origin = { fingerprint: hw.btcOrigin.fingerprint, path: btc.bip32Path(hw.btcOrigin.path) }
    // the Bitcoin app wants each input's whole previous transaction (its guard against the SegWit fee attack)
    // and the key origin, so it knows the input is this account's
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i), id = bytesToHex(inp.txid!)
      const r = await net(`${s.network.rpc[0]}/api/tx/${id}/hex`)
      if (!r.ok) throw new Error('Could not load a previous transaction for the device to check')
      const raw = hexToBytes((await r.text()).trim())
      // the explorer's copy must be that very transaction, and the coin in it the one being spent
      const prev = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true })
      const out = prev.id === id ? prev.getOutput(inp.index!) : undefined
      if (!out || out.amount !== inp.witnessUtxo!.amount || bytesToHex(out.script!) !== bytesToHex(inp.witnessUtxo!.script)) throw new Error('The explorer returned a previous transaction that doesn’t match this coin. Nothing was sent')
      tx.updateInput(i, { nonWitnessUtxo: raw, bip32Derivation: [[hw.btcOrigin.pubkey, origin]] })
    }
    const sigs = await hw.btc(tx.toPSBT(0))
    if (sigs.length !== tx.inputsLength || new Set(sigs.map(([i]) => i)).size !== tx.inputsLength) throw new Error('The device did not sign every input')
    // finalize() trusts what it's given, so each signature is checked here: this account's key, this input, SIGHASH_ALL
    for (const [i, sig] of sigs) { checkDeviceSig(tx, i, hw.btcOrigin.pubkey, sig); tx.updateInput(i, { partialSig: [[sig.pubkey, sig.signature]] }) }
    tx.finalize()
    const r = await net(`${s.network.rpc[0]}/api/tx`, { method: 'POST', body: tx.hex })
    const text = await r.text()
    if (!r.ok) throw new Error(text.slice(0, 200))
    return { txid: text.trim(), network: s.network.id }
  }
  throw new Error(`A hardware-wallet account here can send ETH and its networks, Bitcoin and Solana. ${a.symbol} isn't one of them yet`)
}

export const _internal = { tronSign, utxoSelect, UTXO_NET, sendWithDevice }
export const RBF_SEQ = 0xfffffffd

// Speed-up and cancel share the checks and the fee rules: same inputs, a higher fee, refuse anything that looks wrong.
const RBF_WORDS = { bump: { nothing: 'speed up', doing: 'Speeding this up' }, cancel: { nothing: 'cancel', doing: 'Cancelling this' } }
async function rbfPlan(fam: 'btc' | 'ltc', txid: string, from: string, kind: keyof typeof RBF_WORDS) {
  const w = RBF_WORDS[kind]
  const base = CHAINS_UTXO[fam]
  const t = await getJson(`${base}/api/tx/${txid}`)
  if (t?.status?.confirmed) throw new Error(`Already confirmed, nothing to ${w.nothing}`)
  if (!t?.vin?.length || t.vin.some((i: any) => i.prevout?.scriptpubkey_address !== from)) throw new Error('This payment was not sent from this wallet')
  const rec = await getJson(`${base}/api/v1/fees/recommended`).catch(() => null)
  const vsize = Math.ceil(Number(t.weight) / 4)
  const oldFee = Number(t.fee), oldRate = oldFee / vsize
  const rate = Math.ceil(Math.max(rec?.fastestFee ?? 0, oldRate * 1.5, oldRate + 2))
  const fee = Math.max(rate * vsize, oldFee + vsize + 1) // replacements must pay at least 1 sat/vB more in total
  if (rate > Math.max(500, (rec?.fastestFee ?? 0) * 3)) throw new Error('That fee would be unusually high, so Astrala stopped. Try again in a few minutes')
  if (fee - oldFee > 0.002e8) throw new Error(`${w.doing} would cost over 0.002 in extra fees, so Astrala stopped`)
  return { base, t, fee, oldFee, rate }
}
async function rbfSend(fam: 'btc' | 'ltc', p: Awaited<ReturnType<typeof rbfPlan>>, outs: { script: string; value: number }[], keyFor: KeyFor, dry: boolean, tag: string) {
  const { priv, pub } = keyFor(fam)
  try {
    const network = UTXO_NET[fam]
    const script = btc.p2wpkh(pub, network).script
    const tx = new btc.Transaction({ allowUnknownOutputs: true })
    for (const i of p.t.vin) tx.addInput({ txid: i.txid, index: i.vout, witnessUtxo: { script, amount: BigInt(i.prevout.value) }, sequence: RBF_SEQ })
    for (const o of outs) tx.addOutput({ script: hexToBytes(o.script), amount: BigInt(o.value) })
    tx.sign(priv)
    tx.finalize()
    if (dry) return { txid: `dry:${tag}:${tx.hex.slice(0, 64)}`, fee: p.fee / 1e8, rate: p.rate, raw: tx.hex }
    const r = await net(`${p.base}/api/tx`, { method: 'POST', body: tx.hex })
    const text = await r.text()
    if (!r.ok) throw new Error(/insufficient fee|rejecting replacement/i.test(text) ? 'The network wants an even higher fee. Try again in a minute.' : text.slice(0, 200))
    return { txid: text.trim(), fee: p.fee / 1e8, rate: p.rate }
  } finally { priv.fill(0) }
}

/** Speed up a stuck BTC/LTC payment: the same transaction again, paying a higher fee out of its change. */
export async function bumpFee(fam: 'btc' | 'ltc', txid: string, from: string, keyFor: KeyFor, dry = false): Promise<{ txid: string; fee: number; rate: number }> {
  const p = await rbfPlan(fam, txid, from, 'bump')
  const outs = p.t.vout.map((o: any) => ({ address: o.scriptpubkey_address as string | undefined, script: o.scriptpubkey as string, value: Number(o.value) }))
  const ci = outs.map((o: any) => o.address).lastIndexOf(from)
  if (ci < 0 || outs.filter((o: any) => o.address === from).length === outs.length) throw new Error('This payment has no change to pay a higher fee from')
  outs[ci].value -= p.fee - p.oldFee
  if (outs[ci].value < 1000) throw new Error('Not enough change left to raise the fee')
  return rbfSend(fam, p, outs, keyFor, dry, 'bump')
}

/** Cancel a stuck BTC/LTC payment: spend the same inputs again, all of it back to our own address, at a higher fee (replace-by-fee). */
export async function cancelTx(fam: 'btc' | 'ltc', txid: string, from: string, keyFor: KeyFor, dry = false): Promise<{ txid: string; fee: number; rate: number; raw?: string }> {
  const p = await rbfPlan(fam, txid, from, 'cancel')
  const back = p.t.vin.reduce((s: number, i: any) => s + Number(i.prevout.value), 0) - p.fee
  if (back < 1000) throw new Error('Too little would come back after the higher fee, so Astrala stopped')
  const script = bytesToHex(btc.OutScript.encode(btc.Address(UTXO_NET[fam]).decode(from)))
  return rbfSend(fam, p, [{ script, value: back }], keyFor, dry, 'cancel')
}

/** Cancel a stuck EVM payment: a 0-value transaction to ourselves with the same nonce and higher fees, so it replaces the stuck one. */
export async function cancelEvm(network: string, txid: string, from: string, keyFor: KeyFor, dry = false): Promise<{ txid: string; fee: number; raw?: string }> {
  const n = NETWORKS[network]
  if (n?.family !== 'evm') throw new Error('Not an EVM network')
  const c = evmClient(network)
  const t = await c.getTransaction({ hash: txid as `0x${string}` }).catch(() => null)
  if (!t) throw new Error("This payment isn't on the network any more, so there's nothing to cancel")
  if (t.blockNumber != null) throw new Error('Already confirmed, nothing to cancel')
  if (t.from.toLowerCase() !== from.toLowerCase()) throw new Error('This payment was not sent from this wallet')
  const [fees, bal] = await Promise.all([c.estimateFeesPerGas(), c.getBalance({ address: from as `0x${string}` })])
  const up = (v: bigint) => (v * 125n + 99n) / 100n // at least 1.25×, rounded up
  const big = (...v: bigint[]) => v.reduce((a, b) => (b > a ? b : a))
  const oldMax = t.maxFeePerGas ?? t.gasPrice ?? 0n, oldTip = t.maxPriorityFeePerGas ?? t.gasPrice ?? 0n
  const maxPriorityFeePerGas = big(up(oldTip), fees.maxPriorityFeePerGas)
  const maxFeePerGas = big(up(oldMax), fees.maxFeePerGas, maxPriorityFeePerGas)
  if (maxFeePerGas > fees.maxFeePerGas * 3n) throw new Error('That fee would be unusually high, so Astrala stopped. Try again in a few minutes')
  const gas = 21_000n
  if (bal < gas * maxFeePerGas) throw new Error(`Not enough ${ASSET[n.native].symbol} on ${n.name} to pay the cancel fee`)
  const { priv } = keyFor('evm')
  try {
    const account = privateKeyToAccount(`0x${bytesToHex(priv)}`)
    if (account.address.toLowerCase() !== from.toLowerCase()) throw new Error('Key mismatch')
    const signed = await account.signTransaction({ chainId: n.chainId!, type: 'eip1559', nonce: t.nonce, gas, maxFeePerGas, maxPriorityFeePerGas, to: account.address, value: 0n })
    const fee = toNum(gas * maxFeePerGas, 18)
    if (dry) return { txid: `dry:cancel:${keccak256(signed)}`, fee, raw: signed }
    return { txid: await c.sendRawTransaction({ serializedTransaction: signed }), fee }
  } finally { priv.fill(0) }
}
const CHAINS_UTXO = { btc: NETWORKS.bitcoin.rpc[0], ltc: NETWORKS.litecoin.rpc[0] }
// shared with the swap engine
export { evmClient, solConn, utxoState, tronPost, tronSign, mul, SPEED_MULT, UTXO_NET, ETA, CHAINS }
