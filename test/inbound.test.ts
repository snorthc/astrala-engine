import { afterEach, describe, expect, it } from 'vitest'
import { setFetcher } from '../src/core/chain'
import { InboundRadar, blockPosition } from '../src/core/inbound'

const ME = 'ltc1qme', THEM = 'ltc1qthem'
const tx = (txid: string, sats: number, fee = 1000, weight = 800) => ({
  txid, fee, weight, vin: [{ prevout: { scriptpubkey_address: THEM, value: sats + fee } }], vout: [{ scriptpubkey_address: ME, value: sats }]
})

/** a tiny fake Litecoin explorer: mempool contents + confirmed set, swappable per test */
function fakeChain() {
  const st = { mempool: [] as any[], confirmed: new Set<string>(), down: false }
  setFetcher(async (url: string) => {
    const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (st.down) throw new Error('offline')
    if (url.endsWith(`/address/${ME}/txs/mempool`)) return j(st.mempool)
    if (url.endsWith('/fees/mempool-blocks')) return j([{ feeRange: [5, 9] }, { feeRange: [2, 4] }, { feeRange: [1, 2] }])
    const m = url.match(/\/tx\/(\w+)\/status$/)
    if (m) return st.confirmed.has(m[1]) ? j({ confirmed: true }) : j('not found', 404)
    return j({}, 404)
  })
  return st
}

afterEach(() => setFetcher((u, i) => fetch(u, i)))

describe('inbound radar', () => {
  it('places a fee rate in the projected blocks', () => {
    const blocks = [{ feeRange: [5, 9] }, { feeRange: [2, 4] }]
    expect(blockPosition(6, blocks)).toBe(0)
    expect(blockPosition(3, blocks)).toBe(1)
    expect(blockPosition(1, blocks)).toBe(2) // below everything projected: after the last
  })

  it('sees a payment in the mempool, estimates its landing, then lands it once', async () => {
    const chain = fakeChain(), radar = new InboundRadar(), t0 = 1_000_000
    chain.mempool = [tx('aa', 70_000, 1000, 800)] // 1000 sat / 200 vB = 5 sat/vB → next block
    const a = await radar.scan({ ltc: ME }, null, t0)
    expect(a.flying).toHaveLength(1)
    expect(a.flying[0]).toMatchObject({ asset: 'ltc', amount: 0.0007, from: THEM, confs: 0, need: 1, seen: t0, eta: t0 + 150_000 })

    // still waiting: first-seen time is kept, nothing lands
    const b = await radar.scan({ ltc: ME }, null, t0 + 30_000)
    expect(b.flying[0].seen).toBe(t0)
    expect(b.landed).toHaveLength(0)

    // mined: leaves the mempool, status says confirmed → landed exactly once
    chain.mempool = []; chain.confirmed.add('aa')
    const c = await radar.scan({ ltc: ME }, null, t0 + 60_000)
    expect(c.flying).toHaveLength(0)
    expect(c.landed.map((l) => l.txid)).toEqual(['aa'])
    expect((await radar.scan({ ltc: ME }, null, t0 + 90_000)).landed).toHaveLength(0)
  })

  it('ignores our own outgoing payments and keeps state through a network outage', async () => {
    const chain = fakeChain(), radar = new InboundRadar()
    chain.mempool = [{ txid: 'out', fee: 500, weight: 600, vin: [{ prevout: { scriptpubkey_address: ME, value: 90_000 } }], vout: [{ scriptpubkey_address: THEM, value: 89_500 }] }, tx('in', 20_000, 300, 800)]
    const a = await radar.scan({ ltc: ME })
    expect(a.flying.map((f) => f.txid)).toEqual(['in'])
    expect(a.flying[0].eta - Date.now()).toBeGreaterThan(150_000) // 1.5 sat/vB → third block
    chain.down = true
    const b = await radar.scan({ ltc: ME })
    expect(b.flying.map((f) => f.txid)).toEqual(['in']) // unknown, not dropped
    expect(b.dropped).toHaveLength(0)
  })

  it('reports a payment the network dropped, after repeated misses', async () => {
    const chain = fakeChain(), radar = new InboundRadar()
    chain.mempool = [tx('rbf', 10_000)]
    await radar.scan({ ltc: ME })
    chain.mempool = []
    let dropped: string[] = []
    for (let i = 0; i < 6; i++) dropped = (await radar.scan({ ltc: ME })).dropped.map((d) => d.txid)
    expect(dropped).toEqual(['rbf'])
  })

  it('tracks Monero until it is spendable (10 confirmations)', async () => {
    fakeChain()
    const radar = new InboundRadar(), now = Date.now()
    const xin = (confirmations: number) => [{ txid: 'x1', direction: 'in' as const, amount: 0.5, time: now, confirmations, address: '' }]
    const a = await radar.scan({}, xin(0), now)
    expect(a.flying[0]).toMatchObject({ asset: 'xmr', confs: 0, need: 10, eta: now + 10 * 120_000 })
    expect((await radar.scan({}, xin(4), now)).flying[0].eta).toBe(now + 6 * 120_000)
    expect((await radar.scan({}, null, now)).flying).toHaveLength(1) // wallet unreadable: hold, don't drop
    expect((await radar.scan({}, xin(10), now)).landed.map((l) => l.txid)).toEqual(['x1'])
  })
})
