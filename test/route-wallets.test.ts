import { describe, it, expect } from 'vitest'

/** Mirrors keepRoutes in main: the last 100 routes are kept, and any wallet belonging to a dropped
 *  route is untagged so it returns to the account switcher. A wallet that is both filtered out of
 *  the switcher (it has a route tag) and has no route left to open is money reachable from nowhere. */
function keepRoutes(all: { id: string }[], accounts: { index: number; route?: string }[]) {
  const kept = all.slice(0, 100)
  if (kept.length !== all.length) {
    const live = new Set(kept.map((r) => r.id))
    for (const a of accounts) if (a.route && !live.has(a.route)) delete a.route
  }
  return kept
}

const visible = (accounts: { index: number; route?: string }[], routes: { id: string }[]) => {
  const live = new Set(routes.map((r) => r.id))
  return accounts.filter((a) => !a.route || live.has(a.route))
}

describe('route wallets stay reachable', () => {
  it('hands a dropped route’s wallets back to the account switcher', () => {
    const routes = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` }))
    const accounts = [{ index: 0 }, { index: 1, route: 'old' }, { index: 2, route: 'r0' }]
    const kept = keepRoutes([...routes, { id: 'old' }], accounts)
    expect(kept).toHaveLength(100)
    expect(accounts.find((a) => a.index === 1)!.route).toBeUndefined() // back in the switcher
    expect(accounts.find((a) => a.index === 2)!.route).toBe('r0') // its route is still listed
  })

  it('leaves no wallet hidden from both the switcher and the route panel', () => {
    const accounts = [{ index: 0 }, { index: 1, route: 'a' }, { index: 2, route: 'b' }, { index: 3, route: 'c' }]
    const all = Array.from({ length: 101 }, (_, i) => ({ id: i === 100 ? 'c' : `r${i}` }))
    // 'a' and 'b' are not in the list at all; 'c' is the one that falls off the end
    const kept = keepRoutes(all, accounts)
    for (const a of accounts) {
      const reachable = !a.route || kept.some((r) => r.id === a.route)
      expect(reachable).toBe(true)
    }
    expect(visible(accounts, kept).length).toBe(accounts.length)
  })

  it('keeps wallets tagged while their route is still listed', () => {
    const routes = [{ id: 'r1' }]
    const accounts = [{ index: 5, route: 'r1' }]
    keepRoutes(routes, accounts)
    expect(accounts[0].route).toBe('r1') // nothing dropped, nothing untagged
    expect(visible(accounts, routes)).toHaveLength(1)
  })
})
