import { describe, expect, it } from 'vitest'
import { getJson } from '../../src/core/chain'
import { InboundRadar } from '../../src/core/inbound'

// Picks an address that is being paid right now (from the live mempool) and checks the radar sees it.
describe.runIf(process.env.LIVE)('inbound radar (live mempool)', () => {
  for (const [net, base, fam] of [['bitcoin', 'https://mempool.space', 'btc'], ['litecoin', 'https://litecoinspace.org', 'ltc']] as const) {
    it(`sees an unconfirmed ${net} payment with a landing estimate`, async () => {
      const recent: any[] = await getJson(`${base}/api/mempool/recent`)
      let addr = ''
      for (const r of recent.slice(0, 30)) {
        const tx = await getJson(`${base}/api/tx/${r.txid}`)
        const o = tx.vout.find((v: any) => v.scriptpubkey_address && !tx.vin.some((i: any) => i.prevout?.scriptpubkey_address === v.scriptpubkey_address))
        if (o) { addr = o.scriptpubkey_address; break }
      }
      expect(addr).not.toBe('')
      const s = await new InboundRadar().scan({ [fam]: addr })
      console.log(net, addr, s.flying.slice(0, 2).map((f) => ({ amount: f.amount, block: f.block, etaMin: +((f.eta - Date.now()) / 60000).toFixed(1) })))
      expect(s.flying.length).toBeGreaterThan(0)
      expect(s.flying[0].eta).toBeGreaterThan(Date.now())
    }, 60_000)
  }
})
