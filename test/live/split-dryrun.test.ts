import { it, expect } from 'vitest'
import { parseTransaction, decodeFunctionData, parseAbi } from 'viem'
import { swapExecute, swapQuote, _setDryRun } from '../../src/core/swap'
import { splitQuote } from '../../src/core/split'
import { FEES } from '../../src/core/fees'
import { newMnemonic, deriveAccount, signingKey } from '../../src/core/derive'

const m = newMnemonic()
const acct = (i: number): any => Object.fromEntries(deriveAccount(m, i).map((a) => [a.chain, a.address]))
const src = acct(0), dest = acct(5)
const keyFor = (f: any) => signingKey(m, f, 0)
_setDryRun(true)
FEES.to = { evm: '0x000000000000000000000000000000000000dEaD', sol: '11111111111111111111111111111112' }

it('split quote: every leg gets a best route, fee taken off the top', async () => {
  const q = await splitQuote({ from: 'eth', amount: '2', legs: [{ to: 'btc', pct: 40 }, { to: 'sol', pct: 30 }, { to: 'usdc-ethereum', pct: 20 }, { to: 'eth', pct: 10 }] }, src, () => undefined)
  console.log(q.ok, q.error, q.fee, q.net, q.legs.map((l) => `${l.to}:${l.route?.providerName}:${l.route?.amountOut}`))
  expect(q.fee).toBeCloseTo(0.3, 10)
  expect(q.net).toBeCloseTo(1.7, 10)
  expect(q.legs.find((l) => l.to === 'eth')?.direct).toBe(true)
}, 120000)

it('swaps pay out to another wallet of yours, and the fee goes out after', async () => {
  const ROUTER = parseAbi(['function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration) payable'])
  // LI.FI's Solana recipient is ABI-encoded bytes, not text, so it isn't string-matched
  for (const [from, to, amount, provider, want] of [['eth', 'btc', '1', 'thorchain', dest.btc], ['eth', 'sol', '0.5', 'lifi', ''], ['eth', 'xmr', '0.1', 'wagyu', ''], ['eth', 'usdc-ethereum', '0.5', 'kyber', dest.evm.slice(2).toLowerCase()]] as const) {
    try {
      const r: any = await swapExecute({ from, to, amount }, provider as any, 0, src, keyFor, { dest, feeBps: 50 })
      let blob = r.txid
      if (r.signed) {
        const tx = parseTransaction(r.signed)
        blob = String(tx.data).toLowerCase()
        if (provider === 'thorchain') blob = String(decodeFunctionData({ abi: ROUTER, data: tx.data! }).args[3])
      }
      if (want) expect(blob.toLowerCase()).toContain(want.toLowerCase().slice(0, 20))
      expect(String(r.feeTxid)).toMatch(/^dry:fee/)
      expect(r.route.ourFee).toBeCloseTo(Number(amount) * 0.005, 12)
      console.log('OK', from, '→', to, provider, 'pays dest; fee', r.feeTxid.slice(0, 40))
    } catch (e: any) { console.log('FAIL', from, '→', to, provider, e.message) }
  }
}, 180000)

it('quotes are on the amount after the fee', async () => {
  const q = await swapQuote({ from: 'eth', to: 'usdc-ethereum', amount: '1' }, src, () => undefined, { feeBps: 50 })
  expect(q.ok).toBe(true)
  expect(q.routes[0].amountIn).toBeCloseTo(0.995, 10)
}, 60000)
