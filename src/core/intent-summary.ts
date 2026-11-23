// What the main process shows in its own confirmation prompt (Touch ID or a native dialog) before it issues a
// payment approval. Built only from the normalized intent and main's own registries, never from UI text, so a
// compromised renderer can't make the prompt say one thing while the approval covers another.
// Pure (no Electron) so it can be unit-tested.
import { ASSET, NETWORKS, ASSETS, type Asset } from './assets'
import type { SendRequest, Speed } from './send'
import type { SwapRequest, Provider } from './swap'
import type { SplitRequest } from './split'
import type { RouteRequest } from './route'
import { typeName, type AccountType } from './account-types'

export type LegPick = { provider: Provider; minOut: number }
export type Intent = { kind: 'send'; req: SendRequest } | { kind: 'swap'; req: SwapRequest; provider: Provider; minOut: number }
  | { kind: 'split'; req: SplitRequest; picks: LegPick[] } | { kind: 'bump'; req: { id: string } }
  | { kind: 'cancel'; req: { id: string } } | { kind: 'revoke'; req: { network: string; token: string; spender: string } }
  | { kind: 'route'; req: RouteRequest; picks: LegPick[] }
  /** something a website asked for through the extension; `id` is main's own record of it, which the site can't change */
  | { kind: 'dapp'; req: { id: string } }

export type NormIntent =
  | { kind: 'send'; req: { account: number; assetId: string; to: string; amount: string; speed: Speed; max: boolean } }
  | { kind: 'swap'; req: { account: number; from: string; to: string; amount: string; slippageBps: number | null }; provider: Provider; minOut: number }
  | { kind: 'split'; req: { account: number; from: string; amount: string; name: string; slippageBps: number | null; legs: { to: string; pct: number }[] }; picks: LegPick[] }
  | { kind: 'bump'; req: { id: string } }
  | { kind: 'cancel'; req: { id: string } }
  | { kind: 'revoke'; req: { network: string; token: string; spender: string } }
  | { kind: 'dapp'; req: { id: string } }
  | { kind: 'route'; req: { account: number; from: string; amount: string; hops: { from: string; to: string; account: number }[] }; picks: LegPick[] }

/** The exact payment an approval is bound to. Same input → same object → same intent hash. */
export const normIntent = (i: Intent, activeAccount: number): NormIntent => i.kind === 'send'
  ? { kind: 'send', req: { account: i.req.account ?? activeAccount, assetId: i.req.assetId, to: String(i.req.to ?? '').trim(), amount: String(i.req.amount ?? ''), speed: i.req.speed ?? 'normal', max: !!i.req.max } }
  : i.kind === 'swap' ? { kind: 'swap', req: { account: i.req.account ?? activeAccount, from: i.req.from, to: i.req.to, amount: String(i.req.amount ?? ''), slippageBps: i.req.slippageBps ?? null }, provider: i.provider, minOut: Number(i.minOut) }
  : i.kind === 'split' ? { kind: 'split', req: { account: i.req.account ?? activeAccount, from: i.req.from, amount: String(i.req.amount ?? ''), name: String(i.req.name ?? ''), slippageBps: i.req.slippageBps ?? null, legs: (i.req.legs ?? []).map((l) => ({ to: String(l.to), pct: Number(l.pct) })) }, picks: (i.picks ?? []).map((p) => ({ provider: p.provider, minOut: Number(p.minOut) })) }
  : i.kind === 'bump' ? { kind: 'bump', req: { id: String(i.req?.id ?? '') } }
  : i.kind === 'cancel' ? { kind: 'cancel', req: { id: String(i.req?.id ?? '') } }
  : i.kind === 'dapp' ? { kind: 'dapp', req: { id: String(i.req?.id ?? '') } }
  : i.kind === 'route' ? { kind: 'route', req: { account: i.req.account ?? activeAccount, from: i.req.from, amount: String(i.req.amount ?? ''), hops: (i.req.hops ?? []).map((h) => ({ from: h.from, to: h.to, account: h.account })) }, picks: (i.picks ?? []).map((p) => ({ provider: p.provider, minOut: Number(p.minOut) })) }
  // EVM addresses are case-insensitive: lowercase so the same approval always hashes the same
  : { kind: 'revoke', req: { network: String(i.req?.network ?? ''), token: String(i.req?.token ?? '').trim().toLowerCase(), spender: String(i.req?.spender ?? '').trim().toLowerCase() } }

