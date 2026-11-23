// What a website may ask Astrala to sign, through the browser extension: a message, typed data, or a transaction.
// This file turns the site's raw request into (1) a strict, normalised request and (2) a plain description of it,
// written here from the request itself and main's own registries, never from text the site supplies as a label.
// The description is what the person reviews and what the system prompt repeats before the PIN's approval is issued.
// Signing happens only after that, with the key for the account the site was connected to.
//
// Refused outright (never reach here): eth_sign (a raw hash can be anything, including a transaction),
// pre-built or raw transactions, contract deployment, and anything for an address other than the connected one.
import { decodeFunctionData, formatUnits, getAddress, hexToBytes, isAddress, isHex, keccak256, parseAbi, size, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bytesToHex } from '@noble/hashes/utils.js'
import { ASSET, ASSETS, NETWORKS } from './assets'
import { evmClient, mul, type KeyFor } from './send'

export class DappError extends Error { constructor(public code: number, message: string) { super(message) } }

export type TypedData = { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }
export type DappRequest =
  | { kind: 'message'; raw: Hex; text: string | null } // text: the bytes as readable text, or null if they aren't
  | { kind: 'typed'; typed: TypedData }
  | { kind: 'tx'; to: `0x${string}`; value: bigint; data: Hex }

export interface DappView {
  kind: DappRequest['kind']
  title: string
  /** one clean line for the system prompt */
  summary: string
  lines: { label: string; value: string; mono?: boolean }[]
  warnings: { level: 'danger' | 'warn'; text: string }[]
  /** money this visibly moves out now (native value or a direct token transfer), for the daily limit and Activity */
  spend?: { assetId: string; amount: number; to: string }
  /** set only for the patterns wallet drainers rely on; the Drain guard decides from this */
  risk?: { kind: 'unlimited' | 'collection' | 'permit' | 'hidden' | 'wrong-site'; spender?: string; what?: string }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`
// eslint-disable-next-line no-control-regex
const clean = (s: unknown, max = 160) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').slice(0, max)
/** The site's host for display: only what a hostname can contain, so a crafted origin can't smuggle text into a prompt. */
export const hostOf = (origin: string) => { try { const h = new URL(origin).host; return /^[a-z0-9.\-:[\]]{1,80}$/i.test(h) ? h : 'an unknown site' } catch { return 'an unknown site' } }

function readableText(raw: Hex): string | null {
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(raw))
    // eslint-disable-next-line no-control-regex
    return t.length && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t) ? t : null
  } catch { return null }
}

/** Check and normalise a signing request. `account` is the address the site was connected to; `chainId` its network. */
export function parseDappRequest(method: string, params: unknown[], account: string, chainId: number): DappRequest {
  const mine = (a: unknown) => typeof a === 'string' && isAddress(a) && same(a, account)
  const notMine = () => new DappError(4100, 'That request is for a different address than the one this site is connected to')
  if (method === 'personal_sign') {
    // [message, address], though some sites send them the other way round
    const [a, b] = params
    if (!mine(a) && !mine(b)) throw notMine()
    const msg = mine(b) ? a : b
    if (typeof msg !== 'string') throw new DappError(-32602, 'No message to sign')
    const raw = (isHex(msg) ? msg : `0x${bytesToHex(new TextEncoder().encode(msg))}`) as Hex
    if (size(raw) > 64 * 1024) throw new DappError(-32602, 'That message is too large to review')
    return { kind: 'message', raw, text: readableText(raw) }
  }
  if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData') {
    if (!mine(params[0])) throw notMine()
    let t: any = params[1]
    if (typeof t === 'string') { if (t.length > 256 * 1024) throw new DappError(-32602, 'That request is too large to review'); try { t = JSON.parse(t) } catch { throw new DappError(-32602, 'The typed data is not valid JSON') } }
    if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.primaryType !== 'string' || !t.types || typeof t.types !== 'object' || !t.types[t.primaryType] || !t.domain || typeof t.domain !== 'object' || !t.message || typeof t.message !== 'object')
      throw new DappError(-32602, 'Astrala only signs structured data in the current format (EIP-712 v4)')
    if (t.domain.chainId != null && Number(t.domain.chainId) !== chainId) throw new DappError(4901, 'That request is for a different network than the one this site is on in Astrala')
    return { kind: 'typed', typed: { domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message } }
  }
  if (method === 'eth_sendTransaction') {
    const tx = params[0] as Record<string, unknown> | undefined
    if (!tx || typeof tx !== 'object') throw new DappError(-32602, 'No transaction to send')
    if (!mine(tx.from)) throw notMine()
    if (tx.chainId != null && Number(tx.chainId) !== chainId) throw new DappError(4901, 'That transaction is for a different network than the one this site is on in Astrala')
    if (typeof tx.to !== 'string' || !isAddress(tx.to)) throw new DappError(4200, "Astrala doesn't deploy contracts for websites")
    const data = (tx.data ?? tx.input ?? '0x') as Hex
    if (!isHex(data) || size(data) > 128 * 1024) throw new DappError(-32602, 'The transaction data is not valid')
    let value = 0n
    try { value = tx.value == null ? 0n : BigInt(tx.value as string) } catch { throw new DappError(-32602, 'The amount is not valid') }
    if (value < 0n) throw new DappError(-32602, 'The amount is not valid')
    return { kind: 'tx', to: getAddress(tx.to), value, data }
  }
  throw new DappError(4200, `Astrala doesn't sign ${clean(method, 40)}`)
}

