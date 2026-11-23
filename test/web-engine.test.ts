// The browser wallet's engine (src/web/engine.ts) and its crypto shim (src/web/node-crypto.ts). No network here:
// everything below is the vault, the keys and the payment rules. Sending is only tested up to its refusals.
import { describe, expect, it } from 'vitest'
import * as nodeCrypto from 'node:crypto'
import * as shim from '../src/web/node-crypto'
import { createEngine, type KV } from '../src/web/engine'
import { newMnemonic, deriveAccount } from '../src/core/derive'
import { open, type VaultFile } from '../src/core/vault'
import { memKV, serve } from '../src/web/web-kv'

const mem = (): KV & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>()
  // values go through JSON, as chrome.storage does: anything that can't survive that would be lost in the real thing too
  return { data, get: async (k) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : undefined), set: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))) }, remove: async (k) => { data.delete(k) } }
}
const host = (local = mem(), session = mem()) => { const events: [string, unknown][] = []; return { local, session, events, emit: (c: string, d: unknown) => { events.push([c, d]) } } }
const PW = 'correct horse battery staple'
type Eng = ReturnType<typeof createEngine>
/** A guarded call the way the host page makes it: prepare, (the user says yes), confirmed. */
const g = async (e: Eng, name: string, args: unknown[]): Promise<any> => {
  const p = (await e.call('prepare', [name, args])) as { ticket?: string; refuse?: string }
  if (!p.ticket) return name === 'revealMnemonic' ? null : { ok: false, error: p.refuse }
  return e.call('confirmed', [p.ticket])
}

describe('node:crypto shim (what the extension uses in the browser)', () => {
  const key = nodeCrypto.randomBytes(32), iv = nodeCrypto.randomBytes(12), text = 'the vault, as JSON: {"mnemonic":"…"}'
  it('seals what Node opens', () => {
    const c = shim.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]), tag = c.getAuthTag()
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag)
    expect(Buffer.concat([d.update(ct), d.final()]).toString('utf8')).toBe(text)
  })
  it('opens what Node seals, and refuses a wrong tag or a changed byte', () => {
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]), tag = c.getAuthTag()
    const d = shim.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag)
    expect(Buffer.concat([d.update(ct), d.final()]).toString('utf8')).toBe(text)
    const bad = shim.createDecipheriv('aes-256-gcm', key, iv); bad.setAuthTag(Buffer.alloc(16)); bad.update(ct)
    expect(() => bad.final()).toThrow()
    const flipped = Buffer.from(ct); flipped[3] ^= 1
    const bad2 = shim.createDecipheriv('aes-256-gcm', key, iv); bad2.setAuthTag(tag); bad2.update(flipped)
    expect(() => bad2.final()).toThrow()
  })
  it('hashes and compares like Node', () => {
    expect(shim.createHash('sha256').update('a').update('bc').digest('hex')).toBe(nodeCrypto.createHash('sha256').update('abc').digest('hex'))
    expect(shim.timingSafeEqual(Buffer.from('same'), Buffer.from('same'))).toBe(true)
    expect(shim.timingSafeEqual(Buffer.from('same'), Buffer.from('sane'))).toBe(false)
    expect(shim.randomBytes(24)).toHaveLength(24)
    expect(shim.randomBytes(16).equals(shim.randomBytes(16))).toBe(false)
    expect(() => shim.createCipheriv('aes-128-cbc', key, iv)).toThrow()
  })
})

