import { describe, it, expect, afterAll, vi } from 'vitest'
import * as btc from '@scure/btc-signer'
import { hexToBytes } from '@noble/hashes/utils.js'
import { deriveAccount, signingKey } from '../src/core/derive'
import { _internal, bumpFee, RBF_SEQ } from '../src/core/send'
import { setFetcher } from '../src/core/chain'
import { FEES, takeFee } from '../src/core/fees'
import { checkSplit, splitAmounts } from '../src/core/split'

// these tests set fee addresses via FEES.to themselves, so ignore the operator's private fee wallets (fees.local.ts)
vi.mock('../src/core/fee-wallets', async (orig) => ({ ...(await orig<typeof import('../src/core/fee-wallets')>()), feeAddressFrom: () => '' }))

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const addr = Object.fromEntries(deriveAccount(M).map((a) => [a.chain, a.address]))
const saved = { ...FEES.to }
afterAll(() => { FEES.to = saved })

describe('Astrala fee', () => {
  it('takes nothing when no fee address is set for that chain', () => {
    FEES.to = {}
    expect(takeFee(1_000_000n, 1500, 'evm')).toEqual({ fee: 0n, net: 1_000_000n })
  })
  it('takes the exact share and skips dust', () => {
    FEES.to = { evm: '0x000000000000000000000000000000000000dEaD', btc: 'bc1qexample' }
    expect(takeFee(1_000_000n, 1500, 'evm')).toEqual({ fee: 150_000n, net: 850_000n })
    expect(takeFee(5000n, 50, 'btc')).toEqual({ fee: 0n, net: 5000n }) // 25 sats would be dust
  })
})

describe('split', () => {
  const ok = { from: 'eth', amount: '1', legs: [{ to: 'btc', pct: 40 }, { to: 'sol', pct: 35 }, { to: 'eth', pct: 25 }] }
  it('accepts a valid plan and rejects bad ones', () => {
    expect(checkSplit(ok)).toBeNull()
    expect(checkSplit({ ...ok, legs: [{ to: 'btc', pct: 100 }] })).toMatch(/at least two/)
    expect(checkSplit({ ...ok, legs: [{ to: 'btc', pct: 50 }, { to: 'sol', pct: 49 }] })).toMatch(/100%/)
    expect(checkSplit({ ...ok, legs: [{ to: 'btc', pct: 50 }, { to: 'btc', pct: 50 }] })).toMatch(/once/)
    expect(checkSplit({ ...ok, legs: [{ to: 'xmr', pct: 50 }, { to: 'btc', pct: 50 }] })).toMatch(/Monero/)
    expect(checkSplit({ ...ok, amount: '0' })).toMatch(/amount/)
    expect(checkSplit({ ...ok, legs: Array.from({ length: 13 }, (_, i) => ({ to: ['btc', 'sol', 'ltc', 'doge', 'trx', 'eth', 'bnb', 'usdt-tron', 'usdc-base', 'usdt-ethereum', 'usdc-ethereum', 'pol', 'avax'][i], pct: i ? 8 : 4 })) })).toMatch(/Up to 12/)
  })
  it('fee off the top, parts add up exactly, nothing lost to rounding', () => {
    FEES.to = { evm: '0x000000000000000000000000000000000000dEaD' }
    const { fee, net, parts } = splitAmounts(1_000_000_000_000_000_001n, [33, 33, 34], 1500, 'evm')
    expect(fee + net).toBe(1_000_000_000_000_000_001n)
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(net)
    expect(fee).toBe(150_000_000_000_000_000n)
  })
})

describe('speed up (RBF)', () => {
  it('new BTC/LTC payments signal replace-by-fee; Dogecoin does not', () => {
    for (const fam of ['btc', 'ltc', 'doge'] as const) {
      const { pub } = signingKey(M, fam)
      const sel = _internal.utxoSelect(fam, pub, addr[fam], [{ txid: 'aa'.repeat(32), vout: 0, value: 500_000_000 }], addr[fam], 1_000_000n, false, fam === 'doge' ? 1000 : 5)!
      expect(sel.tx!.getInput(0).sequence === RBF_SEQ).toBe(fam !== 'doge')
    }
  })

  it('rebuilds the same payment with a higher fee taken only from change', async () => {
    const { priv, pub } = signingKey(M, 'btc')
    const to = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
    const sel = _internal.utxoSelect('btc', pub, addr.btc, [{ txid: 'ab'.repeat(32), vout: 1, value: 2_000_000 }], to, 500_000n, false, 2)!
    sel.tx!.sign(priv); sel.tx!.finalize()
    const raw = btc.Transaction.fromRaw(hexToBytes(sel.tx!.hex))
    const script = btc.p2wpkh(pub).script
    const vout = Array.from({ length: raw.outputsLength }, (_, i) => {
      const o = raw.getOutput(i)
      return { scriptpubkey: Buffer.from(o.script!).toString('hex'), scriptpubkey_address: btc.Address(btc.NETWORK).encode(btc.OutScript.decode(o.script!)), value: Number(o.amount) }
    })
    const esplora = { status: { confirmed: false }, weight: raw.weight, fee: Number(sel.fee), vin: [{ txid: 'ab'.repeat(32), vout: 1, prevout: { value: 2_000_000, scriptpubkey: Buffer.from(script).toString('hex'), scriptpubkey_address: addr.btc } }], vout }
    setFetcher(async (u) => new Response(JSON.stringify(String(u).includes('fees/recommended') ? { fastestFee: 20 } : esplora), { status: 200 }))
    const r = await bumpFee('btc', 'f'.repeat(64), addr.btc, (f) => signingKey(M, f), true)
    expect(r.rate).toBeGreaterThanOrEqual(20)
    expect(r.fee * 1e8).toBeGreaterThan(Number(sel.fee))
  })

  it('refuses a payment with no change to pay from', async () => {
    setFetcher(async () => new Response(JSON.stringify({ status: { confirmed: false }, weight: 440, fee: 300, vin: [{ txid: 'ab'.repeat(32), vout: 0, prevout: { value: 10_000, scriptpubkey_address: addr.btc } }], vout: [{ scriptpubkey: '00', scriptpubkey_address: 'bc1qother', value: 9700 }] })))
    await expect(bumpFee('btc', 'f'.repeat(64), addr.btc, (f) => signingKey(M, f), true)).rejects.toThrow(/no change/)
  })
})
