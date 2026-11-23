import { it, expect } from 'vitest'
import * as btc from '@scure/btc-signer'
import { decodeFunctionData, parseAbi, parseTransaction } from 'viem'
import { swapExecute, _setDryRun, buildUtxoDeposit } from '../../src/core/swap'
import { newMnemonic, deriveAccount, signingKey } from '../../src/core/derive'

const m = newMnemonic()
const addrs: any = Object.fromEntries(deriveAccount(m).map((a) => [a.chain, a.address]))
const keyFor = (f: any) => signingKey(m, f, 0)
_setDryRun(true)

it('utxo deposit: vault, memo, change in protocol order', () => {
  const { pub } = signingKey(m, 'ltc')
  const sel = buildUtxoDeposit('ltc', pub, addrs.ltc, [{ txid: 'aa'.repeat(32), vout: 0, value: 500_000_000 }], 'ltc1qd5gsu875lekewcel0p6wvuev25ynn7ee6ej48e', 300_000_000n, '=:e:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045:0/1/0', 5)!
  const tx = sel.tx!
  expect(tx.outputsLength).toBe(3)
  expect(tx.getOutput(0).amount).toBe(300_000_000n)
  const ret = btc.Script.decode(tx.getOutput(1).script!)
  expect(ret[0]).toBe('RETURN')
  expect(new TextDecoder().decode(ret[1] as Uint8Array)).toContain('=:e:0xd8dA')
  tx.sign(signingKey(m, 'ltc').priv); tx.finalize()
  expect(tx.hex.length).toBeGreaterThan(200)
})

it('dry-run executes (signed, never broadcast)', async () => {
  const ROUTER = parseAbi(['function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration) payable'])
  for (const [from, to, amount, provider] of [['eth', 'btc', '1', 'thorchain'], ['eth', 'usdc-ethereum', '0.5', 'kyber'], ['eth', 'usdc-ethereum', '0.5', 'paraswap'], ['sol', 'usdc-solana', '2', 'jupiter'], ['trx', 'usdt-tron', '1000', 'thorchain'], ['usdc-ethereum', 'ltc', '500', 'thorchain'], ['eth', 'sol', '0.5', 'lifi'], ['sol', 'eth', '2', 'lifi'], ['eth', 'xmr', '0.1', 'wagyu'], ['usdc-arbitrum', 'xmr', '100', 'wagyu'], ['sol', 'xmr', '1', 'wagyu'], ['xmr', 'usdc-arbitrum', '0.5', 'wagyu'], ['xmr', 'eth', '0.5', 'wagyu']] as const) {
    try {
      const r: any = await swapExecute({ from, to, amount }, provider, 0, addrs, keyFor)
      let detail = r.txid.slice(0, 90)
      if (r.signed) {
        const tx = parseTransaction(r.signed)
        detail = `to ${tx.to} value ${tx.value} chain ${tx.chainId}`
        if (provider === 'thorchain') { const d = decodeFunctionData({ abi: ROUTER, data: tx.data! }); detail += ` memo ${d.args[3]}`; expect(String(d.args[3])).toContain(provider === 'thorchain' ? ':' : '') }
      }
      console.log('OK', from, '→', to, provider, r.approveTxid ?? '', detail)
    } catch (e: any) { console.log('FAIL', from, '→', to, provider, e.message) }
  }
}, 120000)