const CALLS = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)'
])
/** At or above this an allowance is unlimited in practice: ~7.9e28 base units, more than any real holding. */
const UNLIMITED = 2n ** 96n

const TYPED_SHOWN = 60
/** Flatten typed data to "path: value" lines, walking the declared types: exactly the fields that get signed, in
 *  their signed order. Keys a site adds to the message outside its types are never signed, so they're never shown
 *  as if they were. Counts every signed field, so a cut-off list can be flagged rather than silently shortened. */
function typedFields(types: Record<string, any>, type: string, v: any, path: string, out: { label: string; value: string; mono?: boolean }[], seen = { total: 0 }, depth = 0) {
  const leaf = (p: string, x: unknown) => {
    seen.total++
    if (out.length < TYPED_SHOWN) out.push({ label: clean(p, 60), value: clean(x != null && typeof x === 'object' ? JSON.stringify(x) : x, 140), mono: typeof x === 'string' && /^0x[0-9a-f]{8,}$/i.test(x) })
  }
  const one = (t: string, x: any, p: string) => {
    const arr = /^(.*)\[(\d*)\]$/.exec(t)
    if (arr) { if (Array.isArray(x)) x.forEach((y, i) => one(arr[1], y, `${p}[${i}]`)); else leaf(p, x); return }
    if (Array.isArray(types[t]) && depth < 8) typedFields(types, t, x, p, out, seen, depth + 1)
    else leaf(p, x)
  }
  for (const fld of Array.isArray(types[type]) ? types[type] : []) {
    if (!fld || typeof fld.name !== 'string' || typeof fld.type !== 'string') continue
    one(fld.type, v?.[fld.name], path ? `${path}.${fld.name}` : fld.name)
  }
  return seen
}

