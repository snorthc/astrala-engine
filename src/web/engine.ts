// The wallet engine for the browser extension when there is no Astrala app on the computer (Windows, Linux).
// It plays the part the desktop app's main process plays: it alone holds the vault and the keys, and the popup's
// screens reach it only through call(name, args), exactly as the app's window reaches main through IPC.
//
// It runs in the extension's background worker. The vault (same format as the app's vault.json: Argon2id +
// AES-256-GCM) lives in chrome.storage.local. While unlocked, the derived key sits in chrome.storage.session, which
// Chrome keeps in memory only and clears when the browser closes, so the worker can sleep and wake without asking
// for the password again, and nothing unlocked is ever written to disk.
//
// Smaller than the app on purpose. Here: create or restore a wallet, unlock, accounts and addresses, balances,
// prices, a payment PIN with the same lockout, the daily limit, and sending. Not here: Monero, Tor and Mullvad
// routing, hardware wallets, the duress PIN, Touch ID, swaps, splits, routes, staking and websites. Calls for those
// answer "not available" (NOT_HERE) or an empty value (NEUTRAL), never invented data.
import { newMnemonic, isValidMnemonic, normalise, deriveAccount, signingKey, clearSeedCache } from '../core/derive'
import { sealKeyFor, sealWith, openWith, open, hashPin, checkPin, type VaultSecrets, type VaultFile, type SealKey, type ActivityItem } from '../core/vault'
import { getAllBalances, getPrices, getHistory, type Addresses, type Balance, type PriceInfo } from '../core/chain'
import { quote, execute, validateAddress, type SendRequest } from '../core/send'
import { PIN_RE, pinBlocked, onPinFail, spent24h, isOverLimit, Approvals } from '../core/paysafe'
import { normIntent, intentSummary, type Intent } from '../core/intent-summary'
import { ASSET } from '../core/assets'
import { accountType } from '../core/account-types'
import { DEFAULT_PREFS, type Prefs, type AppState, type Account } from '../shared/api'
import { randomBytes } from 'node:crypto'
import { Buffer } from 'buffer'

/** A key-value store: chrome.storage.local for what must survive (the sealed vault, settings), .session for the unlocked key. */
export interface KV { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> }
export interface EngineHost { local: KV; session: KV; emit: (channel: string, data: unknown) => void; now?: () => number }

const NOT_HERE = { ok: false as const, error: 'Not available in the browser wallet yet. The Astrala app has it.' }
/** Calls the popup makes that this engine has no feature behind: each answers "nothing", in the shape the screens expect. */
const NEUTRAL: Record<string, () => unknown> = {
  unlockTouchId: () => false, touchActive: () => undefined, enableTouchId: () => false, disableTouchId: () => undefined,
  hiddenAccounts: () => [], randomName: () => 'Wallet', tokens: () => [], tokenSearch: () => [], watchBalances: () => [],
  txHistory: () => [], historyHealth: () => ({ failed: [], at: Date.now() }), inbound: () => ({ flying: [], landed: [], dropped: [] }),
  splits: () => [], routes: () => [], approvals: () => [], traySummary: () => undefined, setBadge: () => undefined, notifyOs: () => undefined,
  routeStatus: () => ({ mode: 'direct', state: 'ready', percent: 100 }), torCheck: () => ({ isTor: false }),
  mullvadStatus: () => ({ installed: false, state: 'disconnected' }), netHealth: () => ({ ok: true, chains: [] }),
  xmrStatus: () => ({ state: 'off', percent: 0 }), duressStatus: () => ({ enabled: false }), hwStatus: () => ({ supported: false, connected: false }),
  bridgeState: () => ({ on: false, port: null, paired: false, sites: [] }), phoneInfo: () => ({ on: false, running: false, error: '', paired: false, urls: [] }),
  checkUpdate: () => null, pickBackup: () => null, validShare: () => false, discordPresence: () => undefined, windowControl: () => undefined, copy: () => undefined, paste: () => ''
}
const DATA_KEYS: Record<string, number> = { book: 500, favs: 200, alerts: 200, watch: 100 } // the lists the screens may keep in the vault, and their size caps
const defaultAvatar = (i: number) => ({ kind: 'orb' as const, hue: (262 + i * 67) % 360, hue2: (195 + i * 89) % 360 })
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
/** Calls that move money, show or replace the recovery phrase, or change what guards payments. They cannot be called
 *  by name: only through prepare() and confirmed(), so what the user is asked and what runs are the same stored thing. */
