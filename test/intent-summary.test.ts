import { describe, expect, it } from 'vitest'
import { intentSummary, stakeSummary, normIntent, shortAddr, touchReason, vaultLine, sameAddress, type SummaryCtx } from '../src/core/intent-summary'
import { deriveAccount } from '../src/core/derive'
import { networkOf } from '../src/core/assets'
import { accountType, typeName, ACCOUNT_TYPES } from '../src/core/account-types'
import { intentHash } from '../src/core/paysafe'
import { PROVIDER_NAME } from '../src/core/swap'

const ETH_TO = '0xAbC0000000000000000000000000000000001234'
const ctx = { providerName: (p: string) => (PROVIDER_NAME as Record<string, string>)[p], accountName: (i: number) => (i === 0 ? 'Main' : undefined) }

describe('payment summary shown by the main process', () => {
  it('describes a send from the intent: amount, coin, network, wallet and address', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'eth', to: `  ${ETH_TO} `, amount: '0.01', speed: 'normal' } }, 0)
    expect(intentSummary(n, ctx)).toBe('Send 0.01 ETH on Ethereum from Main to 0xAbC0…001234')
    expect(intentSummary(n, { ...ctx, addresses: 'full' })).toBe(`Send 0.01 ETH on Ethereum from Main to ${ETH_TO}`)
  })

  it('changes when the amount or address in the intent changes', () => {
    const a = intentSummary(normIntent({ kind: 'send', req: { assetId: 'btc', to: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', amount: '0.5', speed: 'fast' } }, 0), { addresses: 'full' })
    const b = intentSummary(normIntent({ kind: 'send', req: { assetId: 'btc', to: 'bc1qattackerattackerattackerattackerxx0wlh', amount: '5', speed: 'fast' } }, 0), { addresses: 'full' })
    expect(a).toContain('0.5 BTC on Bitcoin')
    expect(a).toContain('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')
    expect(b).toContain('5 BTC')
    expect(b).toContain('bc1qattackerattackerattackerattackerxx0wlh')
    expect(a).not.toBe(b)
  })

  it('says "all your" for a max send and uses the active account when none is given', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'sol', to: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', amount: '', speed: 'normal', max: true } }, 3)
    expect(n.req).toMatchObject({ account: 3 })
    expect(intentSummary(n, { accountName: (i) => (i === 3 ? 'Savings' : undefined) })).toBe('Send all your SOL on Solana from Savings to 7xKXtg…osgAsU')
  })

  it('describes a swap with the minimum out and main\'s provider name', () => {
    const n = normIntent({ kind: 'swap', req: { from: 'eth', to: 'xmr', amount: '1' }, provider: 'wagyu', minOut: 3.5 }, 0)
    expect(intentSummary(n, ctx)).toBe('Swap 1 ETH on Ethereum from Main → at least 3.5 XMR via Wagyu')
    const usdc = normIntent({ kind: 'swap', req: { from: 'usdc-ethereum', to: 'btc', amount: '250' }, provider: 'thorchain', minOut: 0.00321 }, 0)
    expect(intentSummary(usdc, {})).toBe('Swap 250 USDC on Ethereum → at least 0.00321 BTC via thorchain')
  })

  it('describes a split with every leg', () => {
    const n = normIntent({ kind: 'split', req: { from: 'usdc-ethereum', amount: '100', legs: [{ to: 'btc', pct: 50 }, { to: 'eth', pct: 30 }, { to: 'sol', pct: 20 }] }, picks: [] }, 0)
    expect(intentSummary(n, ctx)).toBe('Split 100 USDC on Ethereum from Main into 3 coins: 50% BTC, 30% ETH on Ethereum, 20% SOL')
  })

  it('describes a fee bump from the stored activity item, not the request', () => {
    const n = normIntent({ kind: 'bump', req: { id: 'bitcoin:abc' } }, 0)
    const activity = (id: string) => (id === 'bitcoin:abc' ? { asset: 'btc', amount: 0.01, to: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' } : undefined)
    expect(intentSummary(n, { activity })).toBe('Speed up your 0.01 BTC payment to bc1qxy…hx0wlh')
    expect(intentSummary(normIntent({ kind: 'bump', req: { id: 'nope' } }, 0), { activity })).toBe('Speed up a pending payment')
  })

  it('describes a cancel from the stored activity item, not the request', () => {
    const n = normIntent({ kind: 'cancel', req: { id: 'ethereum:0xabc' } }, 0)
    const activity = (id: string) => (id === 'ethereum:0xabc' ? { asset: 'eth', amount: 0.25, to: ETH_TO } : undefined)
    expect(intentSummary(n, { activity })).toBe('Cancel your 0.25 ETH payment to 0xAbC0…001234 and send it back to yourself, paying a higher fee')
    expect(intentSummary(normIntent({ kind: 'cancel', req: { id: 'nope' } }, 0), { activity })).toBe('Cancel a pending payment')
    // a cancel approval can't be spent on a speed-up of the same payment, or the other way round
    expect(intentHash(n).equals(intentHash(normIntent({ kind: 'bump', req: { id: 'ethereum:0xabc' } }, 0)))).toBe(false)
  })

  it('describes a revoke with main\'s own token and spender names, and hashes it case-insensitively', () => {
    const KYBER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
    const spenderName = (net: string, s: string) => (s.toLowerCase() === KYBER.toLowerCase() ? 'KyberSwap' : undefined)
    const n = normIntent({ kind: 'revoke', req: { network: 'ethereum', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', spender: KYBER } }, 0)
    expect(intentSummary(n, { spenderName })).toBe('Revoke the permission for KyberSwap (0x6131…6337b5) to spend your USDC on Ethereum')
    expect(intentSummary(n, { spenderName, addresses: 'full' })).toContain(KYBER.toLowerCase())
    const unknown = normIntent({ kind: 'revoke', req: { network: 'arbitrum', token: '0x00000000000000000000000000000000000F0F0F', spender: '0x000000000000000000000000000000000000bEEF' } }, 0)
    expect(intentSummary(unknown, { spenderName })).toBe('Revoke the permission for contract 0x0000…00beef to spend your token 0x0000…0f0f0f on Arbitrum')
    const lower = normIntent({ kind: 'revoke', req: { network: 'ethereum', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', spender: KYBER.toLowerCase() } }, 0)
    expect(intentHash(lower).equals(intentHash(n))).toBe(true)
    const other = normIntent({ kind: 'revoke', req: { network: 'base', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', spender: KYBER } }, 0)
    expect(intentHash(other).equals(intentHash(n))).toBe(false)
  })

  it('marks an over-limit override', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'ltc', to: 'ltc1qg82q3w4c5mw3c4u6uznvd0c5qlh0xwz6r3pk2a', amount: '2', speed: 'normal' } }, 0)
    expect(intentSummary(n, {}, { overLimit: true })).toMatch(/\(over your daily limit\)$/)
  })

  it('strips control and bidi characters a renderer could use to disguise text, and says so', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'eth', to: '0xAbC\u202e0000000000000000000000000000000001234\n', amount: '1\u200b0', speed: 'normal' } }, 0)
    const s = intentSummary(n, { addresses: 'full' })
    expect(s).toBe('Send 10 (WARNING: contains hidden characters) ETH on Ethereum to 0xAbC0000000000000000000000000000000001234 (WARNING: contains hidden characters)')
    expect(s).not.toMatch(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e]/)
  })

  it('names unknown coins honestly', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'fake-coin', to: 'x', amount: '1', speed: 'normal' } }, 0)
    expect(intentSummary(n)).toContain('unknown coin (fake-coin)')
  })

  it('normIntent is stable, so the approval hash still binds the exact payment', () => {
    const a = normIntent({ kind: 'send', req: { assetId: 'eth', to: ` ${ETH_TO}`, amount: '0.01', speed: 'normal' } }, 0)
    const b = normIntent({ kind: 'send', req: { assetId: 'eth', to: ETH_TO, amount: '0.01', speed: 'normal', account: 0, max: false } }, 0)
    expect(intentHash(a).equals(intentHash(b))).toBe(true)
    const c = normIntent({ kind: 'send', req: { assetId: 'eth', to: ETH_TO, amount: '0.02', speed: 'normal' } }, 0)
    expect(intentHash(a).equals(intentHash(c))).toBe(false)
  })
})

