import type { ActivityItem, HistoryItem, Contact } from '../shared/api'

/** Address poisoning: attackers mint an address that shares your contact's first and last characters, then dust you from it so it sits in your history. */
const same = (a: string, b: string) => (a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b)
const head = (a: string) => (a.startsWith('0x') ? a.slice(2, 6).toLowerCase() : a.slice(0, 4))
const tail = (a: string) => (a.startsWith('0x') ? a.slice(-4).toLowerCase() : a.slice(-4))

export interface AddressCheck {
  contact?: Contact
  sentBefore: number
  lookalike?: { address: string; name?: string }
  dustOnly: boolean
}

export function checkAddress(to: string, ctx: { book: Contact[]; activity: ActivityItem[]; history: HistoryItem[] }): AddressCheck {
  const a = to.trim()
  const contact = ctx.book.find((c) => same(c.address, a))
  const outs = [...ctx.activity.filter((x) => x.kind === 'send').map((x) => x.to), ...ctx.history.filter((h) => h.direction === 'out').map((h) => h.counterparty)].filter(Boolean)
  const sentBefore = outs.filter((o) => same(o, a)).length
  // trusted = saved contacts + places you've actually paid
  const trusted = [...ctx.book.map((c) => ({ address: c.address, name: c.name })), ...outs.map((o) => ({ address: o, name: undefined as string | undefined }))]
  const lookalike = contact || sentBefore ? undefined : trusted.find((t) => !same(t.address, a) && t.address.length === a.length && head(t.address) === head(a) && tail(t.address) === tail(a))
  const ins = ctx.history.filter((h) => h.direction === 'in' && same(h.counterparty, a))
  const dustOnly = !contact && !sentBefore && ins.length > 0 && ins.every((h) => h.amount === 0 || h.amount < 1e-6)
  return { contact, sentBefore, lookalike, dustOnly }
}