const GATED = new Set(['verifyPin', 'setPin', 'setLimit', 'revealMnemonic', 'resetWallet', 'createVault'])
const TICKET_MS = 2 * 60_000
/** A name as it may be shown in a confirmation: no control, format or blank-looking characters that could hide or reorder text. */
const plainName = (n: string) => n.replace(/[\p{Cc}\p{Cf}\u00AD\u034F\u061C\u115F\u1160\u2800\u3164\uFFA0]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 32)
const CUR_RE = /^[A-Za-z]{3,5}$/
/** Settings the popup may change here: the app's routing, doors and device features don't exist in the browser wallet. */
const PREF_KEYS = ['currency', 'motion', 'sound', 'ambient', 'volume', 'autoLockMin', 'clipboardClearSec', 'activeAccount', 'stealth', 'blurOnFocusLoss', 'sky', 'themeAuto', 'accountThemes', 'stealthOnUnlock', 'notifications', 'tour'] as const

export function createEngine(host: EngineHost) {
  const now = host.now ?? Date.now
  let secrets: VaultSecrets | null = null
  let sealKey: SealKey | null = null
  let prefs: Prefs = { ...DEFAULT_PREFS }
  let accounts: Account[] = []
  const approvals = new Approvals()
  const tickets = new Map<string, { name: string; args: unknown[]; exp: number }>()
  let pwFails = 0, pwNext = 0 // wrong passwords this session, and when the next try is allowed
  const priceMem: Record<string, Record<string, PriceInfo>> = {}
  let busy: Promise<unknown> = Promise.resolve() // one payment at a time
  // One at a time, in order. PIN guesses fired together would each pass the "not paused" check before any had been
  // counted against the limit; and two wallet creations at once could write over each other.
  const queue = () => { let tail: Promise<unknown> = Promise.resolve(); return <T,>(fn: () => Promise<T>): Promise<T> => { const r = tail.then(fn); tail = r.catch(() => {}); return r } }
  const pinQueue = queue(), vaultQueue = queue()
  let lastTouch = 0

  const vaultFile = async () => ((await host.local.get('vault')) as VaultFile | undefined) ?? null
  const persist = async () => { if (secrets && sealKey) await host.local.set('vault', sealWith(secrets, sealKey)) }
  const savePrefs = async () => host.local.set('prefs', prefs)
  const diskPrices = async (c: string) => { const d = (await host.local.get('prices')) as { cur: string; map: Record<string, PriceInfo> } | undefined; return d?.cur === c ? d.map : null }
  // Monero needs its own scanner (not in the browser wallet): its address is left out, so nothing invites a deposit that can't be seen here
  const build = () => {
    accounts = !secrets ? [] : secrets.accounts.filter((a) => !a.hidden && !a.route && !a.hw).map((a) => ({
      index: a.index, name: a.name, avatar: a.avatar ?? defaultAvatar(a.index), type: accountType(a.type),
      addresses: deriveAccount(secrets!.mnemonic, a.index).filter((d) => d.chain !== 'xmr')
    })) as Account[]
  }
  const active = () => (accounts.some((a) => a.index === prefs.activeAccount) ? prefs.activeAccount : accounts[0]?.index ?? 0)
  const addressesFor = (index: number): Addresses | null => {
    const a = accounts.find((x) => x.index === index)
    return a ? (Object.fromEntries(a.addresses.map((d) => [d.chain, d.address])) as Addresses) : null
  }
  const keyFor = (acct: number) => { const m = secrets!.mnemonic; return (f: Parameters<typeof signingKey>[1]) => signingKey(m, f, acct) }

  /** After the worker wakes: settings from disk, and the wallet reopened from the in-memory session key if there is one. */
  let readyP: Promise<void> | null = null
  const load = async () => {
    prefs = { ...DEFAULT_PREFS, ...((await host.local.get('prefs')) as Partial<Prefs> | undefined) }
    const k = (await host.session.get('key')) as { key: string; salt: string; kdf: SealKey['kdf'] } | undefined
    const file = await vaultFile()
    if (!k || !file) return
    try {
      const sk: SealKey = { key: Buffer.from(k.key, 'hex'), salt: Buffer.from(k.salt, 'hex'), kdf: k.kdf }
      secrets = openWith(file, sk); sealKey = sk; build()
    } catch { await host.session.remove('key') } // the vault changed under it (restored, replaced): ask for the password
  }
  /** After the worker wakes: settings from disk, and the wallet reopened from the in-memory session key if there is one. */
  const ready = () => (readyP ??= load().catch((e) => { readyP = null; throw e }))
  /** Auto-lock: unused for longer than the setting (minutes; 0 = never) locks the wallet. The worker sleeps, so this is
   *  checked on the way in to every call rather than with a timer; the last-use time lives with the session key. */
  const idleCheck = async () => {
    if (!secrets) return
    const t = now(), mins = Number(prefs.autoLockMin) || 0
    const last = lastTouch || Number(await host.session.get('lastUse')) || t
    if (mins > 0 && t - last > mins * 60_000) { await lock(); return }
    if (t - lastTouch > 20_000) { lastTouch = t; await host.session.set('lastUse', t) }
  }
  const lock = async () => {
    secrets = null; sealKey?.key.fill(0); sealKey = null; accounts = []
    approvals.clear(); tickets.clear(); clearSeedCache(); lastTouch = 0
    await host.session.remove('key'); await host.session.remove('lastUse')
    host.emit('locked', null)
  }
  const opened = async (s: VaultSecrets, sk: SealKey) => {
    secrets = s; sealKey = sk; build()
    lastTouch = now()
    await host.session.set('key', { key: hex(sk.key), salt: hex(sk.salt), kdf: sk.kdf }); await host.session.set('lastUse', lastTouch)
  }

  // ---------- payment safety: the same rules as the app (core/paysafe.ts), enforced here and never in the popup ----------
  const savePay = async (p: Partial<NonNullable<VaultSecrets['pay']>>) => { if (!secrets) return; secrets.pay = { ...secrets.pay, ...p }; await persist() }
  const fiatPrice = async (cur: string) => {
    const m = (await getPrices(cur).catch(() => null)) ?? priceMem[cur]
    if (m) priceMem[cur] = m
    return (id: string) => priceMem[cur]?.[ASSET[id]?.cg]?.price
  }
  const limitCheck = async (i: Intent) => {
    const lim = secrets?.pay?.limit
    if (!lim || !secrets || i.kind !== 'send') return null
    const price = await fiatPrice(lim.currency)
    let amount = Number(i.req.amount) || 0
    if (i.req.max) { const acct = i.req.account ?? active(), addrs = addressesFor(acct); if (addrs) amount = (await quote(i.req, addrs, keyFor(acct)).catch(() => ({ amount: 0 }))).amount }
    const t = now(), recent = (secrets.activity ?? []).filter((a) => a.status !== 'failed' && t - a.time < 86_400_000)
    const known = (id: string) => (price(id) ?? 0) > 0 // no price means it can't be shown to be under the limit, so it isn't
    const unknown = !known(i.req.assetId) || recent.some((a) => !known(a.asset))
    const amountFiat = amount * (price(i.req.assetId) ?? 0), spent = spent24h(secrets.activity ?? [], price, t)
    return { limit: lim.amount, currency: lim.currency, spent, amount: amountFiat, over: unknown || isOverLimit(lim.amount, spent, amountFiat) }
  }
  const safeLimit = async (i: Intent) => {
    try { return await limitCheck(i) } catch { const lim = secrets?.pay?.limit; return lim ? { limit: lim.amount, currency: lim.currency, spent: 0, amount: 0, over: true } : null }
  }
  const tryPin = (pin: unknown) => pinQueue(() => tryPinNow(pin))
  const tryPinNow = async (pin: unknown) => {
    if (!secrets) return { ok: false as const, error: 'Wallet is locked' }
    const stored = secrets.pay?.pin
    if (!stored) return { ok: false as const, error: 'Set up your payment PIN first', needSetup: true }
    const t = now(), g = { fails: secrets.pay?.fails ?? 0, lockUntil: secrets.pay?.lockUntil }
    if (pinBlocked(g, t)) return { ok: false as const, error: 'Too many wrong PINs. Payments are paused for a few minutes.', lockedUntil: g.lockUntil }
    secrets.pay = { ...secrets.pay, fails: g.fails + 1 } // counted and saved before the check, so closing the browser mid-guess doesn't hand the attempt back
    await persist()
    if (typeof pin === 'string' && PIN_RE.test(pin) && (await checkPin(pin, stored))) { await savePay({ fails: 0, lockUntil: undefined }); return { ok: true as const } }
    const r = onPinFail({ fails: Math.max(0, (secrets?.pay?.fails ?? 1) - 1), lockUntil: secrets?.pay?.lockUntil }, t)
    await savePay({ fails: r.guard.fails, lockUntil: r.guard.lockUntil })
    if (r.lockApp) { await lock(); return { ok: false as const, error: 'Ten wrong PINs. Astrala locked itself. Unlock with your password.', appLocked: true } }
    return { ok: false as const, error: r.lockUntil ? 'Five wrong PINs. Payments are paused for 5 minutes.' : 'Wrong PIN', remaining: r.remaining, lockedUntil: r.lockUntil }
  }
  const sendNow = async (raw: SendRequest, token?: string) => {
    if (!secrets) return { ok: false as const, error: 'Wallet is locked' }
    // normalised once: the account the approval named is the account that pays, whatever becomes "active" meanwhile
    const n = normIntent({ kind: 'send', req: raw }, active())
    if (n.kind !== 'send') return NOT_HERE
    const req: SendRequest = { ...n.req }, i: Intent = { kind: 'send', req }
    const a = approvals.consume(token, n, now())
    if (!a.ok) return { ok: false as const, error: 'Confirm this payment with your PIN again', auth: true as const }
    const lc = await safeLimit(i)
    if (lc?.over && !a.override) return { ok: false as const, error: 'This is over your daily limit', auth: true as const }
    if (!secrets) return { ok: false as const, error: 'Wallet is locked' }
    if (ASSET[req.assetId]?.id === 'xmr') return NOT_HERE
    const acct = req.account!, addrs = addressesFor(acct)
    if (!addrs) return { ok: false as const, error: 'Unknown account' }
    let item: ActivityItem
    try {
      const q = await quote(req, addrs, keyFor(acct))
      const { txid, network } = await execute(req, addrs, keyFor(acct))
      item = { id: `${network}:${txid}`, kind: 'send', asset: req.assetId, network, amount: q.amount, fee: q.fee, feeAsset: q.feeAsset, to: req.to.trim(), txid, time: now(), status: 'pending', account: acct }
    } catch (e: any) { return { ok: false as const, error: String(e?.shortMessage ?? e?.message ?? 'Send failed').slice(0, 240) } }
    // it is on the network now: a failure to save the record must never read as "the payment failed" (a retry would pay twice)
    if (secrets) { secrets.activity = [item, ...(secrets.activity ?? [])].slice(0, 500); try { await persist(); host.emit('activity', secrets.activity) } catch { /* shown this session; the chain has the truth */ } }
    return { ok: true as const, item }
  }

  const H: Record<string, (...a: any[]) => unknown> = {
    // safeGraphics: the screens run in a sandboxed frame, where the sky is a still picture (no WebGL textures there)
    state: async (): Promise<AppState> => ({ hasVault: !!(await vaultFile()), unlocked: !!secrets, touchIdAvailable: false, touchIdEnabled: false, prefs, safeGraphics: { on: true, auto: false } }),
    /**
     * Step one of a guarded call. The engine decides, from what it was really asked and its own state, what the user
     * must be shown (`ask`) and which secrets the HOST PAGE must collect from the user itself (`need`): the wallet's
     * screens never hold a PIN, a password or a recovery phrase. The call is stored with everything already resolved
     * (which account pays, which currency a limit is in) under a one-time ticket. { refuse } means no.
     * `show` (a new wallet's words) goes to the host page only: the screens cannot call prepare.
     */
    prepare: async (name: string, args: unknown[]) => {
      if (!GATED.has(String(name))) return { refuse: 'Not a guarded call' }
      const a = Array.isArray(args) ? args : []
      let ask: { title: string; text: string; danger?: boolean; yes: string } | null = null, run: unknown[] = a, need: string[] = [], show: string[] | undefined
      const isPin = (x: unknown) => typeof x === 'string' && PIN_RE.test(x), isPw = (x: unknown) => typeof x === 'string' && x.length > 0
      if (name === 'createVault') {
        if (await vaultFile()) return { refuse: 'A wallet already exists in this browser' }
        const o = (a[0] ?? {}) as { mnemonic?: unknown; mode?: unknown; name?: unknown; birthday?: unknown; password?: unknown }
        if (o.mode === 'create') { const m = newMnemonic(); run = [{ name: o.name, mnemonic: m }]; show = m.split(' '); need = ['newPassword'] } // made here, shown by the host, never sent to the screens
        else if (o.mode === 'restore') { run = [{ birthday: o.birthday }]; need = ['mnemonic', 'newPassword'] }
        else if (typeof o.mnemonic === 'string' && isValidMnemonic(o.mnemonic)) {
          const w = normalise(o.mnemonic).split(' ')
          ask = { title: 'Make this wallet?', text: `Its recovery phrase starts with “${w[0]} ${w[1]}” and ends with “${w[w.length - 1]}”.\n\nCheck that against the words you wrote down or typed. If they differ, press Cancel.`, yes: 'They match' }
          if (!isPw(o.password)) need = ['newPassword']
        } // an invalid phrase is refused by createVault itself
      } else {
        if (!secrets) return { refuse: 'Wallet is locked' }
        if (name === 'verifyPin') {
          const i = a[1] as Intent
          if (i?.kind !== 'send') return { refuse: NOT_HERE.error }
          const n = normIntent(i, active()) // the paying account is fixed here, and it is what the question names
          if (n.kind !== 'send' || !ASSET[n.req.assetId]) return { refuse: 'Unknown coin' }
          run = [a[0], { kind: 'send', req: n.req }, !!a[2]]
          if (!isPin(a[0])) need = ['pin']
          ask = { title: 'Confirm this payment', text: intentSummary(n, { addresses: 'full', accountName: (x) => { const nm = secrets?.accounts.find((y) => y.index === x)?.name; return nm ? `“${plainName(nm)}”` : undefined } }, { overLimit: !!a[2] }), yes: 'Confirm' }
        } else if (name === 'revealMnemonic') { if (!isPw(a[0])) need = ['password']; ask = { title: 'Show your recovery phrase?', text: 'Anyone who sees these 24 words can take everything in this wallet. Continue only if you asked to see them.', danger: true, yes: 'Show it' } }
        else if (name === 'resetWallet') { if (!isPw(a[0])) need = ['password']; ask = { title: 'Remove this wallet from this browser?', text: 'The encrypted wallet is deleted here. Only your recovery phrase can bring it back.', danger: true, yes: 'Remove' } }
        else if (name === 'setPin') {
          const o = (a[0] ?? {}) as { pin?: unknown; password?: unknown }, has = !!secrets.pay?.pin
          run = [{ pin: o.pin, password: isPw(o.password) ? o.password : undefined }]
          if (has && !isPw(o.password)) need.push('password') // changing the PIN takes the wallet password; the first PIN, straight after making the wallet, does not
          if (!isPin(o.pin)) need.push('newPin')
          ask = has ? { title: 'Change your payment PIN?', text: 'The PIN approves every payment from this wallet.', yes: 'Change' } : null
        } else if (name === 'setLimit') {
          const o = (a[0] ?? {}) as { amount?: number | null; pin?: unknown }, cur = CUR_RE.test(prefs.currency) ? prefs.currency.toUpperCase() : 'GBP'
          run = [{ amount: o.amount ?? null, pin: o.pin, currency: cur }]
          if (!isPin(o.pin)) need = ['pin']
          ask = o.amount == null ? { title: 'Remove your daily limit?', text: 'Payments will no longer be capped per day.', danger: true, yes: 'Remove' } : { title: 'Change your daily limit?', text: `New limit: ${Number(o.amount)} ${cur} a day.`, yes: 'Change' }
        }
      }
      const t = now()
      for (const [k, v] of tickets) if (v.exp <= t) tickets.delete(k)
      if (tickets.size >= 50) return { refuse: 'Too many requests waiting. Close this window and try again.' }
      const ticket = randomBytes(24).toString('hex')
      tickets.set(ticket, { name, args: run, exp: t + TICKET_MS })
      return { ticket, ask, need, ...(show ? { show } : {}) }
    },
    /** The user said no (or closed the question): the stored call is thrown away. */
    discard: (ticket: string) => { if (typeof ticket === 'string') tickets.delete(ticket) },
    /** Step two: run exactly what prepare() stored, with the secrets the host page collected (`given`). One use; gone when the wallet locks. */
    confirmed: (ticket: string, given?: { pin?: string; newPin?: string; password?: string; newPassword?: string; mnemonic?: string }) => {
      const t = typeof ticket === 'string' ? tickets.get(ticket) : undefined
      if (typeof ticket === 'string') tickets.delete(ticket)
      if (!t || t.exp <= now()) throw new Error('That request expired. Try again.')
      const g = given && typeof given === 'object' ? given : {}, a = t.args as any[], o = (a[0] ?? {}) as Record<string, unknown>
      const args = t.name === 'verifyPin' ? [g.pin ?? a[0], a[1], a[2]]
        : t.name === 'setLimit' ? [{ ...o, pin: g.pin ?? o.pin }]
        : t.name === 'setPin' ? [{ pin: g.newPin ?? o.pin, password: g.password ?? o.password }]
        : t.name === 'createVault' ? [{ ...o, mnemonic: o.mnemonic ?? g.mnemonic, password: g.newPassword ?? o.password }]
        : [g.password ?? a[0]] // revealMnemonic, resetWallet
      return G[t.name](...args)
    },
    generateMnemonic: () => newMnemonic(),
    validateMnemonic: (m: string) => typeof m === 'string' && isValidMnemonic(m),
    createVault: ({ mnemonic, password, name, birthday }: { mnemonic: string; password: string; name?: string; birthday?: number }) => vaultQueue(async () => {
      if (typeof mnemonic !== 'string' || !isValidMnemonic(mnemonic)) throw new Error('INVALID_MNEMONIC')
      if (typeof password !== 'string' || password.length < 8) throw new Error('WEAK_PASSWORD')
      if (await vaultFile()) throw new Error('VAULT_EXISTS') // never written over: remove the wallet first (resetWallet), which asks for the password
      const first = (typeof name === 'string' && plainName(name)) || 'Wallet'
      const s: VaultSecrets = { mnemonic: normalise(mnemonic), createdAt: now(), birthday: typeof birthday === 'number' && birthday > 0 ? Math.min(birthday, now()) : undefined, accounts: [{ index: 0, name: first }] } as VaultSecrets
      const sk = await sealKeyFor(password)
      if (await vaultFile()) throw new Error('VAULT_EXISTS') // checked again right before the write
      await host.local.set('vault', sealWith(s, sk))
      prefs = { ...prefs, activeAccount: 0 }; await savePrefs()
      await opened(s, sk)
    }),
    unlock: (pw: string) => vaultQueue(async () => {
      const file = await vaultFile()
      if (!file || typeof pw !== 'string') return false
      if (now() < pwNext) return false // too soon after wrong passwords: not even checked
      try {
        const sk = await sealKeyFor(pw, file)
        const s = openWith(file, sk)
        if ((s.pay?.fails ?? 0) >= 10) { s.pay = { ...s.pay, fails: 0, lockUntil: undefined } } // the full password clears a PIN lockout
        await opened(s, sk); await persist()
        pwFails = 0; pwNext = 0
        return true
      } catch { pwFails++; if (pwFails >= 3) pwNext = now() + Math.min(60_000, 1000 * 2 ** (pwFails - 3)); return false } // 1 s, 2 s, 4 s … up to a minute
    }),
    lock: () => lock(),
    accounts: () => accounts,
    renameAccount: async (index: number, name: string) => {
      const a = secrets?.accounts.find((x) => x.index === index)
      if (!a || typeof name !== 'string' || !name.trim()) return
      const clean = plainName(name); if (!clean) return
      a.name = clean; await persist(); build(); host.emit('accounts', accounts)
    },
    cachedBalances: (index: number) => secrets?.balanceCache?.[index] ?? [],
    balances: async (index: number): Promise<Balance[]> => {
      const addrs = addressesFor(index)
      if (!addrs) return []
      const mine = (b: Balance) => ASSET[b.asset]?.id !== 'xmr' && ASSET[b.asset]?.network !== 'monero'
      const all = (await getAllBalances(addrs, (b) => { if (mine(b)) host.emit('balance', { account: index, balance: b }) })).filter(mine)
      if (secrets && all.some((b) => b.status === 'ok')) { secrets.balanceCache = { ...secrets.balanceCache, [index]: all }; await persist() }
      return all
    },
    prices: async (c: string) => {
      if (!CUR_RE.test(String(c))) return null
      const p = await getPrices(c).catch(() => null)
      if (p) { priceMem[c] = p; if (c === prefs.currency) await host.local.set('prices', { cur: c, map: p }) } // only your own currency is kept on disk
      return p ?? priceMem[c] ?? (await diskPrices(c))
    },
    cachedPrices: async (c: string) => (CUR_RE.test(String(c)) ? priceMem[c] ?? (await diskPrices(c)) : null),
    history: (cg: string, c: string, days: number) => (/^[a-z0-9-]{1,60}$/.test(String(cg)) && CUR_RE.test(String(c)) && Number(days) > 0 && Number(days) <= 3650 ? getHistory(cg, c, Number(days)) : []),
    validateAddress: (assetId: string, to: string) => validateAddress(assetId, to),
    quote: async (req: SendRequest) => {
      const acct = req?.account ?? active(), addrs = addressesFor(acct)
      if (!addrs || !secrets) return { ok: false, error: 'Locked', amount: 0, fee: 0, feeAsset: '', maxAmount: 0, eta: '', notes: [] }
      return quote(req, addrs, keyFor(acct))
    },
    payStatus: async () => {
      if (!secrets) return { pinSet: false }
      const lim = secrets.pay?.limit
      const spent = lim ? spent24h(secrets.activity ?? [], await fiatPrice(lim.currency), now()) : undefined
      const lockedUntil = pinBlocked({ fails: secrets.pay?.fails ?? 0, lockUntil: secrets.pay?.lockUntil }, now()) ? secrets.pay?.lockUntil : undefined
      return { pinSet: !!secrets.pay?.pin, lockedUntil, limit: lim, spent, confirmNative: false, drainGuard: true }
    },
    payCheck: async (i: Intent) => {
      if (!secrets) return { pinSet: false }
      const lc = await safeLimit(i)
      const lockedUntil = pinBlocked({ fails: secrets.pay?.fails ?? 0, lockUntil: secrets.pay?.lockUntil }, now()) ? secrets.pay?.lockUntil : undefined
      return { pinSet: !!secrets.pay?.pin, lockedUntil, overLimit: lc?.over ? { limit: lc.limit, spent: lc.spent, amount: lc.amount, currency: lc.currency } : undefined }
    },
    setPin: async ({ pin, password }: { pin: string; password?: string }) => {
      if (!secrets) return { ok: false, error: 'Wallet is locked' }
      if (typeof pin !== 'string' || !PIN_RE.test(pin)) return { ok: false, error: 'Use exactly 6 digits' }
      if (/^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return { ok: false, error: 'Too easy to guess. Avoid repeats and runs like 123456.' }
      if (secrets.pay?.pin || password !== undefined) { // changing the PIN takes the full password; the first PIN does not
        const file = await vaultFile()
        try { await open(file!, String(password)) } catch { return { ok: false, error: 'Wrong password' } }
      }
      await savePay({ pin: await hashPin(pin), fails: 0, lockUntil: undefined })
      return { ok: true }
    },
    verifyPin: async (pin: string, i: Intent, override?: boolean) => {
      if (i?.kind !== 'send') return NOT_HERE
      const r = await tryPin(pin)
      if (!r.ok) return r
      const lc = await safeLimit(i)
      if (lc?.over && !override) return { ok: false, error: 'This is over your daily limit', overLimit: { limit: lc.limit, spent: lc.spent, amount: lc.amount, currency: lc.currency } }
      return { ok: true, token: approvals.issue(normIntent(i, active()), now(), !!(lc?.over && override)) }
    },
    setLimit: async ({ amount, pin, currency }: { amount: number | null; pin: string; currency: string }) => {
      const r = await tryPin(pin)
      if (!r.ok) return r
      if (amount != null && !(Number(amount) > 0 && Number(amount) < 1e12)) return { ok: false, error: 'Enter an amount above zero' }
      await savePay({ limit: amount == null ? undefined : { amount: Number(amount), currency } })
      return { ok: true }
    },
    send: (req: SendRequest, token?: string) => { const run = busy.then(() => sendNow(req, token)); busy = run.catch(() => {}); return run },
    activity: () => secrets?.activity ?? [],
    getData: (key: string) => (secrets && Object.hasOwn(DATA_KEYS, key) ? ((secrets as any)[key] ?? []) : []),
    setData: async (key: string, value: unknown[]) => {
      if (!secrets || !Object.hasOwn(DATA_KEYS, key) || !Array.isArray(value) || value.length > DATA_KEYS[key] || JSON.stringify(value).length > 200_000) return false
      ;(secrets as any)[key] = value; await persist(); return true
    },
    setPrefs: async (p: Partial<Prefs>) => {
      const take: Record<string, unknown> = {}
      for (const k of PREF_KEYS) if (p && Object.hasOwn(p, k)) take[k] = (p as any)[k]
      if ('currency' in take && !(typeof take.currency === 'string' && CUR_RE.test(take.currency))) delete take.currency
      if ('activeAccount' in take && !accounts.some((x) => x.index === take.activeAccount)) delete take.activeAccount
      if ('autoLockMin' in take && !(Number(take.autoLockMin) >= 0 && Number(take.autoLockMin) <= 1440)) delete take.autoLockMin
      const next = { ...prefs, ...take } as Prefs
      if (JSON.stringify(next).length > 20_000) return prefs // settings are small; anything larger is not a setting
      await host.local.set('prefs', next)
      prefs = next; host.emit('prefs', prefs)
      return prefs
    },
    revealMnemonic: async (pw: string) => { const file = await vaultFile(); if (!file) return null; try { return (await open(file, String(pw))).mnemonic } catch { return null } },
    resetWallet: (pw: string) => vaultQueue(async () => {
      const file = await vaultFile()
      if (file) { try { await open(file, String(pw)) } catch { return false } }
      await lock(); await host.local.remove('vault')
      return true
    })
  }

  // the guarded calls leave the open table: from here on they run only through confirmed()
  const G: Record<string, (...a: any[]) => unknown> = {}
  for (const k of GATED) { G[k] = H[k]; delete H[k] }

  /** The only way in. Unknown names are refused; names this wallet has no feature for answer "nothing". */
  async function call(name: string, args: unknown[] = []): Promise<unknown> {
    await ready()
    await idleCheck()
    if (GATED.has(name)) throw new Error('This needs your confirmation in Astrala')
    if (Object.hasOwn(H, name)) return H[name](...args)
    if (Object.hasOwn(NEUTRAL, name)) return NEUTRAL[name]()
    return NOT_HERE
  }
  return { call, supports: (name: string) => Object.hasOwn(H, name) }
}