describe('staking summary', () => {
  it('covers stake, unstake and withdraw', () => {
    expect(stakeSummary({ kind: 'stake', amount: 2, vote: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2' })).toBe('Stake 2 SOL with validator 7Np41o…KCT4K2')
    expect(stakeSummary({ kind: 'stake', amount: 2, vote: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2' }, { addresses: 'full' })).toBe('Stake 2 SOL with validator 7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2')
    expect(stakeSummary({ kind: 'unstake', account: 'Stk1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaZ' })).toBe('Unstake SOL from stake account Stk1aa…aaaaaZ')
    expect(stakeSummary({ kind: 'withdraw', account: 'Stk1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaZ' })).toBe('Withdraw staked SOL from stake account Stk1aa…aaaaaZ to your wallet')
  })
})

describe('helpers', () => {
  it('shortens addresses like the UI (6…6) and leaves short ones alone', () => {
    expect(shortAddr(ETH_TO)).toBe('0xAbC0…001234')
    expect(shortAddr('abc123')).toBe('abc123')
    expect(shortAddr('0123456789abcde')).toBe('0123456789abcde') // 15 chars: not worth shortening
  })
  it('turns a summary into a Touch ID reason ("Astrala is trying to …")', () => {
    expect(touchReason('Send 1 ETH on Ethereum to 0xAbC0…001234')).toBe('send 1 ETH on Ethereum to 0xAbC0…001234')
  })
})

describe('moves between your own accounts', () => {
  // the wallet as main sees it: names and types from the vault, addresses derived from the words (never from the window)
  const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
  const accounts = [{ index: 0, name: 'Main', type: 'spending' as const }, { index: 2, name: 'Account 3', type: 'vault' as const }, { index: 5, name: 'Umbra', type: 'stealth' as const }, { index: 7, name: 'Old', type: undefined }]
  const derived = new Map(accounts.map((a) => [a.index, deriveAccount(WORDS, a.index)]))
  const addr = (index: number, chain: string) => derived.get(index)!.find((d) => d.chain === chain)!.address
  const ownAccount: SummaryCtx['ownAccount'] = (assetId, to) => {
    const fam = networkOf(assetId).family
    for (const a of accounts) { const mine = addr(a.index, fam); if (sameAddress(fam, mine, to)) return { index: a.index, name: a.name, type: a.type } }
    return undefined
  }
  const ctx: SummaryCtx = { accountName: (i) => accounts.find((a) => a.index === i)?.name, accountType: (i) => { const a = accounts.find((x) => x.index === i); return a ? accountType(a.type) : undefined }, ownAccount }

  it('says "Move … from Main to Account 3 (Vault)" when the recipient is another account of this wallet', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'eth', to: addr(2, 'evm'), amount: '0.01', speed: 'normal', account: 0 } }, 0)
    expect(intentSummary(n, ctx)).toBe('Move 0.01 ETH on Ethereum from Main to Account 3 (Vault)')
    // the dialog (room for every character) still shows the exact address it goes to
    expect(intentSummary(n, { ...ctx, addresses: 'full' })).toBe(`Move 0.01 ETH on Ethereum from Main to Account 3 (Vault) at ${addr(2, 'evm')}`)
  })

  it('matches EVM addresses whatever their case, and works on every chain the account has', () => {
    const lower = normIntent({ kind: 'send', req: { assetId: 'usdc-base', to: addr(2, 'evm').toLowerCase(), amount: '5', speed: 'normal', account: 0 } }, 0)
    expect(intentSummary(lower, ctx)).toBe('Move 5 USDC on Base from Main to Account 3 (Vault)')
    const btc = normIntent({ kind: 'send', req: { assetId: 'btc', to: addr(5, 'btc'), amount: '0.002', speed: 'fast', account: 0 } }, 0)
    expect(intentSummary(btc, ctx)).toBe('Move 0.002 BTC on Bitcoin from Main to Umbra (Stealth)')
    const all = normIntent({ kind: 'send', req: { assetId: 'sol', to: addr(7, 'sol'), amount: '', speed: 'normal', max: true, account: 0 } }, 0)
    expect(intentSummary(all, ctx)).toBe('Move all your SOL on Solana from Main to Old (Spending)')
  })

  it("moves Monero to the other account's primary address", () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'xmr', to: addr(2, 'xmr'), amount: '1.5', speed: 'normal', account: 0 } }, 0)
    expect(intentSummary(n, ctx)).toBe('Move 1.5 XMR on Monero from Main to Account 3 (Vault)')
  })

  it('a stranger stays a plain send, even with a lookalike address or the right address on the wrong chain', () => {
    const real = addr(2, 'evm')
    const fake = real.slice(0, 8) + ((parseInt(real[8], 16) + 1) % 16).toString(16) + real.slice(9) // one hex digit off, not just a case change
    const n = normIntent({ kind: 'send', req: { assetId: 'eth', to: fake, amount: '0.01', speed: 'normal', account: 0 } }, 0)
    expect(intentSummary(n, ctx)).toMatch(/^Send 0\.01 ETH on Ethereum from Main to /)
    // case-sensitive chains don't match a re-cased address
    const sol = addr(2, 'sol')
    const recased = sol.replace(/[a-z]/, (c) => c.toUpperCase())
    if (recased !== sol) expect(intentSummary(normIntent({ kind: 'send', req: { assetId: 'sol', to: recased, amount: '1', speed: 'normal', account: 0 } }, 0), ctx)).toMatch(/^Send /)
  })

  it('a send from an account to its own address is not called a move', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'eth', to: addr(0, 'evm'), amount: '0.01', speed: 'normal', account: 0 } }, 0)
    expect(intentSummary(n, ctx)).toMatch(/^Send 0\.01 ETH/)
  })

  it('an address carrying hidden characters is never dressed up as your own account', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'eth', to: addr(2, 'evm') + '\u200b', amount: '0.01', speed: 'normal', account: 0 } }, 0)
    const s = intentSummary(n, ctx)
    expect(s).toMatch(/^Send /)
    expect(s).toContain('WARNING: contains hidden characters')
  })

  it('the recipient match is what the move label hangs on: no ownAccount in the context, no "Move"', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'eth', to: addr(2, 'evm'), amount: '0.01', speed: 'normal', account: 0 } }, 0)
    expect(intentSummary(n, { accountName: ctx.accountName })).toMatch(/^Send /)
  })

  it('a move keeps its own approval hash (it is the same send, just named better)', () => {
    const a = normIntent({ kind: 'send', req: { assetId: 'eth', to: addr(2, 'evm'), amount: '0.01', speed: 'normal', account: 0 } }, 0)
    const b = normIntent({ kind: 'send', req: { assetId: 'eth', to: addr(5, 'evm'), amount: '0.01', speed: 'normal', account: 0 } }, 0)
    expect(intentHash(a).equals(intentHash(b))).toBe(false)
  })
})