/** Say what a request does, in plain words, from the request alone. No network calls. */
export function describeDapp(req: DappRequest, ctx: { origin: string; network: string }): DappView {
  const host = hostOf(ctx.origin), net = NETWORKS[ctx.network], native = ASSET[net.native]
  const lines: DappView['lines'] = [{ label: 'Website', value: host }, { label: 'Network', value: net.name }]
  const warnings: DappView['warnings'] = []

  if (req.kind === 'message') {
    if (req.text == null) {
      lines.push({ label: 'Data', value: req.raw.length > 140 ? `${req.raw.slice(0, 138)}…` : req.raw, mono: true })
      warnings.push({ level: size(req.raw) === 32 ? 'danger' : 'warn', text: size(req.raw) === 32
        ? 'This is 32 bytes of unreadable data, which is what a hidden order or transaction looks like. A real sign-in is readable text. Only continue if you know exactly what this is.'
        : "This isn't readable text, so Astrala can't show you what it says. Only sign it if you know what it is." })
    } else {
      lines.push({ label: 'Message', value: clean(req.text, 1200) })
      // "example.com wants you to sign in with your Ethereum account": the name in the message must be the site you're on
      const m = /^(?:https?:\/\/)?(\S+) wants you to sign in with your Ethereum account/.exec(req.text)
      if (m && !same(m[1], host)) warnings.push({ level: 'danger', text: `This sign-in says it is for ${clean(m[1], 80)}, but you are on ${host}. That mismatch is how sign-in phishing works.` })
    }
    const risk: DappView['risk'] = req.text == null && size(req.raw) === 32 ? { kind: 'hidden' } : warnings.some((w) => w.level === 'danger') ? { kind: 'wrong-site' } : undefined
    return { kind: 'message', title: 'Sign a message', summary: `Sign a message for ${host}`, lines, warnings, risk }
  }

  if (req.kind === 'typed') {
    const { domain, primaryType, message } = req.typed
    const type = clean(primaryType, 40)
    if (domain.name != null) lines.push({ label: 'For', value: clean(domain.name, 60) })
    if (typeof domain.verifyingContract === 'string') lines.push({ label: 'Contract', value: clean(domain.verifyingContract, 42), mono: true })
    else warnings.push({ level: 'warn', text: 'This request names no contract, so there is no telling where the signature can be used.' })
    lines.push({ label: 'Type', value: type })
    const before = lines.length
    const { total } = typedFields(req.typed.types as Record<string, any>, primaryType, message, '', lines)
    const shown = lines.length - before
    if (total > shown) warnings.push({ level: 'danger', text: `This request signs ${total} fields and only the first ${shown} fit here. Requests that long are how hidden approvals get through. Don't sign unless you know exactly what it is.` })
    const declared = new Set((Array.isArray((req.typed.types as any)[primaryType]) ? (req.typed.types as any)[primaryType] : []).map((x: any) => x?.name))
    const extra = Object.keys(message).filter((k) => !declared.has(k))
    if (extra.length) warnings.push({ level: 'warn', text: `The site added data that isn't part of what you sign (${clean(extra.slice(0, 4).join(', '), 80)}${extra.length > 4 ? '…' : ''}). It's left out above, since it doesn't count.` })
    const spender = (message.spender ?? (message.details as any)?.spender ?? message.operator) as unknown
    const permit = /permit/i.test(primaryType) || (typeof message.spender === 'string' && ['value', 'amount', 'allowed', 'details', 'permitted'].some((k) => k in message))
    const order = primaryType === 'OrderComponents' || /order/i.test(primaryType)
    if (permit) warnings.push({ level: 'danger', text: `This is a permission, not a sign-in. It lets ${typeof spender === 'string' && isAddress(spender) ? short(spender) : 'another address'} take your tokens later, with no further approval from you. It costs nothing to sign, which is why scams use it.` })
    else if (order) warnings.push({ level: 'danger', text: 'This is a trade order. Once signed, anyone can fill it at the terms below, so check every amount and what you are giving up.' })
    else warnings.push({ level: 'warn', text: 'Signing structured data can authorise trades or spending. Read the fields before you continue.' })
    return { kind: 'typed', title: permit ? 'Sign a spending permission' : order ? 'Sign a trade order' : `Sign ${type}`, summary: `${permit ? 'Sign a spending permission' : order ? 'Sign a trade order' : 'Sign structured data'} for ${host}`, lines, warnings,
      risk: permit ? { kind: 'permit', spender: typeof spender === 'string' && isAddress(spender) ? spender : undefined, what: domain.name != null ? clean(domain.name, 40) : undefined } : undefined }
  }

  // a transaction
  const amountNative = Number(formatUnits(req.value, 18))
  const tokenAt = (addr: string) => ASSETS.find((a) => a.network === ctx.network && a.kind === 'token' && a.contract && same(a.contract, addr))
  const tokenAmt = (t: ReturnType<typeof tokenAt>, raw: bigint) => (t ? `${Number(formatUnits(raw, t.decimals))} ${t.symbol}` : `${raw} units of an unlisted token`)
  let call: { functionName: string; args: readonly unknown[] } | null = null
  if (size(req.data) >= 4) { try { call = decodeFunctionData({ abi: CALLS, data: req.data }) as any } catch { call = null } }
  let title = 'Send a transaction', summary = '', spend: DappView['spend'], risk: DappView['risk']
  const token = tokenAt(req.to)

  if (size(req.data) === 0) {
    title = `Send ${native.symbol}`
    lines.push({ label: 'To', value: req.to, mono: true }, { label: 'Amount', value: `${amountNative} ${native.symbol}` })
    summary = `Send ${amountNative} ${native.symbol} to ${short(req.to)} on ${net.name}, asked by ${host}`
    if (req.value > 0n) spend = { assetId: native.id, amount: amountNative, to: req.to }
  } else if (call?.functionName === 'transfer') {
    const [to, raw] = call.args as [string, bigint]
    title = `Send ${token?.symbol ?? 'tokens'}`
    lines.push({ label: 'To', value: to, mono: true }, { label: 'Amount', value: tokenAmt(token, raw) }, { label: 'Token contract', value: req.to, mono: true })
    summary = `Send ${tokenAmt(token, raw)} to ${short(to)} on ${net.name}, asked by ${host}`
    if (token) spend = { assetId: token.id, amount: Number(formatUnits(raw, token.decimals)), to }
    else warnings.push({ level: 'warn', text: "Astrala doesn't list this token, so it can't show the amount in real units or its value." })
  } else if (call?.functionName === 'approve' || call?.functionName === 'increaseAllowance') {
    const [spender, raw] = call.args as [string, bigint]
    const unlimited = raw >= UNLIMITED, what = token?.symbol ?? 'this token' // 2^256-1, 2^255 and 1e40 all count
    title = raw === 0n ? `Remove a ${what} permission` : `Let a contract spend your ${what}`
    lines.push({ label: 'Spender', value: spender, mono: true }, { label: 'Up to', value: unlimited ? `Unlimited ${what}` : tokenAmt(token, raw) }, { label: 'Token contract', value: req.to, mono: true })
    summary = raw === 0n ? `Remove ${short(spender)}'s permission to spend your ${what} on ${net.name}, asked by ${host}` : `Let ${short(spender)} spend ${unlimited ? `unlimited ${what}` : tokenAmt(token, raw)} on ${net.name}, asked by ${host}`
    if (unlimited) risk = { kind: 'unlimited', spender, what }
    if (raw > 0n) warnings.push({ level: unlimited ? 'danger' : 'warn', text: unlimited
      ? `This lets that contract take all of your ${what}, now and in future, without asking again. Sites ask for it to save fees; a malicious one uses it to empty the token.`
      : `This lets that contract take up to that much ${what} without asking again. Nothing moves yet.` })
  } else if (call?.functionName === 'setApprovalForAll') {
    const [operator, on] = call.args as [string, boolean]
    title = on ? 'Let a contract move every item in a collection' : 'Remove a collection permission'
    lines.push({ label: 'Operator', value: operator, mono: true }, { label: 'Collection', value: req.to, mono: true })
    summary = `${on ? 'Let' : 'Stop letting'} ${short(operator)} move everything you hold in collection ${short(req.to)} on ${net.name}, asked by ${host}`
    if (on) risk = { kind: 'collection', spender: operator }
    if (on) warnings.push({ level: 'danger', text: 'This hands that contract every NFT you hold in this collection, now and in future. Marketplaces ask for it; so do drainers.' })
  } else if (call?.functionName === 'transferFrom' || call?.functionName === 'safeTransferFrom') {
    const [from, to, raw] = call.args as [string, string, bigint]
    title = 'Move tokens'
    lines.push({ label: 'From', value: from, mono: true }, { label: 'To', value: to, mono: true }, { label: 'Amount or item', value: token ? tokenAmt(token, raw) : String(raw) }, { label: 'Contract', value: req.to, mono: true })
    summary = `Move ${token ? tokenAmt(token, raw) : `item ${String(raw).slice(0, 24)}`} from ${short(from)} to ${short(to)} on ${net.name}, asked by ${host}`
  } else {
    title = 'Call a contract'
    lines.push({ label: 'Contract', value: req.to, mono: true }, { label: 'Function', value: req.data.slice(0, 10), mono: true }, { label: 'Data', value: `${size(req.data)} bytes` })
    summary = `Call contract ${short(req.to)} on ${net.name}${req.value > 0n ? `, sending ${amountNative} ${native.symbol}` : ''}, asked by ${host}`
    warnings.push({ level: 'warn', text: "Astrala can't tell what this call does. If you approved this contract to spend tokens earlier, it can move them now. Continue only if you trust the site and expected this." })
  }
  if (size(req.data) > 0 && req.value > 0n) {
    lines.push({ label: 'Also sends', value: `${amountNative} ${native.symbol}` })
    if (!spend) spend = { assetId: native.id, amount: amountNative, to: req.to }
  }
  return { kind: 'tx', title, summary, lines, warnings, spend, risk }
}

