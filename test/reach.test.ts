import { describe, it, expect } from 'vitest'
import { ASSETS } from '../src/core/assets'
import { directProviders } from '../src/core/swap'
import { findPath, needsPath, canStage } from '../src/core/reach'
import { checkRoute } from '../src/core/route'

describe('swap coverage', () => {
  it('reaches every coin from every coin', () => {
    const dead: string[] = []
    for (const f of ASSETS) for (const t of ASSETS) {
      if (f.id === t.id) continue
      if (!findPath(f.id, t.id)) dead.push(`${f.id} -> ${t.id}`)
    }
    expect(dead).toEqual([])
  })

  it('keeps a one-provider pair at a single leg', () => {
    const p = findPath('eth', 'usdt-ethereum')!
    expect(p.legs).toHaveLength(1)
    expect(p.legs[0].providers.length).toBeGreaterThan(0)
    expect(needsPath('eth', 'usdt-ethereum')).toBe(false)
  })

  it('bridges Monero to a chain Wagyu does not reach', () => {
    expect(directProviders('xmr', 'pol')).toEqual([])
    const p = findPath('xmr', 'pol')!
    expect(p.coins[0]).toBe('xmr')
    expect(p.coins.at(-1)).toBe('pol')
    expect(p.legs.length).toBeGreaterThan(1)
    for (const l of p.legs) expect(l.providers.length).toBeGreaterThan(0)
  })

  it('bridges Tron to an L2', () => {
    expect(directProviders('usdt-tron', 'usdc-arbitrum')).toEqual([])
    const p = findPath('usdt-tron', 'usdc-arbitrum')!
    for (const l of p.legs) expect(l.providers.length).toBeGreaterThan(0)
  })

  it('every leg of every path is served by a real provider', () => {
    for (const f of ASSETS) for (const t of ASSETS) {
      if (f.id === t.id) continue
      const p = findPath(f.id, t.id)
      if (!p) continue
      expect(p.coins[0]).toBe(f.id)
      expect(p.coins.at(-1)).toBe(t.id)
      expect(new Set(p.coins).size).toBe(p.coins.length) // no coin visited twice
      for (const l of p.legs) expect(l.providers.length).toBeGreaterThan(0)
    }
  })

  it('stays within the leg budget', () => {
    let worst = 0
    for (const f of ASSETS) for (const t of ASSETS) {
      if (f.id === t.id) continue
      const p = findPath(f.id, t.id)
      if (p) worst = Math.max(worst, p.legs.length)
    }
    expect(worst).toBeLessThanOrEqual(4)
  })
})

describe('route fee', () => {
  it('charges the 2% route rate even when the route only covers a gap', async () => {
    const { routeFeeBps } = await import('../src/core/route')
    const { FEES } = await import('../src/core/fees')
    const p = findPath('xmr', 'pol')!
    const hops = p.legs.map((l) => ({ from: l.from, to: l.to, account: 0 }))
    expect(FEES.routeBps).toBe(200)
    expect(routeFeeBps({ from: 'xmr', amount: '1', hops })).toBe(FEES.routeBps)
  })

  it('charges the route rate when the user shaped the route themselves', async () => {
    const { routeFeeBps } = await import('../src/core/route')
    const { FEES } = await import('../src/core/fees')
    // eth -> btc is a direct pair; going the long way round is a choice, not a gap
    expect(routeFeeBps({ from: 'eth', amount: '1', hops: [{ from: 'eth', to: 'sol', account: 0 }, { from: 'sol', to: 'btc', account: 0 }] })).toBe(FEES.routeBps)
    // right endpoints, extra detour inserted
    expect(routeFeeBps({ from: 'xmr', amount: '1', hops: [{ from: 'xmr', to: 'btc', account: 0 }, { from: 'btc', to: 'eth', account: 0 }, { from: 'eth', to: 'pol', account: 0 }] })).toBe(FEES.routeBps)
  })

  it('charges the route rate for a single hop', async () => {
    const { routeFeeBps } = await import('../src/core/route')
    const { FEES } = await import('../src/core/fees')
    expect(routeFeeBps({ from: 'eth', amount: '1', hops: [{ from: 'eth', to: 'btc', account: 0 }] })).toBe(FEES.routeBps)
  })
})

describe('balance streaming', () => {
  it('reports each coin as it answers, not only at the end', async () => {
    const { getAllBalances } = await import('../src/core/chain')
    const seen: string[] = []
    const all = await getAllBalances({} as never, (b) => seen.push(b.asset))
    expect(seen.length).toBe(all.length)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBe(ASSETS.length)
  })
})

describe('route stops', () => {
  it('never parks coins in a token or in Monero mid-path', () => {
    for (const f of ASSETS) for (const t of ASSETS) {
      if (f.id === t.id) continue
      const p = findPath(f.id, t.id)
      if (!p) continue
      for (const mid of p.coins.slice(1, -1)) expect(canStage(mid), `${f.id} -> ${t.id} stops in ${mid}`).toBe(true)
    }
  })
  it('refuses a hand-built route that waits in a token', () => {
    const base = { from: 'eth', amount: '1' }
    expect(checkRoute({ ...base, hops: [{ from: 'eth', to: 'usdc-ethereum', account: 0 }, { from: 'usdc-ethereum', to: 'btc', account: 0 }] })).toMatch(/chain's own coin/)
    expect(checkRoute({ ...base, hops: [{ from: 'eth', to: 'btc', account: 0 }, { from: 'btc', to: 'usdc-ethereum', account: 0 }] })).toBeNull()
    expect(checkRoute({ ...base, hops: [{ from: 'eth', to: 'xmr', account: 0 }, { from: 'xmr', to: 'btc', account: 0 }] })).toMatch(/chain's own coin/)
  })
})