describe('Vault accounts in the confirmation', () => {
  const ctx: SummaryCtx = { accountName: (i) => (i === 1 ? 'Deep Cold' : i === 0 ? 'Main' : undefined), accountType: (i) => (i === 1 ? 'vault' : i === 9 ? 'vault' : 'spending') }

  it('marks where the money leaves a Vault, on sends, swaps and splits', () => {
    const send = normIntent({ kind: 'send', req: { assetId: 'eth', to: ETH_TO, amount: '1', speed: 'normal', account: 1 } }, 0)
    expect(intentSummary(send, ctx)).toBe('Send 1 ETH on Ethereum from Deep Cold (your Vault) to 0xAbC0…001234')
    const swap = normIntent({ kind: 'swap', req: { from: 'eth', to: 'btc', amount: '1', account: 1 }, provider: 'thorchain', minOut: 0.03 }, 0)
    expect(intentSummary(swap, ctx)).toContain('from Deep Cold (your Vault)')
    const split = normIntent({ kind: 'split', req: { from: 'eth', amount: '1', account: 1, legs: [{ to: 'btc', pct: 100 }] }, picks: [] }, 0)
    expect(intentSummary(split, ctx)).toContain('from Deep Cold (your Vault)')
    // no name on file: still says it's the Vault
    expect(intentSummary(normIntent({ kind: 'send', req: { assetId: 'eth', to: ETH_TO, amount: '1', speed: 'normal', account: 9 } }, 0), ctx)).toContain('from your Vault to')
  })

  it('adds the extra Vault line to the native dialog, and only for money leaving a Vault', () => {
    const fromVault = normIntent({ kind: 'send', req: { assetId: 'eth', to: ETH_TO, amount: '1', speed: 'normal', account: 1 } }, 0)
    expect(vaultLine(fromVault, ctx)).toMatch(/out of your Vault/)
    expect(vaultLine(normIntent({ kind: 'send', req: { assetId: 'eth', to: ETH_TO, amount: '1', speed: 'normal', account: 0 } }, 0), ctx)).toBeUndefined()
    expect(vaultLine(normIntent({ kind: 'bump', req: { id: 'x' } }, 1), ctx)).toBeUndefined()
    expect(vaultLine(fromVault, {})).toBeUndefined()
  })

  it('spending accounts read exactly as before', () => {
    const n = normIntent({ kind: 'send', req: { assetId: 'eth', to: ETH_TO, amount: '0.01', speed: 'normal', account: 0 } }, 0)
    expect(intentSummary(n, ctx)).toBe('Send 0.01 ETH on Ethereum from Main to 0xAbC0…001234')
  })
})

describe('account types', () => {
  it('has four types, and anything missing or unknown reads as Spending', () => {
    expect(ACCOUNT_TYPES.map((t) => t.id)).toEqual(['vault', 'spending', 'trading', 'stealth'])
    expect(accountType(undefined)).toBe('spending')
    expect(accountType('savings')).toBe('spending')
    expect(accountType('vault')).toBe('vault')
    expect(typeName('stealth')).toBe('Stealth')
    expect(typeName(null)).toBe('Spending')
    for (const t of ACCOUNT_TYPES) expect(t.line.length).toBeLessThan(80)
  })
})