export interface SummaryCtx {
  /** main's provider display names (PROVIDER_NAME in swap.ts) */
  providerName?: (p: string) => string | undefined
  /** wallet name for an account index, from the vault */
  accountName?: (index: number) => string | undefined
  /** label for a spender main knows (spenderName in approvals.ts) */
  spenderName?: (network: string, spender: string) => string | undefined
  /** main's own one-line description of a pending website request (core/dapp.ts describeDapp) */
  dapp?: (id: string) => string | undefined
  /** the stored activity item a fee bump or cancel refers to */
  activity?: (id: string) => { asset: string; amount: number; to: string } | undefined
  /** 'short' (Touch ID line) or 'full' (dialog detail, where there's room to check every character) */
  addresses?: 'short' | 'full'
  /** asset registry; defaults to main's ASSET (custom tokens included once registered) */
  asset?: (id: string) => Asset | undefined
  /** what an account is for, from the vault (missing = Spending) */
  accountType?: (index: number) => AccountType | undefined
  /** main's own match of a send's recipient against the addresses it derives for this wallet's accounts. Never renderer-supplied. */
  ownAccount?: (assetId: string, to: string) => { index: number; name: string; type?: AccountType } | undefined
}

// Strip anything that could reorder or hide text in a system prompt: control chars, zero-width and bidi overrides.
// eslint-disable-next-line no-control-regex
const clean = (s: unknown, max = 120) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim().slice(0, max)

/** Same shape as the UI's short(): first 6 … last 6. */
export const shortAddr = (a: string, n = 6) => { const s = clean(a, 200); return s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s }

const num = (n: number) => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumSignificantDigits: 8, useGrouping: false }) : '?'