describe('browser wallet engine', () => {
  it('creates a wallet the desktop app could open, with the same addresses', async () => {
    const h = host(), e = createEngine(h), words = newMnemonic()
    expect(await e.call('state')).toMatchObject({ hasVault: false, unlocked: false })
    await g(e, 'createVault', [{ mnemonic: words, password: PW, name: 'Vega' }])
    expect(await e.call('state')).toMatchObject({ hasVault: true, unlocked: true })
    // the sealed vault is the app's format: core/vault.ts opens it with the password
    const s = await open(h.local.data.get('vault') as VaultFile, PW)
    expect(s.mnemonic).toBe(words)
    expect(JSON.stringify(h.local.data.get('vault'))).not.toContain(words.split(' ')[3] + ' ' + words.split(' ')[4]) // never in the clear
    const [acct] = (await e.call('accounts')) as { name: string; addresses: { chain: string; address: string }[] }[]
    expect(acct.name).toBe('Vega')
    expect(acct.addresses).toEqual(deriveAccount(words, 0).filter((d) => d.chain !== 'xmr'))
    expect(acct.addresses.some((d) => d.chain === 'xmr')).toBe(false) // no Monero address is shown: this wallet can't see Monero arrive
    expect(await g(e, 'createVault', [{ mnemonic: newMnemonic(), password: PW }])).toMatchObject({ ok: false, error: 'A wallet already exists in this browser' }) // never written over
    await expect(g(createEngine(host()), 'createVault', [{ mnemonic: 'not a phrase', password: PW }])).rejects.toThrow('INVALID_MNEMONIC')
    await expect(g(createEngine(host()), 'createVault', [{ mnemonic: words, password: 'short' }])).rejects.toThrow('WEAK_PASSWORD')
  }, 60_000)

  it('stays unlocked across a worker restart, only while the browser session lasts', async () => {
    const h = host(), words = newMnemonic()
    await g(createEngine(h), 'createVault', [{ mnemonic: words, password: PW }])
    // the worker slept and woke: same disk, same in-memory session
    const woke = createEngine(host(h.local, h.session))
    expect(await woke.call('state')).toMatchObject({ unlocked: true })
    expect(((await woke.call('accounts')) as unknown[]).length).toBe(1)
    // the browser was closed: the session is gone, the wallet is locked, the password opens it
    const next = createEngine(host(h.local, mem()))
    expect(await next.call('state')).toMatchObject({ hasVault: true, unlocked: false })
    expect(await next.call('accounts')).toEqual([])
    expect(await next.call('unlock', ['wrong password'])).toBe(false)
    expect(await next.call('unlock', [PW])).toBe(true)
    expect(await g(next, 'revealMnemonic', ['wrong password'])).toBeNull()
    expect(await g(next, 'revealMnemonic', [PW])).toBe(words)
    await next.call('lock')
    expect(await next.call('state')).toMatchObject({ unlocked: false })
    expect(await g(next, 'revealMnemonic', [PW])).toBeNull() // locked: the phrase is not shown, even with the password
  }, 60_000)

  it('guards payments: PIN rules, lockout, single-use approval bound to the exact payment', async () => {
    let t = 1_700_000_000_000
    const h = { ...host(), now: () => t }, e = createEngine(h), words = newMnemonic()
    await g(e, 'createVault', [{ mnemonic: words, password: PW }])
    const req = { assetId: 'eth', to: '0x52908400098527886E0F7030069857D2E4169EE7', amount: '0.1', speed: 'normal' }
    expect(await e.call('send', [req])).toMatchObject({ ok: false, auth: true }) // no approval, no payment
    expect(await g(e, 'verifyPin', ['246810', { kind: 'send', req }])).toMatchObject({ ok: false, needSetup: true })
    expect(await g(e, 'setPin', [{ pin: '123456', password: PW }])).toMatchObject({ ok: false })
    expect(await g(e, 'setPin', [{ pin: '246810', password: 'wrong password' }])).toMatchObject({ ok: false, error: 'Wrong password' })
    expect(await g(e, 'setPin', [{ pin: '246810', password: PW }])).toEqual({ ok: true })
    expect(await e.call('payStatus')).toMatchObject({ pinSet: true })
    // a right PIN gives one token, good for that payment only, once
    const ok = (await g(e, 'verifyPin', ['246810', { kind: 'send', req }])) as { ok: boolean; token: string }
    expect(ok.ok).toBe(true)
    expect(await e.call('send', [{ ...req, amount: '5' }, ok.token])).toMatchObject({ ok: false, auth: true }) // a different amount
    expect(await e.call('send', [req, ok.token])).toMatchObject({ ok: false, auth: true }) // and the token is spent
    // five wrong PINs pause payments, even for the right PIN, until the pause ends
    for (let i = 0; i < 4; i++) expect(await g(e, 'verifyPin', ['111112', { kind: 'send', req }])).toMatchObject({ ok: false, error: 'Wrong PIN', remaining: 4 - i })
    expect(await g(e, 'verifyPin', ['111112', { kind: 'send', req }])).toMatchObject({ ok: false, lockedUntil: t + 5 * 60_000 })
    expect(await g(e, 'verifyPin', ['246810', { kind: 'send', req }])).toMatchObject({ ok: false, lockedUntil: t + 5 * 60_000 })
    t += 5 * 60_000 + 1
    expect(await g(e, 'verifyPin', ['246810', { kind: 'send', req }])).toMatchObject({ ok: true })
    // the count is in the sealed vault, not in memory: a restart does not hand guesses back
    await g(e, 'verifyPin', ['111112', { kind: 'send', req }])
    const again = createEngine({ ...host(h.local, h.session), now: () => t })
    expect(await g(again, 'verifyPin', ['111112', { kind: 'send', req }])).toMatchObject({ ok: false, remaining: 3 })
    // swaps and anything else this wallet doesn't do are refused, not faked
    expect(await g(e, 'verifyPin', ['246810', { kind: 'swap', req: {} }])).toMatchObject({ ok: false })
    expect(await e.call('swap', [{}])).toMatchObject({ ok: false })
    expect(await e.call('noSuchCall')).toMatchObject({ ok: false })
    expect(await e.call('routeStatus')).toMatchObject({ mode: 'direct' })
  }, 120_000)

  it('counts PIN guesses fired together one at a time, so a burst cannot outrun the lockout', async () => {
    const t = 1_700_000_000_000
    const h = { ...host(), now: () => t }, e = createEngine(h)
    await g(e, 'createVault', [{ mnemonic: newMnemonic(), password: PW }])
    await g(e, 'setPin', [{ pin: '246810', password: PW }])
    const req = { assetId: 'eth', to: '0x52908400098527886E0F7030069857D2E4169EE7', amount: '0.1', speed: 'normal' }
    // seven wrong guesses and then the right PIN, all sent at once
    const burst = await Promise.all([...Array(7).fill('111112'), '246810'].map((pin) => g(e, 'verifyPin', [pin, { kind: 'send', req }]))) as { ok: boolean; token?: string; lockedUntil?: number; error?: string }[]
    expect(burst.filter((r) => r.error === 'Wrong PIN')).toHaveLength(4) // only four were ever tested as plain misses
    expect(burst[4]).toMatchObject({ ok: false, lockedUntil: t + 5 * 60_000 }) // the fifth paused payments
    expect(burst.slice(5).every((r) => !r.ok && r.lockedUntil === t + 5 * 60_000)).toBe(true) // the rest, the right PIN included, were refused untested
    expect(burst.some((r) => r.token)).toBe(false)
  }, 120_000)

  it('makes one wallet when two are asked for at once', async () => {
    const h = host(), e = createEngine(h), a = newMnemonic(), b = newMnemonic()
    const both = await Promise.allSettled([g(e, 'createVault', [{ mnemonic: a, password: PW }]), g(e, 'createVault', [{ mnemonic: b, password: PW }])])
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((await open(h.local.data.get('vault') as VaultFile, PW)).mnemonic).toBe(a) // the first one stands
  }, 120_000)

  it('locks itself after the auto-lock time, even across a worker restart', async () => {
    let t = 1_700_000_000_000
    const h = { ...host(), now: () => t }, e = createEngine(h)
    await g(e, 'createVault', [{ mnemonic: newMnemonic(), password: PW }])
    await e.call('setPrefs', [{ autoLockMin: 5 }])
    t += 4 * 60_000
    expect(await e.call('state')).toMatchObject({ unlocked: true }) // used within the time: stays open
    t += 6 * 60_000
    const woke = createEngine({ ...host(h.local, h.session), now: () => t }) // the worker slept through it
    expect(await woke.call('accounts')).toEqual([])
    expect(await woke.call('state')).toMatchObject({ hasVault: true, unlocked: false })
    expect(h.session.data.has('key')).toBe(false) // the key is gone from memory too
    expect(await woke.call('unlock', [PW])).toBe(true)
    await woke.call('setPrefs', [{ autoLockMin: 0 }]); t += 24 * 3600_000
    expect(await woke.call('state')).toMatchObject({ unlocked: true }) // 0 means never
  }, 120_000)

  it('guarded calls cannot be made by name, and what is asked is exactly what runs', async () => {
    const h = host(), e = createEngine(h)
    const words = newMnemonic(), w = words.split(' ')
    // making a wallet: the question quotes the phrase's first and last words, so a swapped phrase can be noticed
    await expect(e.call('createVault', [{ mnemonic: words, password: PW }])).rejects.toThrow('confirmation')
    const mk = (await e.call('prepare', ['createVault', [{ mnemonic: words, password: PW, name: 'Vega' }]])) as { ticket: string; ask: { text: string } }
    expect(mk.ask.text).toContain(`“${w[0]} ${w[1]}”`); expect(mk.ask.text).toContain(`“${w[23]}”`)
    await e.call('confirmed', [mk.ticket])
    await expect(e.call('confirmed', [mk.ticket])).rejects.toThrow() // a ticket works once
    for (const name of ['verifyPin', 'setPin', 'setLimit', 'revealMnemonic', 'resetWallet']) await expect(e.call(name, ['x'])).rejects.toThrow('confirmation')
    await g(e, 'setPin', [{ pin: '246810', password: PW }])
    const req = { assetId: 'eth', to: '0x52908400098527886E0F7030069857D2E4169EE7', amount: '0.25', speed: 'normal' }
    const p = (await e.call('prepare', ['verifyPin', ['246810', { kind: 'send', req }]])) as { ticket: string; ask: { title: string; text: string } }
    expect(p.ask.title).toBe('Confirm this payment')
    expect(p.ask.text).toContain('0.25'); expect(p.ask.text).toContain('“Vega”')
    expect(p.ask.text).toContain('0x52908400098527886E0F7030069857D2E4169EE7') // the whole address, never shortened
    // locked: refused, not waved through; and locking throws away tickets already handed out
    await e.call('lock')
    await expect(e.call('confirmed', [p.ticket])).rejects.toThrow()
    expect(await e.call('prepare', ['verifyPin', ['246810', { kind: 'send', req }]])).toEqual({ refuse: 'Wallet is locked' })
    expect(await e.call('prepare', ['setPin', [{ pin: '135790', password: PW }]])).toEqual({ refuse: 'Wallet is locked' })
    expect(await e.call('unlock', [PW])).toBe(true)
    // a malformed payment is refused before any PIN is tried (no oracle)
    await expect(e.call('prepare', ['verifyPin', ['111112', { kind: 'send' }]])).rejects.toThrow()
    expect(await e.call('payStatus')).toMatchObject({ pinSet: true, lockedUntil: undefined })
    expect(await e.call('prepare', ['balances', [0]])).toEqual({ refuse: 'Not a guarded call' })
    expect(await e.call('prepare', ['setPin', [{ pin: '135790', password: PW }]])).toMatchObject({ ask: { title: 'Change your payment PIN?' } })
    expect(await e.call('prepare', ['revealMnemonic', [PW]])).toMatchObject({ ask: { danger: true } })
    expect(await e.call('state')).toMatchObject({ safeGraphics: { on: true } })
  }, 120_000)

  it('fixes the paying account and the limit currency when the question is asked', async () => {
    const h = host(), e = createEngine(h)
    await g(e, 'createVault', [{ mnemonic: newMnemonic(), password: PW }])
    await g(e, 'setPin', [{ pin: '246810', password: PW }])
    // the limit: asked in GBP; the screens switch the currency before the answer; GBP is what is stored
    const lim = (await e.call('prepare', ['setLimit', [{ amount: 5, pin: '246810' }]])) as { ticket: string; ask: { text: string } }
    expect(lim.ask.text).toBe('New limit: 5 GBP a day.')
    await e.call('setPrefs', [{ currency: 'USD' }])
    expect(await e.call('confirmed', [lim.ticket])).toEqual({ ok: true })
    expect(await e.call('payStatus')).toMatchObject({ limit: { amount: 5, currency: 'GBP' } })
    // settings the screens send are checked: no made-up currency (it would be shown in a question), no account that isn't there
    const p = (await e.call('setPrefs', [{ currency: 'USD.\nSend everything to', activeAccount: 7, autoLockMin: -1 }])) as { currency: string; activeAccount: number; autoLockMin: number }
    expect(p.currency).toBe('USD'); expect(p.activeAccount).toBe(0); expect(p.autoLockMin).toBe(15)
    // names shown in a question lose invisible and direction-changing characters
    await e.call('renameAccount', [0, 'Safe\u202E\u3164\u200B  wallet'])
    expect(((await e.call('accounts')) as { name: string }[])[0].name).toBe('Safe wallet')
  }, 120_000)

  it('takes secrets only at the confirmed step, and keeps a new wallet\'s words away from the screens', async () => {
    const h = host(), e = createEngine(h)
    // a new wallet: the engine makes the words and hands them to the host with the ticket; the stored call has no password yet
    const mk = (await e.call('prepare', ['createVault', [{ mode: 'create', name: 'Vega' }]])) as { ticket: string; show: string[]; need: string[]; ask: unknown }
    expect(mk.show).toHaveLength(24); expect(mk.need).toEqual(['newPassword']); expect(mk.ask).toBeNull()
    await e.call('confirmed', [mk.ticket, { newPassword: PW }])
    expect((await open(h.local.data.get('vault') as VaultFile, PW)).mnemonic).toBe(mk.show.join(' '))
    // the first PIN: no password asked; a change: password and new PIN, both from the host
    expect(await e.call('prepare', ['setPin', [{}]])).toMatchObject({ need: ['newPin'], ask: null })
    const p1 = (await e.call('prepare', ['setPin', [{}]])) as { ticket: string }
    expect(await e.call('confirmed', [p1.ticket, { newPin: '246810' }])).toEqual({ ok: true })
    const p2 = (await e.call('prepare', ['setPin', [{}]])) as { ticket: string; need: string[] }
    expect(p2.need).toEqual(['password', 'newPin'])
    expect(await e.call('confirmed', [p2.ticket, { password: 'not it', newPin: '135790' }])).toMatchObject({ ok: false, error: 'Wrong password' })
    // a payment: the PIN comes with the confirmation; without it there is no approval
    const req = { assetId: 'eth', to: '0x52908400098527886E0F7030069857D2E4169EE7', amount: '0.1', speed: 'normal' }
    const v0 = (await e.call('prepare', ['verifyPin', ['', { kind: 'send', req }, false]])) as { ticket: string; need: string[] }
    expect(v0.need).toEqual(['pin'])
    expect(await e.call('confirmed', [v0.ticket, {}])).toMatchObject({ ok: false })
    const v1 = (await e.call('prepare', ['verifyPin', ['', { kind: 'send', req }, false]])) as { ticket: string }
    expect(await e.call('confirmed', [v1.ticket, { pin: '246810' }])).toMatchObject({ ok: true })
    // the phrase and removing the wallet: password from the host
    const r0 = (await e.call('prepare', ['revealMnemonic', []])) as { ticket: string; need: string[] }
    expect(r0.need).toEqual(['password'])
    expect(await e.call('confirmed', [r0.ticket, { password: PW }])).toBe(mk.show.join(' '))
    // restoring: the words and the password both arrive at the confirmed step
    const h2 = host(), e2 = createEngine(h2), words = newMnemonic()
    const rs = (await e2.call('prepare', ['createVault', [{ mode: 'restore' }]])) as { ticket: string; need: string[]; show?: unknown }
    expect(rs.need).toEqual(['mnemonic', 'newPassword']); expect(rs.show).toBeUndefined()
    await e2.call('confirmed', [rs.ticket, { mnemonic: words, newPassword: PW }])
    expect((await open(h2.local.data.get('vault') as VaultFile, PW)).mnemonic).toBe(words)
    expect(await e2.call('prepare', ['createVault', [{ mode: 'create' }]])).toEqual({ refuse: 'A wallet already exists in this browser' })
  }, 120_000)

  it('slows down password guessing', async () => {
    let t = 1_700_000_000_000
    const h = { ...host(), now: () => t }, e = createEngine(h)
    await g(e, 'createVault', [{ mnemonic: newMnemonic(), password: PW }])
    await e.call('lock')
    for (let i = 0; i < 3; i++) expect(await e.call('unlock', ['wrong password ' + i])).toBe(false)
    expect(await e.call('unlock', [PW])).toBe(false) // inside the pause even the right one is not checked
    t += 1001
    expect(await e.call('unlock', [PW])).toBe(true)
  }, 120_000)

  it('runs on the hosted web wallet\'s storage and worker protocol (src/web/web-kv.ts)', async () => {
    // the session store: values are copies (as chrome.storage gives), and a new worker starts with nothing
    const s = memKV(), v = { a: [1, 2] }
    await s.set('k', v); v.a.push(3)
    expect(await s.get('k')).toEqual({ a: [1, 2] })
    await s.set('k', undefined); expect(await s.get('k')).toBeUndefined()
    // the engine on these stores: a wallet made in one tab is locked in the next (the key lived in the first worker only)
    const local = mem(), e = createEngine({ local, session: memKV(), emit: () => {} })
    await g(e, 'createVault', [{ mnemonic: newMnemonic(), password: PW }])
    expect(await e.call('state')).toMatchObject({ unlocked: true })
    const next = createEngine({ local, session: memKV(), emit: () => {} })
    expect(await next.call('state')).toMatchObject({ hasVault: true, unlocked: false })
    // the page ⇄ worker protocol: replies carry the id; errors come back as text; anything else is ignored
    const out: any[] = [], handle = serve(next, (m) => out.push(m))
    handle({ type: 'engine', name: 'unlock', args: [PW], id: 7 })
    handle({ type: 'engine', name: 'createVault', args: [{}], id: 8 }) // gated: refused by name
    handle({ type: 'nope', name: 'state', id: 9 }); handle({ type: 'engine', name: 'state', id: 'x' }); handle(null)
    await new Promise((r) => setTimeout(r, 4000))
    expect(out.find((m) => m.id === 7)).toEqual({ t: 'reply', id: 7, result: true })
    expect(out.find((m) => m.id === 8)).toMatchObject({ t: 'reply', id: 8, error: expect.stringContaining('confirmation') })
    expect(out).toHaveLength(2)
  }, 60_000)

  it('keeps the app-only settings out and removes the wallet only with the password', async () => {
    const h = host(), e = createEngine(h)
    await g(e, 'createVault', [{ mnemonic: newMnemonic(), password: PW }])
    const p = (await e.call('setPrefs', [{ currency: 'USD', route: { mode: 'tor', proxy: '', killSwitch: true }, bridge: true }])) as { currency: string; route: { mode: string }; bridge?: boolean }
    expect(p.currency).toBe('USD'); expect(p.route.mode).toBe('direct'); expect(p.bridge).toBeFalsy()
    const q = (await e.call('setPrefs', [{ junk: 'x'.repeat(50_000), sky: 'aurora' }])) as Record<string, unknown>
    expect(q.junk).toBeUndefined(); expect(q.sky).toBe('aurora')
    expect(JSON.stringify(h.local.data.get('prefs')).length).toBeLessThan(2000)
    expect(await e.call('history', ['../../x', 'USD', 7])).toEqual([])
    expect(await e.call('cachedPrices', ['not a currency'])).toBeNull()
    expect(await g(e, 'resetWallet', ['wrong password'])).toBe(false)
    expect(h.local.data.has('vault')).toBe(true)
    expect(await g(e, 'resetWallet', [PW])).toBe(true)
    expect(await e.call('state')).toMatchObject({ hasVault: false, unlocked: false })
  }, 60_000)
})