// ---------- Drain guard ----------
// Wallets get emptied the same few ways: an unlimited token approval or a free "permit" signature to the thief's
// contract, a collection-wide NFT approval, a blob of unreadable data that is really an order, or a sign-in on a
// site pretending to be another. With the guard on these are refused before they reach the review sheet, unless
// the contract being trusted is one Astrala itself knows (the routers and Permit2 it uses for its own swaps).

/** Why the guard refuses this request, as the end of "…blocked it: ", or null to let it through to review. */
export function drainBlock(view: DappView, known: (spender: string) => boolean): string | null {
  const r = view.risk
  if (!r) return null
  if (r.kind === 'hidden') return 'it asked you to sign unreadable data, which is how hidden orders are slipped past people'
  if (r.kind === 'wrong-site') return 'its sign-in message is written for a different website'
  if (r.spender && known(r.spender)) return null
  const who = r.spender ? `an unknown contract (${short(r.spender)})` : 'an unnamed address'
  if (r.kind === 'permit') return `it asked for a signature that lets ${who} take your ${r.what ?? 'tokens'} later`
  if (r.kind === 'unlimited') return `it asked to let ${who} spend unlimited ${r.what ?? 'tokens'}`
  return `it asked to let ${who} move every NFT you hold in a collection`
}