export function intentSummary(i: NormIntent, ctx: SummaryCtx = {}, opts: { overLimit?: boolean } = {}): string {
  const assetOf = ctx.asset ?? ((id: string) => ASSET[id])
  // never show a tidied-up address as if it were the real one: say it was altered
  const flag = (x: string) => (clean(x, 1e4) !== String(x ?? '').trim() ? ' (WARNING: contains hidden characters)' : '')
  const addr = (a: string) => (ctx.addresses === 'full' ? clean(a, 200) : shortAddr(a)) + flag(a)
  // a user-added token carries its contract, so a fake "USDC" can't pass for the real one
  const sym = (id: string) => { const a = assetOf(id); if (!a) return `unknown coin (${clean(id, 40)})`; const s = clean(a.symbol, 20); return a.custom && a.contract ? `${s} (token ${shortAddr(a.contract)})` : s }
  const netName = (id: string) => { const a = assetOf(id); return a ? clean(NETWORKS[a.network]?.name ?? a.network, 30) : '' }
  // say the network only when the symbol alone is ambiguous (ETH on Ethereum vs Arbitrum, USDC on five chains)
  const coin = (id: string) => { const a = assetOf(id); if (!a) return sym(id); const dup = a.custom || ASSETS.filter((x) => x.symbol === a.symbol).length > 1; return dup ? `${sym(id)} on ${netName(id)}` : sym(id) }
  // a Vault says so right where the money leaves: "from Main (your Vault)"
  const vault = (acct: number) => ctx.accountType?.(acct) === 'vault'
  const from = (acct: number) => { const n = ctx.accountName?.(acct); return n ? ` from ${clean(n, 40)}${vault(acct) ? ' (your Vault)' : ''}` : vault(acct) ? ' from your Vault' : '' }
  const amt = (s: string) => (clean(s, 40) || '0') + flag(s)
  const prov = (p: string) => ctx.providerName?.(p) ?? clean(p, 30)
  let s: string
  switch (i.kind) {
    case 'send': {
      const r = i.req
      const what = r.max ? `all your ${sym(r.assetId)}` : `${amt(r.amount)} ${sym(r.assetId)}`
      // to another of this wallet's own accounts: say which one, by name and type, as main derived it
      const own = assetOf(r.assetId) && flag(r.to) === '' ? ctx.ownAccount?.(r.assetId, String(r.to ?? '').trim()) : undefined
      if (own && own.index !== r.account) {
        s = `Move ${what} on ${netName(r.assetId) || 'an unknown network'}${from(r.account)} to ${clean(own.name, 40)} (${typeName(own.type)})${ctx.addresses === 'full' ? ` at ${addr(r.to)}` : ''}`
        break
      }
      s = `Send ${what} on ${netName(r.assetId) || 'an unknown network'}${from(r.account)} to ${addr(r.to)}`
      break
    }
    case 'swap': {
      const r = i.req
      s = `Swap ${amt(r.amount)} ${coin(r.from)}${from(r.account)} → at least ${num(i.minOut)} ${coin(r.to)} via ${prov(i.provider)}`
      break
    }
    case 'split': {
      const r = i.req
      const legs = r.legs.map((l) => `${num(l.pct)}% ${coin(l.to)}`).join(', ')
      s = `Split ${amt(r.amount)} ${coin(r.from)}${from(r.account)} into ${r.legs.length} ${r.legs.length === 1 ? 'coin' : 'coins'}: ${legs}`
      break
    }
    case 'bump': {
      const a = ctx.activity?.(i.req.id)
      s = a ? `Speed up your ${num(a.amount)} ${sym(a.asset)} payment to ${addr(a.to)}` : 'Speed up a pending payment'
      break
    }
    case 'cancel': {
      const a = ctx.activity?.(i.req.id)
      s = a ? `Cancel your ${num(a.amount)} ${sym(a.asset)} payment to ${addr(a.to)} and send it back to yourself, paying a higher fee` : 'Cancel a pending payment'
      break
    }
    case 'dapp':
      s = clean(ctx.dapp?.(i.req.id), 240) || 'Approve a request from a website'
      break
    case 'revoke': {
      const r = i.req, n = NETWORKS[r.network]
      // only main's own registry names the token: an on-chain symbol() is whatever its deployer wrote
      const t = n ? ASSETS.find((x) => x.network === r.network && x.kind === 'token' && x.contract?.toLowerCase() === r.token) : undefined
      const tok = t ? sym(t.id) : `token ${addr(r.token)}`
      const who = ctx.spenderName?.(r.network, r.spender)
      s = `Revoke the permission for ${who ? `${clean(who, 40)} (${addr(r.spender)})` : `contract ${addr(r.spender)}`} to spend your ${tok} on ${n ? clean(n.name, 30) : 'an unknown network'}`
      break
    }
    case 'route': {
      const r = i.req
      s = `Route ${amt(r.amount)} ${coin(r.from)}${from(r.account)} through ${r.hops.length} hop${r.hops.length !== 1 ? 's' : ''} ending at ${coin(r.hops[r.hops.length - 1]?.to ?? r.from)}`
      break
    }
  }
  return opts.overLimit ? `${s} (over your daily limit)` : s
}

/** The extra line the native dialog shows when money leaves a Vault account (send, swap or split). */
export function vaultLine(i: NormIntent, ctx: Pick<SummaryCtx, 'accountType'> = {}): string | undefined {
  if (i.kind !== 'send' && i.kind !== 'swap' && i.kind !== 'split') return undefined
  return ctx.accountType?.(i.req.account) === 'vault' ? 'This comes out of your Vault, the account you set aside for long-term holdings.' : undefined
}

/** Is `to` one of these derived addresses? EVM addresses match case-insensitively, everything else exactly. */
export const sameAddress = (family: string, a: string, b: string) => (family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b)

export type StakeIntent = { kind: 'stake' | 'unstake' | 'withdraw'; amount?: number; vote?: string; account?: string }

export function stakeSummary(a: StakeIntent, ctx: Pick<SummaryCtx, 'addresses'> = {}): string {
  const addr = (x: unknown) => (ctx.addresses === 'full' ? clean(x, 200) : shortAddr(String(x ?? '')))
  if (a.kind === 'stake') return `Stake ${num(Number(a.amount))} SOL with validator ${addr(a.vote)}`
  if (a.kind === 'unstake') return `Unstake SOL from stake account ${addr(a.account)}`
  return `Withdraw staked SOL from stake account ${addr(a.account)} to your wallet`
}

/** macOS shows Touch ID reasons as "<App> is trying to <reason>." */
export const touchReason = (summary: string) => summary.charAt(0).toLowerCase() + summary.slice(1)
