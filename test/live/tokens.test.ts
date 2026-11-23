import { it, expect } from 'vitest'
import { searchTokens, readToken } from '../../src/core/tokens'
import { registerTokens, tokenId } from '../../src/core/assets'
import { getBalance, getPrices } from '../../src/core/chain'
import { swapQuote } from '../../src/core/swap'

const addrs: any = { evm: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', sol: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', trx: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' }

it('finds tokens by name and by pasted address, with on-chain metadata', async () => {
  const byName = await searchTokens('pepe')
  console.log('pepe →', byName.slice(0, 6).map((h) => `${h.symbol}@${h.network ?? '-'}${h.verified ? '' : ' (unverified)'}`).join(', '))
  expect(byName.some((h) => h.network === 'ethereum' && h.contract?.toLowerCase() === '0x6982508145454ce325ddbe47a25d4ec3d2311933')).toBe(true)
  const pasted = await searchTokens('0x6982508145454Ce325dDbE47a25d4ec3d2311933')
  expect(pasted.find((h) => h.network === 'ethereum')).toMatchObject({ symbol: 'PEPE', decimals: 18, verified: true })
  expect(await readToken('solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')).toMatchObject({ decimals: 5 })
  expect(await readToken('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toMatchObject({ symbol: 'USDT', decimals: 6 })
  await expect(readToken('ethereum', '0x0000000000000000000000000000000000000001')).rejects.toThrow()
}, 90000)

it('an added token gets a balance, a price and swap quotes', async () => {
  const pepe = { network: 'ethereum', contract: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', ...(await readToken('ethereum', '0x6982508145454Ce325dDbE47a25d4ec3d2311933')), cg: 'pepe', verified: true, added: 1 }
  const bonk = { network: 'solana', contract: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', ...(await readToken('solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')), verified: false, added: 2 } // no cg: priced by contract
  registerTokens([pepe, bonk])
  const p = tokenId('ethereum', pepe.contract), b = tokenId('solana', bonk.contract)
  const [bp, bb] = await Promise.all([getBalance({ ...(await import('../../src/core/assets')).ASSET[p] }, addrs), getBalance((await import('../../src/core/assets')).ASSET[b], addrs)])
  console.log('balances', bp, bb)
  expect(bp.status).toBe('ok'); expect(bb.status).toBe('ok')
  const prices = await getPrices('usd')
  console.log('prices pepe', prices?.pepe, 'bonk(ct)', prices?.[`ct:solana:${bonk.contract}`])
  expect(prices?.pepe?.price).toBeGreaterThan(0)
  expect(prices?.[`ct:solana:${bonk.contract}`]?.price).toBeGreaterThan(0)
  for (const [from, to, amount] of [[p, 'eth', '50000000'], [b, 'sol', '5000000'], ['eth', p, '0.1']]) {
    const q = await swapQuote({ from, to, amount }, addrs)
    console.log(from.slice(0, 22), '→', to.slice(0, 22), q.ok ? q.routes.map((r) => `${r.provider}:${r.amountOut.toFixed(4)}`).join(' | ') : 'ERR ' + q.error)
    expect(q.ok).toBe(true)
  }
  registerTokens([])
}, 120000)