/** Shared hosting where anyone gets a subdomain: a known name as a label there says nothing about who runs it. */
const HOSTING = ['github.io', 'eth.limo', 'eth.link', 'ipfs.io', 'gitbook.io']
const WELL_KNOWN = ['phantom.com', 'uniswap.org', 'opensea.io', 'pancakeswap.finance', '1inch.io', 'curve.fi', 'compound.finance', 'balancer.fi', 'sushi.com', 'stargate.finance', 'pendle.finance', 'ethena.fi',
  'hyperliquid.xyz', 'eigenlayer.xyz', 'ens.domains', 'safe.global', 'etherscan.io', 'arbitrum.io', 'optimism.io', 'metamask.io', 'phantom.app', 'rabby.io', 'coinbase.com', 'kraken.com', 'binance.com',
  'raydium.io', 'jupiter.ag', 'magiceden.io', 'blur.io', 'zora.co', 'lido.fi', 'aave.com', 'rocketpool.net', 'layerzero.network', 'zksync.io', 'polygon.technology', 'thorchain.org', 'thorswap.finance']
const distance = (a: string, b: string) => { // edit distance, small strings only
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
/**
 * Is this site dressed up as a well-known one? Returns the site it imitates, or null. Checks the registered name
 * (the last two labels): look-alike characters (punycode), a near-miss spelling, the real name on another ending
 * (uniswap.xyz), or the real name tucked into a longer one (uniswap-claim.org, uniswap.rewards.io).
 */
export function lookalikeSite(host: string): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, ''), labels = h.split('.')
  if (labels.length < 2 || /^[\d.]+$/.test(h) || h === 'localhost' || h.endsWith('.localhost')) return null
  const domain = labels.slice(-2).join('.'), name = labels[labels.length - 2]
  if (WELL_KNOWN.includes(domain) || WELL_KNOWN.some((k) => h.endsWith('.' + k))) return null
  const hosted = HOSTING.includes(domain)
  if (labels.some((l) => l.startsWith('xn--'))) return 'another site (its address uses look-alike characters)'
  for (const k of WELL_KNOWN) {
    const kn = k.split('.')[0]
    if (kn.length < 5) continue // short names collide with ordinary words
    if (hosted) continue // username.github.io, name.eth.limo: the label is the owner's choice, not an imitation of the domain
    if (name === kn) return k // the real name, a different ending
    if (distance(name, kn) <= (kn.length >= 7 ? 2 : 1)) return k
    if (labels.slice(0, -1).some((l) => l === kn || l.split('-').includes(kn))) return k
  }
  return null
}

