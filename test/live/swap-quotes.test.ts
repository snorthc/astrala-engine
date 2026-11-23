import { it } from 'vitest'
import { swapQuote } from '../../src/core/swap'
const addrs: any = { evm: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', sol: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', btc: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', ltc: 'ltc1qd5gsu875lekewcel0p6wvuev25ynn7ee6ej48e', doge: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', trx: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' }
const P: any = { eth: 3000, 'usdc-ethereum': 1, ltc: 80, btc: 100000, sol: 150, 'usdc-solana': 1, trx: 0.3, 'usdt-tron': 1, 'eth-arbitrum': 3000, 'usdc-arbitrum': 1 }
it('quotes', async () => {
  for (const [from, to, amount] of [['eth','usdc-ethereum','0.5'],['sol','usdc-solana','2'],['ltc','eth','3'],['btc','eth','0.02'],['eth','btc','1'],['usdc-ethereum','ltc','500'],['trx','usdt-tron','1000'],['eth-arbitrum','btc','1'],['eth','xmr','1'],['ltc','btc','0.001'],['doge','ltc','5000'],['eth','sol','0.5'],['sol','eth','2'],['usdc-base','usdc-arbitrum','100'],['eth-arbitrum','usdc-solana','0.3'],['usdt-ethereum','sol','300']]) {
    const t = Date.now()
    const q = await swapQuote({ from, to, amount }, addrs, (id) => P[id])
    console.log(from, '→', to, amount, `${Date.now()-t}ms`, q.ok ? q.routes.map(r => `${r.providerName}${r.via ? '/' + r.via : ''}: ${r.amountOut.toFixed(6)} (min ${r.minOut.toFixed(6)}, fee ${r.networkFee.toFixed(6)} ${r.networkFeeAsset}, ${r.etaSec}s${r.approval?' +approve':''})`).join(' | ') : 'ERR ' + q.error)
  }
}, 180000)