function account(keyFor: KeyFor, expect: string) {
  const { priv } = keyFor('evm')
  const a = privateKeyToAccount(`0x${bytesToHex(priv)}`)
  if (!same(a.address, expect)) { priv.fill(0); throw new DappError(4100, 'Key mismatch') }
  return { a, wipe: () => priv.fill(0) }
}

export async function signDappMessage(req: Extract<DappRequest, { kind: 'message' }>, from: string, keyFor: KeyFor): Promise<Hex> {
  const k = account(keyFor, from)
  try { return await k.a.signMessage({ message: { raw: req.raw } }) } finally { k.wipe() }
}
export async function signDappTyped(req: Extract<DappRequest, { kind: 'typed' }>, from: string, keyFor: KeyFor): Promise<Hex> {
  const k = account(keyFor, from)
  try { return await k.a.signTypedData(req.typed as any) } catch (e: any) { if (e instanceof DappError) throw e; throw new DappError(-32602, `That typed data is not valid: ${clean(e?.shortMessage ?? e?.message, 120)}`) } finally { k.wipe() }
}

/** Gas, fees and whether the call would succeed, read fresh from the chain. `fails` set: the network says it would revert. */
export async function planDappTx(network: string, from: string, req: Extract<DappRequest, { kind: 'tx' }>) {
  const c = evmClient(network), owner = getAddress(from)
  const [fees, nonce, balance] = await Promise.all([c.estimateFeesPerGas(), c.getTransactionCount({ address: owner, blockTag: 'pending' }), c.getBalance({ address: owner })])
  let gas = 0n, fails: string | undefined
  try { gas = mul(await c.estimateGas({ account: owner, to: req.to, data: req.data, value: req.value }), 1.3) } catch (e: any) { fails = clean(e?.shortMessage ?? e?.message ?? 'The network rejected it', 140) }
  const maxPriorityFeePerGas = mul(fees.maxPriorityFeePerGas, 1.1)
  const maxFeePerGas = mul(fees.maxFeePerGas, 1.15) > maxPriorityFeePerGas ? mul(fees.maxFeePerGas, 1.15) : maxPriorityFeePerGas
  return { gas, nonce, balance, maxFeePerGas, maxPriorityFeePerGas, feeMax: Number(formatUnits(gas * maxFeePerGas, 18)), fails }
}

/** Sign and broadcast. Never signs a transaction the network says would fail, or one the balance can't cover. dry: sign only. */
export async function sendDappTx(network: string, from: string, req: Extract<DappRequest, { kind: 'tx' }>, keyFor: KeyFor, dry = false): Promise<{ txid: string; raw?: string; feeMax: number }> {
  const n = NETWORKS[network], p = await planDappTx(network, from, req)
  if (p.fails) throw new DappError(-32000, `The network says this would fail, so nothing was sent: ${p.fails}`)
  if (p.balance < req.value + p.gas * p.maxFeePerGas) throw new DappError(-32000, `Not enough ${ASSET[n.native].symbol} on ${n.name} for this and its network fee`)
  const k = account(keyFor, from)
  try {
    const signed = await k.a.signTransaction({ chainId: n.chainId!, type: 'eip1559', nonce: p.nonce, gas: p.gas, maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas, to: req.to, value: req.value, data: req.data })
    if (dry) return { txid: `dry:dapp:${keccak256(signed)}`, raw: signed, feeMax: p.feeMax }
    return { txid: await evmClient(network).sendRawTransaction({ serializedTransaction: signed }), feeMax: p.feeMax }
  } finally { k.wipe() }
}
