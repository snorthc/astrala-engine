import { setPresence, line } from './discord'
import { hangDuring } from './safe-graphics'
import { startBridge, stopBridge, bridgePort, RpcError, type BridgeHost, type Ask } from './bridge'
import { parseDappRequest, describeDapp, planDappTx, signDappMessage, signDappTyped, sendDappTx, drainBlock, lookalikeSite, hostOf, DappError, type DappRequest, type DappView } from '../core/dapp'
import { evmClient } from '../core/send'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, ipcMain, shell, systemPreferences, safeStorage, clipboard, powerMonitor, session, Notification, dialog } from 'electron'
import { splitPhrase, joinShares, validShare } from '../core/shares'
import { join } from 'node:path'
import { readFile, writeFile, rm, mkdir, readdir, appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { queuedWriter } from '../core/atomic'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { clearSeedCache, deriveAccount, isValidMnemonic, newMnemonic, normalise, signingKey as seedKey, moneroKeysFromSpend, type DerivedAddress } from '../core/derive'
import { ledgerStatus, ledgerRead, ledgerSigner, ledgerPath, type LedgerChain } from './ledger'
import { trezorStatus, trezorRead, trezorSigner, trezorPath } from './trezor'
import { p2wpkh } from '@scure/btc-signer'
import { startPhone, stopPhone, phoneRunning, lanAddresses, localName, PHONE_PORT } from './phone'
import type { HwAccount } from '../core/vault'
import { seal, open, sealKeyFor, sealWith, openWith, hashPin, checkPin, type SealKey, type VaultSecrets, type VaultFile, type ActivityItem } from '../core/vault'
import { Approvals, PIN_RE, onPinFail, pinBlocked, spent24h, isOverLimit } from '../core/paysafe'
import { startShotWatch, stopShotWatch } from './screenshots'
import { getAllBalances, getBalance, getPrices, getHistory, txStatus, net, type Addresses, type Balance, type PriceInfo } from '../core/chain'
import { quote, execute, validateAddress, setXmrBackend, type SendRequest } from '../core/send'
import { MoneroService, DEFAULT_NODES } from '../core/monero'
import { parseRestoreHeight, maxRestoreHeight } from '../core/xmr-height'
import { setDuressPath, duressEnabled, duressAvailable, openDuress, writeDuress, removeDuress, newVaultPhrase, vaultAddresses, ensureDecoy, sweep } from './duress'
import { initTray, setTraySummary, destroyTray, type TraySummary } from './tray'
import { stakeAccounts, validators as solValidators, stake as solStake, unstake as solUnstake, withdrawStake } from '../core/stake'
import { initRoute, applyRoute, routeStatus, torCheck, stopTor, mullvadCheck, torSupported } from './route'
import { mullvadStatus, mullvadRelays, mullvadConnect, mullvadDisconnect, mullvadSetLocation, waitFor } from './mullvad'
import { swapQuote, swapExecute, crossChainStatus, collectFee, moveTo, roughFee, PROVIDER_NAME, type SwapRequest, type Provider } from '../core/swap'
import { normIntent as normIntentFor, intentSummary, stakeSummary, touchReason, vaultLine, sameAddress, type Intent, type LegPick, type NormIntent, type SummaryCtx } from '../core/intent-summary'
import { splitQuote, checkSplit, splitAmounts, legAmount, type SplitRequest, type SplitRecord } from '../core/split'
import { routeQuote as coreRouteQuote, checkRoute, routeFeeBps, type RouteRequest, type RouteRecord } from '../core/route'
import { FEES, takeFee, applyRemoteFees } from '../core/fees'
import { bumpFee, cancelTx, cancelEvm } from '../core/send'
import { scanApprovals, revokeApproval, spenderName, type RevokeRequest } from '../core/approvals'
import { checkUpdate, downloadUpdate, installUpdate } from './updates'
import { accountType, isAccountType } from '../core/account-types'
import { parseUnits } from 'viem'
import { unlink } from 'node:fs/promises'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { getTxHistory, tidy, type HistoryItem } from '../core/history'
import { pingChains, type NetHealth } from '../core/health'
import { InboundRadar } from '../core/inbound'
import { networkOf, NETWORKS, ASSET, ASSETS, registerTokens, tokenId, type CustomToken } from '../core/assets'
import { searchTokens, readToken, fetchLogo, type TokenHit } from '../core/tokens'
import { randomAccountName } from '../core/names'
import { DEFAULT_PREFS, type Prefs, type AppState, type Account } from '../shared/api'
import { beat as hqBeat, fetchLive as hqFetchLive, hqEnabled, type LiveConfig } from '../core/heartbeat'


const dir = () => app.getPath('userData')
// what the computer is called in messages from main
const DEVICE = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'PC' : 'computer'

// One Astrala per user: a second launch (Start menu, .desktop file, AppImage) brings the running window forward
// instead of starting another copy against the same vault. macOS does this by itself; this covers Windows and Linux.
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) createWindow()
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
})
const P = {
  vault: () => join(dir(), 'vault.json'),
  prefs: () => join(dir(), 'prefs.json'),
  touch: () => join(dir(), 'touchid.bin'),
  xmr: (acct: number) => join(dir(), `xmr-${acct}.bin`),
  xmrDecoy: (acct: number) => join(dir(), `xmr-d${acct}.bin`),
  duress: () => join(dir(), 'duress.bin'),
  pinLock: () => join(dir(), 'pinlock') // marker: 10 wrong PINs, Touch ID won't unlock until the password is typed
}

// ---------- Safe graphics ----------
// On an Intel Mac the display server (WindowServer) has hung with Astrala running: macOS logs a watchdog report and
// restarts it, which logs you out. Safe graphics stops Astrala using the GPU at all, so its sky can't be involved:
// the sky becomes a still gradient and the window is drawn in software. On when the setting says so, or by itself
// when one of those reports was written while Astrala last ran (a heartbeat file says when that was).
const RUN_FILE = join(dir(), 'run.json')
const lastRun = (() => { try { return JSON.parse(readFileSync(RUN_FILE, 'utf8')) } catch { return null } })()
const bootPrefs: Partial<Prefs> = (() => { try { return JSON.parse(readFileSync(P.prefs(), 'utf8')) } catch { return {} } })()
const hangLastRun = process.platform === 'darwin' && bootPrefs.safeGraphics === undefined && hangDuring(lastRun, (() => {
  const D = '/Library/Logs/DiagnosticReports'
  try { return readdirSync(D).filter((f) => f.startsWith('WindowServer')).map((f) => ({ name: f, mtimeMs: statSync(join(D, f)).mtimeMs })) } catch { return [] }
})())
const safeGraphics = { on: bootPrefs.safeGraphics === true || hangLastRun, auto: hangLastRun }
if (safeGraphics.on) app.disableHardwareAcceleration()
// the heartbeat: when this run started, and the last minute it was known to be alive
const runStart = Date.now()
const beat = () => { try { writeFileSync(RUN_FILE, JSON.stringify({ start: runStart, alive: Date.now() })) } catch { /* not fatal */ } }
setInterval(beat, 60_000).unref()

// Smoothness: make sure Chromium uses the GPU even on Macs whose GPU is on its conservative blocklist,
// and rasterise on the GPU so glass blur and the starfield don't fall back to slow software paths.
// The browser engine's own background chatter (component updates, reporting, pings) is switched off: the only
// traffic this app makes is the wallet's, on the routed session.
for (const sw of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'no-pings', 'disable-sync'])
  app.commandLine.appendSwitch(sw)
// No GPU overrides. ignore-gpu-blocklist / enable-zero-copy / enable-gpu-rasterization used to be forced here; they
// switch off Chromium's driver safety list, and on an Intel Iris Mac (MacBookPro16,2) the display server froze and
// restarted four times with Astrala running (WindowServer watchdog: "Display not ready"). Chromium's own defaults
// pick the fast paths the driver can actually take.

// No telemetry, no crash reporter, nothing phones home.
let win: BrowserWindow | null = null
let secrets: VaultSecrets | null = null
let sealKey: SealKey | null = null // Argon2-derived key held only while unlocked, so saves are instant
let accountsCache: Account[] = []
let prefs: Prefs = { ...DEFAULT_PREFS }
// Duress mode: an empty decoy wallet is open; the real one is being swept to the Vault in the background.
let decoyPin: string | null = null
const histCache = new Map<number, { at: number; items: HistoryItem[]; p?: Promise<HistoryItem[]> }>()
let clipTimer: NodeJS.Timeout | null = null
// single-use, 2-minute approvals issued by verifyPin; send/swap refuse anything without a matching one
const approvals = new Approvals()
// payments run one at a time: the limit is checked and the payment booked before the next one starts
let payQueue: Promise<unknown> = Promise.resolve()
const oneAtATime = <T,>(fn: () => Promise<T>): Promise<T> => { const r = payQueue.then(fn); payQueue = r.catch(() => {}); return r }

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}
const writeAtomic = queuedWriter()
// snapshot now; writes land in call order, so the newest state is written last
const writeJson = (p: string, v: unknown) => writeAtomic(p, JSON.stringify(v))

/** A default name no account in this wallet already has. */
function freshName() { return randomAccountName(secrets?.accounts.map((x) => x.name) ?? []) }
const defaultAvatar = (i: number) => ({ kind: 'orb' as const, hue: (262 + i * 67) % 360, hue2: (195 + i * 89) % 360 })

function buildAccounts() {
  registerTokens(secrets?.tokens ?? []) // the wallet's own added coins, never another wallet's
  if (!secrets) return (accountsCache = [])
  // a route's staging wallets live in that route's own panel, never in the account switcher
  accountsCache = secrets.accounts.filter((a) => !a.hidden && !a.route).map((a) => ({ index: a.index, name: a.name, avatar: a.avatar ?? defaultAvatar(a.index), type: accountType(a.type), addresses: a.hw ? hwAddresses(a.hw) : deriveAccount(secrets!.mnemonic, a.index), ...(a.hw ? { hw: a.hw.vendor } : {}), ...(a.xmrRestoreHeight != null ? { xmrRestoreHeight: a.xmrRestoreHeight } : {}) }))
}

/** A hardware account's addresses: only the chains read from the device (nothing comes from your 24 words). */
function hwAddresses(hw: HwAccount): DerivedAddress[] {
  const out: DerivedAddress[] = []
  const at = (c: LedgerChain) => (hw.vendor === 'trezor' ? trezorPath(c, hw.account) : `m/${ledgerPath(c, hw.account)}`)
  if (hw.evm) out.push({ chain: 'evm', address: hw.evm, path: at('evm') })
  if (hw.btc) out.push({ chain: 'btc', address: hw.btc.address, path: at('btc') })
  if (hw.sol) out.push({ chain: 'sol', address: hw.sol, path: at('sol') })
  return out
}
const hwOf = (acct: number) => secrets?.accounts.find((a) => a.index === acct)?.hw
/** Flows not built for a device refuse a hardware account up front, before anything moves (a split or route would
 *  otherwise start sending from it and stall half-way at the first leg that needs a key held here). */
const hwRefusal = (acct: number, what: string) => { const hw = hwOf(acct); return hw ? { ok: false as const, error: `${what} from a ${hw.vendor === 'trezor' ? 'Trezor' : 'Ledger'} account isn't available yet. Send and receive are.` } : null }

/**
 * The signing key for an account. A hardware account's keys are on its device (Ledger or Trezor): it gets the device's signers, and a
 * `priv` that refuses to exist, so only flows built for the device (plain sends) can sign. Swaps, splits, routes,
 * staking, fee bumps and websites fail with this message instead of ever deriving a key from your 24 words.
 */
function signingKey(m: string, family: Parameters<typeof seedKey>[1], acct = 0): ReturnType<typeof seedKey> & { hw?: import('../core/send').HwSigner } {
  const hw = hwOf(acct)
  if (!hw) return seedKey(m, family, acct)
  const pub = family === 'btc' && hw.btc ? Buffer.from(hw.btc.pubkey, 'hex') : new Uint8Array(0)
  const hwOnly = () => { throw new Error(`This is a ${hw.vendor === 'trezor' ? 'Trezor' : 'Ledger'} account. For now Astrala can send and receive with it; swaps, splits, routes, staking and website signing are coming`) }
  return { pub: new Uint8Array(pub), hw: hw.vendor === 'trezor' ? trezorSigner(hw) : ledgerSigner(hw), get priv(): Uint8Array { return hwOnly() } }
}

/** The account every screen is showing: the saved one if it's still a visible account, otherwise the first visible one.
 *  Main and the interface must agree on this, or Monero (and anything defaulting to it) works on an account nobody sees. */
function activeAcct(): number {
  const a = prefs.activeAccount
  return accountsCache.some((x) => x.index === a) ? a! : accountsCache[0]?.index ?? 0
}

/** A new or restored wallet starts on its first account: a setting left over from a previous wallet would point
 *  Monero (and its receive address) at an account the user never chose. */
async function freshAccount(tour = false) {
  // a newly created or restored wallet gets the short tour on its first unlock into the app (once per install)
  prefs = { ...prefs, activeAccount: 0, ...(tour && prefs.tour !== 'done' ? { tour: 'pending' as const } : {}) }
  await writeJson(P.prefs(), { ...prefs, v: 2 })
}

function addressesFor(index: number): Addresses | null {
  const acct = accountsCache.find((a) => a.index === index)
  if (!acct) return null
  return Object.fromEntries(acct.addresses.map((a) => [a.chain, a.address]))
}

/** Like addressesFor, but also for a route's one-time wallets, which the account switcher leaves out. */
function addressesForAny(index: number): Addresses | null {
  const shown = addressesFor(index)
  if (shown) return shown
  const a = secrets?.accounts.find((x) => x.index === index)
  if (!a || a.hw || !secrets) return null
  return Object.fromEntries(deriveAccount(secrets.mnemonic, index).map((x) => [x.chain, x.address]))
}

async function persist() {
  if (secrets && sealKey) await writeJson(P.vault(), sealWith(secrets, sealKey))
}

/**
 * Your 24 words hold every account, but only the vault remembers which ones you opened.
 * After a restore, walk the account numbers past the last known one and bring back any
 * with on-chain history, stopping after GAP empty ones in a row (a failed Split leg can
 * leave a gap). Monero isn't checked here: its history needs a full wallet scan.
 */
const GAP = 5
let scanning: Promise<ScanResult> | null = null
type ScanResult = { ok: boolean; found: number; error?: string }
function discoverAccounts(): Promise<ScanResult> {
  return (scanning ??= (async (): Promise<ScanResult> => {
    if (!secrets) return { ok: false, found: 0, error: 'Locked' }
    const words = secrets.mnemonic
    let index = Math.max(...secrets.accounts.map((a) => a.index)) + 1, empty = 0, found = 0
    toWin('accountScan', { scanning: true, checked: 0, found: 0 })
    try {
      while (empty < GAP) {
        let sources = 0, failed = 0
        const items = await getTxHistory(Object.fromEntries(deriveAccount(words, index).map((d) => [d.chain, d.address])), (_n, r) => { sources++; if (r instanceof Error) failed++ })
        if (secrets?.mnemonic !== words) return { ok: false, found, error: 'Locked' }
        // every network failed: we can't tell empty from unreachable, so don't pretend it's empty
        if (sources && failed === sources) return { ok: false, found, error: "Couldn't reach the networks. Check your route and try again." }
        if (items.length && !secrets.accounts.some((a) => a.index === index)) {
          secrets.accounts.push({ index, name: freshName(), avatar: defaultAvatar(index) })
          found++; empty = 0
          await persist(); buildAccounts(); toWin('accounts', accountsCache)
        } else empty++
        toWin('accountScan', { scanning: true, checked: index, found })
        index++
      }
      return { ok: true, found }
    } finally {
      toWin('accountScan', { scanning: false, checked: index, found })
      scanning = null
    }
  })())
}

function pushActivity() {
  toWin('activity', secrets?.activity ?? [])
}

// Live tracker: poll every pending transaction until it confirms or fails.
setInterval(async () => {
  const live = (a: ActivityItem) => Date.now() - a.time < 3 * 86400_000 && (a.status === 'pending' || (a.kind === 'swap' && a.status === 'confirmed' && !['done', 'refunded'].includes(a.swap?.stage ?? '') && ['thorchain', 'maya', 'lifi', 'wagyu'].includes(a.swap?.provider ?? '')))
  const pending = secrets?.activity?.filter(live) ?? []
  if (!pending.length) return
  let changed = false
  for (const item of pending) {
    if (item.kind === 'swap' && item.swap && ['thorchain', 'maya', 'lifi', 'wagyu'].includes(item.swap.provider)) {
      const stage = await crossChainStatus(item.swap.provider as Provider, item.txid, item.swap.ref)
      if (stage !== 'unknown' && stage !== item.swap.stage) { item.swap.stage = stage; changed = true }
      if (item.status !== 'pending') continue
    }
    const st = item.network === 'monero'
      ? ((await monero.transfers().catch(() => [])).find((t) => t.txid === item.txid)?.confirmations ?? 0) > 0 ? 'confirmed' : 'pending'
      : await txStatus(item.network, item.txid)
    if (st !== 'pending' && secrets) { item.status = st; changed = true }
    if (item.cancel && !item.cancel.outcome && secrets) {
      if (st === 'confirmed') { item.cancel.outcome = 'done'; changed = true }
      // the cancel lost the race: the original confirmed first, so the payment went through as normal
      else if (st === 'pending') {
        const o = await txStatus(item.network, item.cancel.of)
        if (o !== 'pending') { item.txid = item.cancel.of; item.status = o; item.cancel.outcome = 'late'; changed = true }
      }
    }
  }
  if (changed) { await persist(); pushActivity() }
}, 12_000)

// ---------- Monero: one live wallet for the active account ----------
const monero = new MoneroService(
  (changed) => toWin('xmr', { ...monero.status, changed: !!changed }),
  async ({ keys, cache, restoreHeight }) => {
    if (!secrets) return
    const key = Buffer.from(secrets.xmrKey!, 'hex')
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update(JSON.stringify({ k: Buffer.from(keys).toString('base64'), c: Buffer.from(cache).toString('base64'), h: restoreHeight })), c.final()])
    await writeFile(decoyPin ? P.xmrDecoy(xmrAccount) : P.xmr(xmrAccount), Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 })
  }
)
let xmrAccount = 0
const radars = new Map<number, InboundRadar>()
let lastHeld = ''
const histHealth = new Map<number, { failed: string[]; at: number }>()
/** diagnostics for the Mac run log (only with ASTRALA_PERF=1) */
const diag = (...a: unknown[]) => { if (process.env.ASTRALA_PERF) console.log(...a) }
/** A restore height from the window: a whole block between 0 and the chain tip, or null for the wallet's default. */
function checkRestoreHeight(v: unknown): number | null {
  if (v == null) return null
  const r = parseRestoreHeight(typeof v === 'number' || typeof v === 'string' ? v : 'x', maxRestoreHeight(monero.status.daemonHeight))
  if (!r.ok) throw new Error(r.error)
  return r.height
}
/** This account's saved Monero wallet (keys + scan cache), decrypted, or null if there is none yet. */
async function readXmrCache(acct: number): Promise<{ keys: Uint8Array; cache: Uint8Array; restoreHeight: number } | null> {
  if (!secrets?.xmrKey) return null
  try {
    const raw = await readFile(decoyPin ? P.xmrDecoy(acct) : P.xmr(acct))
    const d = createDecipheriv('aes-256-gcm', Buffer.from(secrets.xmrKey, 'hex'), raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    const j = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString())
    return { keys: new Uint8Array(Buffer.from(j.k, 'base64')), cache: new Uint8Array(Buffer.from(j.c, 'base64')), restoreHeight: j.h }
  } catch { return null }
}

/** Fills in every other account's Monero from its saved wallet file, so no account's coins look missing. Offline. */
async function peekOtherXmr() {
  const S = secrets
  for (const a of accountsCache) {
    if (secrets !== S || !S || a.index === xmrAccount) continue
    const c = await readXmrCache(a.index)
    const address = a.addresses.find((d) => d.chain === 'xmr')?.address
    if (!c || !address) continue
    const bal = await MoneroService.savedBalance(c, address)
    if (bal != null && secrets === S && S.xmrLast?.[a.index] !== bal) { S.xmrLast = { ...S.xmrLast, [a.index]: bal }; await persist() }
  }
}

async function startMonero(acct: number) {
  if (!secrets) return
  if (hwOf(acct)) { void monero.stop(); xmrAccount = acct; return } // a hardware account has no Monero
  if (!secrets.xmrKey) { secrets.xmrKey = randomBytes(32).toString('hex'); await persist() }
  xmrAccount = acct
  diag(`[xmr] account ${acct}`)
  monero.nodes = prefs.xmrNode ? [prefs.xmrNode.replace(/\/+$/, '')] : [...DEFAULT_NODES]
  const spend = signingKey(secrets.mnemonic, 'xmr', acct).priv
  const k = moneroKeysFromSpend(spend)
  const cached = await readXmrCache(acct) // null on the first run for this account: scan from its restore height
  const restoreHeight = secrets.accounts.find((a) => a.index === acct)?.xmrRestoreHeight
  monero.open({ address: k.address, viewSec: k.viewSec, spendSec: k.spendSec, birthday: secrets.birthday ?? secrets.createdAt, restoreHeight }, cached).catch(() => {})
}
// Monero runs one account at a time; never quote or spend from it unless it's the account on screen
const xmrSameAccount = () => { if (xmrAccount !== activeAcct()) throw new Error('Monero is still switching to this account. Try again in a moment') }
setXmrBackend({
  quote: (to, amount, speed, max) => { xmrSameAccount(); return monero.quote(to, amount, speed, max) },
  send: (to, amount, speed, max) => { xmrSameAccount(); return monero.send(to, amount, speed, max) },
  unlocked: async () => (await monero.balance())?.unlocked ?? null
})

// Messages to the window are dropped once it's closed (Astrala keeps running in the menu bar); sending to a
// destroyed window threw "Object has been destroyed" when the Mac locked or slept with the window closed.
const toWin = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  if (!(prefs.bridge && prefs.bridgePair) && !(prefs.phone && prefs.phonePair)) return // nobody to tell
  tunnelLog.push({ seq: ++tunnelSeq, channel, args })
  if (tunnelLog.length > 400) tunnelLog.splice(0, tunnelLog.length - 400)
  for (const wake of [...tunnelWaiting]) wake()
}
// ---------- the wallet screens running in the paired browser extension ----------
// They are the same screens as this window's, making the same calls. Main already treats its screens as untrusted
// (every payment needs the PIN and main's own confirmation), so the extension gets exactly that and no more, minus
// the calls below, which stay in the app: anything that shows or takes the recovery phrase, makes or removes a
// wallet, changes the duress setup, or replaces the app itself. Desktop-only chores (tray, Dock badge) are ignored.
const ipcHandlers = new Map<string, (...a: any[]) => any>()
const APP_ONLY = new Set(['hwAdd', 'hwVerify', 'phoneInfo', 'phoneForget', 'generateMnemonic', 'createVault', 'revealMnemonic', 'resetWallet', 'exportBackup', 'pickBackup', 'restoreBackup', 'splitShares', 'joinShares',
  'duressNewVault', 'duressSetup', 'duressDisable', 'duressStatus', 'enableTouchId', 'disableTouchId', 'mullvadControl', 'paste', 'copy', 'stakeAction', 'relaunch', 'bridgeAnswer', 'bridgeForget', 'dappAnswer', 'setPin', 'setLimit', 'downloadUpdate', 'installUpdate', 'windowControl', 'traySummary', 'setBadge', 'notifyOs', 'discordPresence'])
/** Settings the extension may not change: where traffic goes, what protects the screen, and the extension's own access. */
const TUNNEL_PREFS_BLOCKED = ['route', 'xmrNode', 'screenProtect', 'bridge', 'bridgePair', 'phone', 'phonePair', 'discord', 'autoLockMin', 'clipboardClearSec', 'blurOnFocusLoss', 'stealthOnUnlock', 'notifications']
/** Unlock attempts from the extension: a run of wrong passwords there waits before the next try. */
let tunnelUnlockFails = 0, tunnelUnlockAt = 0
const tunnelLog: { seq: number; channel: string; args: unknown[] }[] = []
let tunnelSeq = 0
const tunnelWaiting = new Set<() => void>()

// split legs that finished signing after the wallet locked, merged back in on the next unlock
const orphans: { split: string; leg: number; item: ActivityItem }[] = []
/** A split interrupted by a lock: put back what was sent, mark the rest as stopped (they never left the wallet). */
/** A route still marked running when the wallet opens was cut off (lock, quit, crash). Its next step waits for the
 *  user to press Resume, which first checks the coins really reached that stop. A first step caught mid-send is
 *  marked failed instead: it spends from the user's own account, so re-running it could pay twice. */
function settleInterruptedRoutes(): boolean {
  let changed = false
  for (const r of secrets?.routes ?? []) {
    if (r.status !== 'running') continue
    const at = r.hops.findIndex((h) => h.status !== 'sent')
    changed = true
    if (at < 0) { r.status = 'done'; continue }
    const h = r.hops[at]
    if (at === 0 && h.status === 'sending') { h.status = 'failed'; h.error = 'Interrupted while sending. Check Activity before trying again'; r.status = 'failed'; continue }
    h.status = 'waiting'; h.error = 'Paused when Astrala closed. Press Resume to carry on'
    r.status = 'paused'; r.pausedAt = at
  }
  return changed
}

function reconcileSplits(): boolean {
  let changed = false
  for (const rec of secrets?.splits ?? []) {
    for (const o of orphans.filter((x) => x.split === rec.id)) {
      rec.legs[o.leg] = { ...rec.legs[o.leg], status: 'sent', activityId: o.item.id, error: undefined }
      secrets!.activity = [o.item, ...(secrets!.activity ?? [])].slice(0, 500)
      changed = true
    }
    if (rec.status !== 'running') continue
    for (const l of rec.legs) {
      if (l.status === 'waiting') { l.status = 'failed'; l.error = 'Stopped when Astrala locked. Nothing was sent for this coin.' }
      if (l.status === 'sending') { l.status = 'failed'; l.error = 'Astrala locked while this was signing. Check Activity before trying again.' }
    }
    const sent = rec.legs.filter((l) => l.status === 'sent').length
    rec.status = sent === rec.legs.length ? 'done' : sent ? 'partial' : 'failed'
    rec.feeError = rec.feeError ?? 'Not charged: the split was interrupted'
    rec.fee = 0
    changed = true
  }
  orphans.length = 0
  return changed
}

// Idle auto-lock lives here, not in a window: using the wallet from the extension counts as using it, and the wallet
// still locks on time with the window closed.
let lastUse = Date.now(), wasOpen = false
setInterval(() => {
  if (!secrets) { wasOpen = false; return }
  if (!wasOpen) { wasOpen = true; lastUse = Math.max(lastUse, Date.now() - 15_000) } // just unlocked, created or restored: the clock starts now
  if (prefs.autoLockMin > 0 && Date.now() - lastUse > prefs.autoLockMin * 60_000) lock()
}, 15_000).unref?.()

function lock() {
  tunnelLog.length = 0 // nothing from this session may reach the extension after it ends (duress included)
  void setPresence('', null) // a locked wallet says nothing on Discord
  for (const answer of [...bridgeAsks.values()]) answer(false) // and any question from the extension is a no
  for (const id of [...dappPending.keys()]) dropDapp(id, new RpcError(4001, 'Astrala was locked before you answered'))
  approvals.clear()
  if (process.platform === 'darwin') app.dock?.setBadge('')
  setTraySummary({ locked: true, stealth: false, total: '', lines: [] })
  monero.stop()
  decoyPin = null
  histCache.clear()
  histHealth.clear()
  radars.clear()
  secrets = null
  registerTokens([])
  sealKey?.key.fill(0)
  sealKey = null
  clearSeedCache()
  accountsCache = []
  toWin('locked')
}

async function unlockWith(pw: string): Promise<boolean> {
  const file = await readJson<VaultFile>(P.vault())
  if (!file) return false
  try {
    const sk = await sealKeyFor(pw, file)
    secrets = openWith(file, sk)
    lastUse = Date.now()
    sealKey = sk
    if (existsSync(P.pinLock())) { await unlink(P.pinLock()).catch(() => {}); if ((secrets.pay?.fails ?? 0) > 0 || secrets.pay?.lockUntil) { secrets.pay = { ...secrets.pay, fails: 0, lockUntil: undefined }; await persist() } }
    // The saved active account must be in the list. If it isn't (its entry was lost), put it back rather than
    // quietly showing another account: its coins come from the same 24 words, and hiding them looks like lost money.
    const want = prefs.activeAccount
    if (want !== undefined && want > 0 && want < 1000 && !secrets.accounts.some((a) => a.index === want)) {
      secrets.accounts.push({ index: want, name: 'Recovered account' }); await persist()
    }
    buildAccounts()
    if (reconcileSplits()) await persist()
    if (settleInterruptedRoutes()) await persist()
    startMonero(activeAcct())
    void peekOtherXmr()
    return true
  } catch { /* maybe the duress PIN */ }
  if (!duressEnabled()) { await seal({} as VaultSecrets, pw).catch(() => {}); return false } // same cost either way, so timing reveals nothing
  const blob = await openDuress(pw)
  if (!blob) return false
  // Duress: open an empty decoy, sweep the real wallet to the Vault quietly.
  const d = await ensureDecoy(blob, pw, randomAccountName)
  decoyPin = pw
  // Touch ID holds the real password: after a duress unlock it must not be a way back into the real wallet
  await rm(P.touch(), { force: true }).catch(() => {})
  sealKey = null // persist() becomes a no-op: the real vault file is never touched
  secrets = { mnemonic: d.mnemonic, createdAt: Date.now(), accounts: [{ index: 0, name: d.name }] }
  prefs = { ...prefs, activeAccount: 0 }
  buildAccounts()
  startMonero(0)
  const route = { proxy: monero.proxy, blocked: monero.blocked }
  sweep(blob, { route, xmrCache: P.xmr }).catch(() => {})
  return true
}

const touchIdAvailable = () => process.platform === 'darwin' && systemPreferences.canPromptTouchID() && safeStorage.isEncryptionAvailable()

function registerIpc() {
  const h = (ch: string, fn: (...a: any[]) => any) => { ipcHandlers.set(ch, fn); ipcMain.handle(ch, (_e, ...a) => fn(...a)) }

  h('state', async (): Promise<AppState> => ({
    hasVault: existsSync(P.vault()),
    unlocked: !!secrets,
    touchIdAvailable: touchIdAvailable(),
    touchIdEnabled: touchIdAvailable() && existsSync(P.touch()),
    torAvailable: torSupported(),
    safeGraphics,
    prefs
  }))
  h('generateMnemonic', () => newMnemonic())
  h('validateMnemonic', (m: string) => isValidMnemonic(m))
  h('createVault', async ({ mnemonic, password: pw, name, birthday }: { mnemonic: string; password: string; name?: string; birthday?: number }) => {
    if (!isValidMnemonic(mnemonic)) throw new Error('INVALID_MNEMONIC')
    if (existsSync(P.vault())) throw new Error('VAULT_EXISTS')
    await unlink(P.pinLock()).catch(() => {})
    const firstName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 32) : freshName()
    const s: VaultSecrets = { mnemonic: normalise(mnemonic), createdAt: Date.now(), birthday: typeof birthday === 'number' && birthday > 0 ? Math.min(birthday, Date.now()) : undefined, accounts: [{ index: 0, name: firstName, type: 'spending' }] }
    sealKey = await sealKeyFor(pw)
    await writeJson(P.vault(), sealWith(s, sealKey))
    secrets = s
    await freshAccount(true)
    buildAccounts()
    startMonero(0)
    if (s.birthday) void discoverAccounts() // restored from words: find the accounts that were in use
  })
  // ---- backups ----
  h('exportBackup', async ({ password: pw, backupPassword }: { password: string; backupPassword: string }) => {
    if (!secrets || decoyPin) return { ok: false, error: 'Locked' }
    if (!backupPassword || backupPassword.length < 8) return { ok: false, error: 'Use at least 8 characters for the backup password' }
    const file = await readJson<VaultFile>(P.vault())
    try { await open(file!, pw) } catch { return { ok: false, error: 'Wrong wallet password' } }
    // routes and splits travel too: a route's one-time wallets are only shown through its route record
    const { mnemonic, accounts, book, favs, alerts, watch, tokens, sky, birthday, createdAt, routes, splits } = secrets
    const payload = { mnemonic, accounts, book, favs, alerts, watch, tokens, sky, birthday: birthday ?? createdAt, createdAt, routes, splits }
    const sealed = await seal(payload as any, backupPassword)
    const r = await dialog.showSaveDialog(win!, { title: 'Save encrypted backup', defaultPath: `astrala-backup-${new Date().toISOString().slice(0, 10)}.astrala`, filters: [{ name: 'Astrala backup', extensions: ['astrala'] }] })
    if (r.canceled || !r.filePath) return { ok: false, error: '' }
    await writeFile(r.filePath, JSON.stringify({ format: 'astrala-backup', v: 1, sealed }), { mode: 0o600 })
    return { ok: true, path: r.filePath }
  })
  h('pickBackup', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose an Astrala backup', properties: ['openFile'], filters: [{ name: 'Astrala backup', extensions: ['astrala', 'json'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    try { const j = JSON.parse(await readFile(r.filePaths[0], 'utf8')); return j?.format === 'astrala-backup' ? { name: r.filePaths[0].split(/[\\/]/).pop(), data: JSON.stringify(j) } : null } catch { return null }
  })
  h('restoreBackup', async ({ data, backupPassword, password: pw }: { data: string; backupPassword: string; password: string }) => {
    if (existsSync(P.vault())) return { ok: false, error: `A wallet already exists on this ${DEVICE}` }
    let p: any
    try { p = await open(JSON.parse(data).sealed, backupPassword) } catch { return { ok: false, error: 'Wrong backup password' } }
    if (!isValidMnemonic(p.mnemonic)) return { ok: false, error: 'Backup is damaged' }
    const s: VaultSecrets = { mnemonic: normalise(p.mnemonic), createdAt: p.createdAt ?? Date.now(), birthday: p.birthday, accounts: p.accounts?.length ? p.accounts : [{ index: 0, name: freshName() }], book: p.book, favs: p.favs, alerts: p.alerts, watch: p.watch, sky: Array.isArray(p.sky) ? p.sky.slice(0, 40) : undefined, tokens: Array.isArray(p.tokens) ? p.tokens.slice(0, 100) : undefined, routes: Array.isArray(p.routes) ? p.routes.slice(0, 100) : undefined, splits: Array.isArray(p.splits) ? p.splits : undefined }
    // a one-time wallet whose route didn't come with the backup (older backups) goes back to the account switcher,
    // so whatever sits in it stays visible
    const live = new Set((s.routes ?? []).map((r) => r.id))
    for (const a of s.accounts) if (a.route && !live.has(a.route)) delete a.route
    secrets = s
    settleInterruptedRoutes()
    sealKey = await sealKeyFor(pw)
    await writeJson(P.vault(), sealWith(s, sealKey))
    secrets = s
    await freshAccount(true)
    buildAccounts(); startMonero(0)
    return { ok: true }
  })
  h('splitShares', async (pw: string) => {
    if (!secrets || decoyPin) return null
    const file = await readJson<VaultFile>(P.vault())
    try { await open(file!, pw) } catch { return null }
    return splitPhrase(secrets.mnemonic)
  })
  h('joinShares', (shares: string[]) => { try { return joinShares(shares) } catch { return null } })
  h('validShare', (s: string) => validShare(s))
  // "Start hidden": every unlock begins in stealth, whichever way the wallet was opened
  const startHidden = async (ok: boolean) => { if (ok && prefs.stealthOnUnlock && !prefs.stealth) { prefs = { ...prefs, stealth: true }; await writeJson(P.prefs(), { ...prefs, v: 2 }) } return ok }
  h('unlock', async (pw: string) => startHidden(await unlockWith(pw)))
  h('unlockTouchId', async () => {
    if (!touchIdAvailable() || !existsSync(P.touch()) || existsSync(P.pinLock())) return false
    try {
      await systemPreferences.promptTouchID('unlock Astrala')
      const pw = safeStorage.decryptString(await readFile(P.touch()))
      return startHidden(await unlockWith(pw))
    } catch {
      return false
    }
  })
  h('lock', () => lock())
  h('touchActive', () => { lastUse = Date.now() })
  h('accounts', () => accountsCache)
  // ---------- hardware wallets (Ledger, Trezor): accounts whose keys stay on the device ----------
  const devName = (v: HwAccount['vendor']) => (v === 'trezor' ? 'Trezor' : 'Ledger')
  const readDevice = (v: HwAccount['vendor'], c: LedgerChain, a: number, show = false) => (v === 'trezor' ? trezorRead(c, a, show) : ledgerRead(c, a, show))
  h('hwStatus', (vendor: HwAccount['vendor']) => (vendor === 'trezor' ? trezorStatus() : ledgerStatus()))
  /** Read one chain from the device into a hardware account: a new one, or one already added (index). */
  h('hwAdd', async (vendor: HwAccount['vendor'], chain: LedgerChain, opts: { index?: number; account?: number; name?: string } = {}) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    if (decoyPin) return { ok: false, error: 'Not available right now' }
    if (vendor !== 'ledger' && vendor !== 'trezor') return { ok: false, error: 'Unknown device' }
    if (!['evm', 'btc', 'sol'].includes(chain)) return { ok: false, error: 'Hardware accounts hold ETH (and its networks), Bitcoin and Solana' }
    const existing = opts?.index != null ? secrets.accounts.find((a) => a.index === opts.index && a.hw?.vendor === vendor) : undefined
    if (opts?.index != null && !existing) return { ok: false, error: `Unknown ${devName(vendor)} account` }
    const devAcct = existing?.hw?.account ?? Math.max(0, Math.min(99, Math.floor(Number(opts?.account ?? 0)) || 0))
    try {
      const got = await readDevice(vendor, chain, devAcct)
      const addr = got.evm ?? got.sol ?? got.btc?.address
      if (!addr) return { ok: false, error: `The ${devName(vendor)} returned no address` }
      // the Bitcoin address must be the device key's own: change and signatures are built from that key
      if (got.btc && p2wpkh(Buffer.from(got.btc.pubkey, 'hex')).address !== got.btc.address) return { ok: false, error: `The ${devName(vendor)}'s Bitcoin key and address don't match. Nothing was added` }
      // re-reading a chain this account already has must give the same address: anything else is another device
      // or another passphrase, and silently swapping it would move the account onto a different wallet
      const had = existing?.hw?.[chain]
      const hadAddr = typeof had === 'string' ? had : had?.address
      if (hadAddr && hadAddr !== addr) return { ok: false, error: `This isn't the ${devName(vendor)} (or passphrase) this account came from. Its ${chain === 'evm' ? 'Ethereum' : chain === 'btc' ? 'Bitcoin' : 'Solana'} address is different` }
      if (!secrets) return { ok: false, error: 'Wallet is locked' } // locked while the device was busy
      const dup = secrets.accounts.find((a) => a.hw && a !== existing && [a.hw.evm, a.hw.sol, a.hw.btc?.address].includes(addr))
      if (dup) return { ok: false, error: `That ${devName(vendor)} account is already here, as “${dup.name}”` }
      let rec = existing
      if (!rec) {
        const index = Math.max(...secrets.accounts.map((a) => a.index)) + 1
        rec = { index, name: (String(opts?.name ?? '').trim() || `${devName(vendor)} ${devAcct + 1}`).slice(0, 32), avatar: defaultAvatar(index), hw: { vendor, account: devAcct } }
        secrets.accounts.push(rec)
      }
      rec.hw = { ...rec.hw!, ...got }
      await persist(); buildAccounts()
      return { ok: true, index: rec.index, address: addr, accounts: accountsCache }
    } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 220) } }
  })
  /** Show an address on the device, to check it against the screen before receiving to it. */
  h('hwVerify', async (index: number, chain: LedgerChain) => {
    const hw = hwOf(index)
    if (!hw) return { ok: false, error: 'Not a hardware-wallet account' }
    const want = chain === 'evm' ? hw.evm : chain === 'sol' ? hw.sol : chain === 'btc' ? hw.btc?.address : undefined
    if (!want) return { ok: false, error: 'This account has no address on that chain yet' }
    try {
      const got = await readDevice(hw.vendor, chain, hw.account, true)
      const seen = got.evm ?? got.sol ?? got.btc?.address
      const same = chain === 'evm' ? seen?.toLowerCase() === want.toLowerCase() : seen === want
      return same ? { ok: true } : { ok: false, error: `Your ${devName(hw.vendor)} shows a different address. Do not receive to this one` }
    } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 220) } }
  })
  h('randomName', () => freshName())
  h('addAccount', async (opts?: { xmrRestoreHeight?: number; type?: string }) => {
    if (!secrets) return []
    const height = checkRestoreHeight(opts?.xmrRestoreHeight)
    const index = Math.max(...secrets.accounts.map((a) => a.index)) + 1
    secrets.accounts.push({ index, name: freshName(), avatar: defaultAvatar(index), type: accountType(opts?.type), ...(height != null ? { xmrRestoreHeight: height } : {}) })
    await persist(); buildAccounts()
    return accountsCache
  })
  h('scanAccounts', () => discoverAccounts())
  h('hiddenAccounts', () => (secrets?.accounts ?? []).filter((a) => a.hidden && !a.route).map((a) => ({ index: a.index, name: a.name, avatar: a.avatar ?? defaultAvatar(a.index), type: accountType(a.type) })))
  h('updateAccount', async (index: number, patch: { name?: string; avatar?: any; hidden?: boolean; xmrRestoreHeight?: number | null; type?: string }) => {
    if (!secrets) return []
    const a = secrets.accounts.find((x) => x.index === index)
    if (!a) return accountsCache
    // a new Monero restore height: forget this account's scan and start again from there
    let rescan = false
    if (patch.xmrRestoreHeight !== undefined) {
      const height = checkRestoreHeight(patch.xmrRestoreHeight)
      if (height !== (a.xmrRestoreHeight ?? null)) {
        if (height == null) delete a.xmrRestoreHeight
        else a.xmrRestoreHeight = height
        rescan = true
      }
    }
    if (patch.name !== undefined) a.name = String(patch.name).slice(0, 40) || freshName()
    if (patch.avatar) {
      const av = patch.avatar
      if (av.kind === 'image' && (typeof av.dataUrl !== 'string' || !av.dataUrl.startsWith('data:image/') || av.dataUrl.length > 120_000)) return accountsCache
      a.avatar = av
    }
    if (patch.hidden !== undefined && index !== 0) a.hidden = !!patch.hidden
    if (isAccountType(patch.type)) a.type = patch.type
    await persist(); buildAccounts()
    if (rescan) {
      diag(`[xmr] account ${index} restore height → ${a.xmrRestoreHeight ?? 'wallet default'}`)
      const live = index === xmrAccount
      if (live) await monero.stop() // before the file goes, so a last save can't put it back
      await unlink(decoyPin ? P.xmrDecoy(index) : P.xmr(index)).catch(() => {})
      if (live) await startMonero(index)
    }
    return accountsCache
  })
  h('renameAccount', async (index: number, name: string) => {
    if (!secrets || !sealKey) return
    const a = secrets.accounts.find((x) => x.index === index)
    if (!a) return
    a.name = name.slice(0, 40) || freshName()
    await persist()
    buildAccounts()
  })
  // Keeping the last balances means the wallet can show your money the instant it opens. They go in
  // the encrypted vault like xmrLast, never in the clear, and are written at most once a minute so a
  // 30-second refresh does not keep rewriting the file.
  let cacheWritten = 0
  const rememberBalances = (index: number, all: Balance[]) => {
    if (!secrets) return
    const prev = secrets.balanceCache?.[index]
    // a chain that didn't answer this time (amount unknown) keeps its last saved figure: one failed read must not
    // make the next launch open on a smaller total and then jump back up
    const unknown = new Set(all.filter((b) => b.amount == null).map((b) => b.asset))
    const keep = [...all.filter((b) => (b.amount ?? 0) > 0), ...(prev ?? []).filter((b) => unknown.has(b.asset))]
    if (JSON.stringify(prev) === JSON.stringify(keep)) return
    secrets.balanceCache = { ...secrets.balanceCache, [index]: keep }
    if (Date.now() - cacheWritten < 60_000) return
    cacheWritten = Date.now()
    void persist()
  }
  h('cachedBalances', (index: number) => secrets?.balanceCache?.[index] ?? [])
  h('balances', async (index: number) => {
    const addrs = addressesFor(index)
    if (!addrs) return []
    // push each coin the moment its chain answers, so the interface fills in instead of waiting
    // on the slowest one. Monero is corrected below, after the scan is consulted.
    const all = await getAllBalances(addrs, (b) => { if (b.asset !== 'xmr') toWin('balance', { account: index, balance: b }) })
    const held = all.filter((b) => (b.amount ?? 0) > 0).map((b) => b.asset).join(', ')
    if (held !== lastHeld) { lastHeld = held; diag(`[balances] account ${index} holds: ${held || 'nothing'}`) }
    // the account on screen changed (switched, hidden, removed) without Monero following: follow it now
    if (secrets && index === activeAcct() && index !== xmrAccount) startMonero(index)
    const x = all.find((b) => b.asset === 'xmr')
    if (x && index === xmrAccount) {
      const bal = await monero.balance().catch(() => null)
      const st = monero.status
      if (bal && st.state === 'synced' && secrets && secrets.xmrLast?.[index] !== bal.total) { secrets.xmrLast = { ...secrets.xmrLast, [index]: bal.total }; void persist() }
      if (bal) { x.amount = bal.total; x.status = 'ok'; if (bal.unlocked < bal.total) x.note = `${(bal.total - bal.unlocked).toFixed(4)} XMR unlocking` }
      else if (secrets?.xmrLast?.[index] != null) { x.amount = secrets.xmrLast[index]; x.status = 'ok'; x.note = `Last scan · ${st.state === 'syncing' ? `scanning ${st.percent}%` : 'checking'}` }
      else x.note = st.state === 'syncing' ? `Scanning ${st.percent}%` : st.state === 'offline' ? 'Monero node offline, retrying' : 'Connecting to Monero'
    } else if (x && secrets?.xmrLast?.[index] != null) {
      // Monero is scanning another account right now: show this one's last scanned balance instead of nothing
      x.amount = secrets.xmrLast[index]; x.status = 'ok'; x.note = 'Last scan · rescans when you open this account'
    }
    if (x) toWin('balance', { account: index, balance: x })
    rememberBalances(index, all)
    return all
  })
  h('xmrStatus', () => monero.status)
  h('routeStatus', () => routeStatus())
  // Status panel: one timed height read per chain, through the route. While the route is down and the kill switch
  // holds, nothing is sent at all. Answers are shared for a few seconds so two open panels never double the traffic.
  let healthRun: { at: number; p: Promise<NetHealth> } | null = null
  h('netHealth', () => {
    if (healthRun && Date.now() - healthRun.at < 4000) return healthRun.p
    const st = routeStatus(), r = prefs.route ?? DEFAULT_PREFS.route
    const held = st.mode !== 'direct' && st.state !== 'ready' && (r.killSwitch || st.mode === 'mullvad')
    healthRun = { at: Date.now(), p: pingChains(net, { held }) }
    return healthRun.p
  })
  h('mullvadStatus', () => mullvadStatus())
  h('mullvadRelays', () => mullvadRelays().catch(() => []))
  h('mullvadControl', async (action: 'connect' | 'disconnect' | 'location', country?: string, city?: string) => {
    try {
      if (action === 'connect') { await mullvadConnect(); return { ok: true, status: await waitFor('connected') } }
      if (action === 'disconnect') { await mullvadDisconnect(); return { ok: true, status: await waitFor('disconnected', 8000) } }
      await mullvadSetLocation(String(country ?? ''), city ? String(city) : undefined)
      return { ok: true, status: await waitFor('connected') }
    } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) } }
  })
  h('mullvadCheck', () => mullvadCheck())
  // small lists kept inside the encrypted vault (empty in the duress decoy)
  const DATA_KEYS = { book: 500, favs: 600, alerts: 200, watch: 100, sky: 400, arrived: 30 } as const // favs and sky hold every account's picks
  h('getData', (key: keyof typeof DATA_KEYS) => (secrets && Object.hasOwn(DATA_KEYS, key) ? (secrets as any)[key] ?? [] : []))
  h('setData', async (key: keyof typeof DATA_KEYS, value: unknown[]) => {
    if (!secrets || !Object.hasOwn(DATA_KEYS, key) || !Array.isArray(value) || value.length > DATA_KEYS[key] || JSON.stringify(value).length > 200_000) return false
    ;(secrets as any)[key] = value
    await persist()
    return true
  })
  // ---- added coins (search or pasted contract) ----
  const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))])
  h('tokens', () => secrets?.tokens ?? [])
  h('tokenSearch', async (q: string): Promise<TokenHit[]> => {
    if (!secrets || typeof q !== 'string' || q.length > 120) return []
    const hits = (await searchTokens(q)).slice(0, 24)
    // logos are fetched here through the routed network, so the UI never contacts an image host
    const logos = new Map<string, Promise<string | undefined>>()
    await Promise.all(hits.map(async (hit) => {
      if (!hit.logo) return
      if (!logos.has(hit.logo)) logos.set(hit.logo, withTimeout(fetchLogo(hit.logo), 5000))
      hit.logo = await logos.get(hit.logo)
    }))
    return hits
  })
  h('tokenAdd', async (t: { network: string; contract: string; cg?: string; logo?: string }) => {
    if (!secrets) return { ok: false, error: 'Locked' }
    const list = secrets.tokens ?? []
    if (list.length >= 100) return { ok: false, error: 'You can add up to 100 coins' }
    if (typeof t?.network !== 'string' || typeof t?.contract !== 'string') return { ok: false, error: 'Missing token' }
    const contract = t.contract.trim()
    if (ASSET[tokenId(t.network, contract)] || ASSETS.some((a) => a.network === t.network && a.contract?.toLowerCase() === contract.toLowerCase())) return { ok: false, error: 'Already in your wallet' }
    try {
      const meta = await readToken(t.network, contract) // decimals/symbol from the chain itself
      // re-check the listing here; the UI's word for "verified" is not trusted
      const hits = await searchTokens(contract).catch(() => [] as TokenHit[])
      const listed = hits.find((x) => x.network === t.network && x.verified)
      const logo = typeof t.logo === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(t.logo) && t.logo.length < 90_000 ? t.logo : await withTimeout(fetchLogo(listed?.logo), 5000)
      const tok: CustomToken = { network: t.network, contract, ...meta, cg: listed?.cg, logo, verified: !!listed, added: Date.now() }
      secrets.tokens = [...list, tok]
      registerTokens(secrets.tokens)
      await persist()
      return { ok: true, tokens: secrets.tokens }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 120) }
    }
  })
  h('tokenRemove', async (id: string) => {
    if (!secrets) return []
    secrets.tokens = (secrets.tokens ?? []).filter((x) => tokenId(x.network, x.contract) !== id)
    registerTokens(secrets.tokens)
    await persist()
    return secrets.tokens
  })
  h('watchBalances', async (family: string, address: string) => {
    const addrs = { [family]: address } as Addresses
    return Promise.all(ASSETS.filter((a) => networkOf(a.id).family === family && a.id !== 'xmr').map((a) => getBalance(a, addrs)))
  })
  h('traySummary', (t: TraySummary) => { if (secrets) setTraySummary({ ...t, locked: false }) })
  // ---- duress setup (invisible while the decoy is open) ----
  h('duressStatus', () => (decoyPin || !secrets ? { enabled: false } : { enabled: duressEnabled(), vault: secrets.duress?.vault }))
  h('duressNewVault', () => (decoyPin ? null : newVaultPhrase()))
  h('duressSetup', async ({ pin, password: pw, vaultMnemonic }: { pin: string; password: string; vaultMnemonic: string }) => {
    if (!secrets || decoyPin) return { ok: false, error: 'Locked' }
    if (!pin || pin.length < 6) return { ok: false, error: 'Use at least 6 digits or characters' }
    if (pin === pw) return { ok: false, error: 'The PIN must be different from your password' }
    if (!isValidMnemonic(vaultMnemonic)) return { ok: false, error: 'Vault phrase invalid' }
    if (!duressAvailable()) return { ok: false, error: process.platform === 'linux' ? 'Needs a system keyring (GNOME Keyring or KWallet), and none is running. Without one the PIN could be guessed offline, so duress stays off.' : 'Needs the system keychain, which is not available' }
    if (secrets.pay?.pin && await checkPin(pin, secrets.pay.pin)) return { ok: false, error: 'The duress PIN must be different from your payment PIN' }
    const file = await readJson<VaultFile>(P.vault())
    try { await open(file!, pw) } catch { return { ok: false, error: 'Wrong password' } }
    if (!secrets.xmrKey) secrets.xmrKey = randomBytes(32).toString('hex')
    const vault = vaultAddresses(normalise(vaultMnemonic))
    await writeDuress({ mnemonic: secrets.mnemonic, accounts: secrets.accounts.map((a) => a.index), vault, xmrKey: secrets.xmrKey, birthday: secrets.birthday ?? secrets.createdAt }, pin)
    secrets.duress = { vault, setAt: Date.now() }
    await persist()
    return { ok: true, vault }
  })
  h('duressDisable', async (pw: string) => {
    if (!secrets || decoyPin) return false
    const file = await readJson<VaultFile>(P.vault())
    try { await open(file!, pw) } catch { return false }
    await removeDuress()
    delete secrets.duress
    await persist()
    return true
  })
  h('torCheck', () => torCheck())
  h('xmrRescan', async () => { await monero.stop(); await unlink(P.xmr(xmrAccount)).catch(() => {}); await startMonero(xmrAccount) })
  h('xmrTestNode', async (uri: string) => {
    if (!/^https?:\/\/[^\s]+$/.test(uri)) return null
    try { const r = await net(`${uri.replace(/\/+$/, '')}/get_info`, { signal: AbortSignal.timeout(8000) } as RequestInit); const j: any = await r.json(); return j?.height ?? null } catch { return null }
  })
  // only ever hand out an address of the account on screen; while Monero is switching accounts there is none to give
  h('xmrReceive', (forceNew?: boolean) => (xmrAccount === activeAcct() ? monero.receiveAddress(!!forceNew).catch(() => '') : ''))
  // A price feed that is slow or rate-limited (CoinGecko answers 429 often) must not blank every value
  // on screen: keep the last good prices per currency and hand those back instead of null.
  const priceMem: Record<string, Record<string, PriceInfo>> = {}
  let pricesWritten = 0
  h('prices', async (c: string) => {
    if (!/^[A-Za-z]{3,5}$/.test(String(c))) return null
    const p = await getPrices(c)
    const last = priceMem[c] ?? secrets?.priceCache?.[c]
    if (!p) return last ?? null
    // a coin the price feed left out of this answer reads 0: keep its last price, or its value drops out of the
    // total for one refresh and comes back on the next
    if (last) for (const id in p) if (!(p[id].price > 0) && last[id]?.price > 0) p[id] = last[id]
    priceMem[c] = p
    if (secrets) {
      const first = !secrets.priceCache?.[c]
      secrets.priceCache = { ...secrets.priceCache, [c]: p }
      if (first || Date.now() - pricesWritten > 10 * 60_000) { pricesWritten = Date.now(); void persist() }
    }
    return p
  })
  h('cachedPrices', (c: string) => priceMem[c] ?? secrets?.priceCache?.[c] ?? null)
  h('history', (cg: string, c: string, days: number) => getHistory(cg, c, days))
  h('validateAddress', (assetId: string, to: string) => validateAddress(assetId, to))
  h('quote', async (req: SendRequest) => {
    const acct = req.account ?? activeAcct()
    const addrs = addressesFor(acct)
    if (!addrs || !secrets) return { ok: false, error: 'Locked', amount: 0, fee: 0, feeAsset: '', maxAmount: 0, eta: '', notes: [] }
    const m = secrets.mnemonic
    return quote(req, addrs, (f) => signingKey(m, f, acct))
  })
  // Re-authenticate for every send or swap: password, or Touch ID if enabled.
  async function reauth(pw: string | undefined, reason: string): Promise<null | { ok: false; error: string; auth: true }> {
    if (decoyPin) return pw === decoyPin ? null : { ok: false, error: pw ? 'Wrong password' : 'Password required', auth: true }
    if (pw) {
      const file = await readJson<VaultFile>(P.vault())
      try { await open(file!, pw) } catch { return { ok: false, error: 'Wrong password', auth: true } }
      return null
    }
    if (!touchIdAvailable() || !existsSync(P.touch())) return { ok: false, error: 'Password required', auth: true }
    try { await systemPreferences.promptTouchID(reason) } catch { return { ok: false, error: 'Touch ID cancelled', auth: true } }
    return null
  }
  // Main's own confirmation before money moves: Touch ID with main's summary as the reason, or a native OS dialog.
  // Neither can be drawn, dismissed or reworded by the renderer. Skipped only if the user turned it off (force ignores that).
  async function nativeConfirm(o: { title: string; short: string; full: string; note?: string; force?: boolean }): Promise<boolean> {
    if (!o.force && secrets?.pay?.confirmOff) return true
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try { await systemPreferences.promptTouchID(touchReason(o.short)); return true } catch { return false }
    }
    const box = { type: 'warning' as const, buttons: ['Cancel', 'Confirm'], defaultId: 0, cancelId: 0, noLink: true, title: 'Astrala', message: o.title,
      detail: `${o.full}${o.note ? `\n\n${o.note}` : ''}\n\nCheck this matches what you just reviewed. If anything is different, press Cancel.` }
    const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box)
    return r.response === 1
  }
  let usd: { at: number; map: Record<string, { price: number }> } | null = null
  const usdPrice = async () => {
    if (!usd || Date.now() - usd.at > 60_000) { const m = await getPrices('USD'); if (m) usd = { at: Date.now(), map: m } }
    return (id: string) => usd?.map[ASSET[id]?.cg]?.price
  }
  // ---- SOL native staking ----
  const solOwner = () => addressesFor(activeAcct())?.sol
  h('stakeInfo', async () => { const o = solOwner(); return o ? stakeAccounts(o) : null })
  h('validators', () => solValidators())
  h('stakeAction', async (a: { kind: 'stake' | 'unstake' | 'withdraw'; amount?: number; vote?: string; account?: string }, pw?: string) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    const sa = { kind: a?.kind, amount: a?.amount, vote: a?.vote, account: a?.account }
    if (!['stake', 'unstake', 'withdraw'].includes(sa.kind)) return { ok: false, error: 'Unknown staking action' }
    // Touch ID here already shows main's own summary; after a typed password, main asks again natively
    const denied = await reauth(pw, touchReason(stakeSummary(sa)))
    if (denied) return denied
    if (pw && !(await nativeConfirm({ title: 'Confirm staking', short: stakeSummary(sa), full: stakeSummary(sa, { addresses: 'full' }) }))) return { ok: false, error: 'Cancelled' }
    const acct = activeAcct()
    const hwNo = hwRefusal(acct, 'Staking'); if (hwNo) return hwNo
    const owner = addressesFor(acct)?.sol
    if (!owner) return { ok: false, error: 'No Solana address' }
    const key = signingKey(secrets.mnemonic, 'sol', acct).priv
    try {
      const txid = sa.kind === 'stake' ? (await solStake(key, owner, Number(sa.amount), String(sa.vote))).txid
        : sa.kind === 'unstake' ? await solUnstake(key, owner, String(sa.account)) : await withdrawStake(key, owner, String(sa.account))
      return { ok: true, txid }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200) }
    } finally { key.fill(0) }
  })
  // ---------- payment PIN, review and daily limit ----------
  // Every send and swap needs a fresh approval from verifyPin, bound to that exact payment. The renderer never
  // sees the PIN hash; it only gets a single-use token. In the duress decoy the PIN lives in memory only
  // (persist() is a no-op there), so the decoy asks for a PIN to be set up, exactly like a wallet that never had one.
  type Pick = LegPick
  const normIntent = (i: Intent) => normIntentFor(i, activeAcct())
  // The prompt the renderer can't draw or fake: built here from the normalized intent and main's own registries.
  const summaryCtx = (addresses: 'short' | 'full'): SummaryCtx => ({
    addresses,
    providerName: (p) => PROVIDER_NAME[p as Provider],
    accountName: (n) => secrets?.accounts.find((a) => a.index === n)?.name,
    activity: (id) => { const a = secrets?.activity?.find((x) => x.id === id); return a ? { asset: a.asset, amount: a.amount, to: a.to } : undefined },
    dapp: (id) => dappPending.get(id)?.view.summary,
    spenderName,
    accountType: (n) => { const a = secrets?.accounts.find((x) => x.index === n); return a ? accountType(a.type) : undefined },
    ownAccount
  })
  // A send to one of this wallet's own accounts reads as a move. Main matches the recipient against the addresses
  // it derives itself from the 24 words (hidden accounts too), so the window can't make a stranger look like "you".
  const ownAccount = (assetId: string, to: string) => {
    if (!secrets || !ASSET[assetId] || !to) return undefined
    const fam = networkOf(assetId).family
    for (const a of secrets.accounts) {
      const list = accountsCache.find((x) => x.index === a.index)?.addresses ?? deriveAccount(secrets.mnemonic, a.index)
      const mine = list.find((d) => d.chain === fam)?.address
      if (mine && sameAddress(fam, mine, to)) return { index: a.index, name: a.name, type: accountType(a.type) }
    }
    return undefined
  }
  const summaries = (n: NormIntent, overLimit: boolean) => ({ short: intentSummary(n, summaryCtx('short'), { overLimit }), full: intentSummary(n, summaryCtx('full'), { overLimit }) })
  const savePay = async (p: Partial<NonNullable<VaultSecrets['pay']>>) => { if (!secrets) return; secrets.pay = { ...secrets.pay, ...p }; await persist() }
  let fiatCache: { cur: string; at: number; map: Record<string, { price: number }> } | null = null
  const fiatPrice = async (cur: string) => {
    if (!fiatCache || fiatCache.cur !== cur || Date.now() - fiatCache.at > 60_000) { const m = await getPrices(cur); if (m) fiatCache = { cur, at: Date.now(), map: m } }
    return (id: string) => (fiatCache?.cur === cur ? fiatCache.map[ASSET[id]?.cg]?.price : undefined)
  }
  // rolling 24 h of everything sent or swapped away (all accounts), valued now in the limit's currency
  const limitCheck = async (i: Intent) => {
    const lim = secrets?.pay?.limit
    if (!lim || !secrets || i.kind === 'bump' || i.kind === 'cancel' || i.kind === 'revoke') return null // a fee bump, cancel or revoke moves no new money out
    const spend = i.kind === 'dapp' ? dappPending.get(i.req.id)?.view.spend : undefined
    if (i.kind === 'dapp' && !spend) return null // a signature, an approval or a call with no visible outflow
    const price = await fiatPrice(lim.currency)
    const asset = i.kind === 'dapp' ? spend!.assetId : i.kind === 'send' ? i.req.assetId : i.req.from
    let amount = i.kind === 'dapp' ? spend!.amount : Number(i.req.amount) || 0
    if (i.kind === 'send' && i.req.max) {
      const acct = i.req.account ?? activeAcct(), addrs = addressesFor(acct), m = secrets.mnemonic
      if (addrs) amount = (await quote(i.req, addrs, (f) => signingKey(m, f, acct)).catch(() => ({ amount: 0 }))).amount
    }
    const now = Date.now()
    const recent = (secrets.activity ?? []).filter((a) => a.status !== 'failed' && now - a.time < 86_400_000)
    // without a price we can't prove it's under the limit, so it isn't: an override is needed
    const known = (id: string) => (price(id) ?? 0) > 0 // a coin the feed left out reads 0: that's unknown, not free
    const unknown = !known(asset) || recent.some((a) => !known(a.asset))
    const amountFiat = amount * (price(asset) ?? 0)
    const spent = spent24h(secrets.activity ?? [], price, now)
    return { limit: lim.amount, currency: lim.currency, spent, amount: amountFiat, over: unknown || isOverLimit(lim.amount, spent, amountFiat) }
  }
  const safeLimit = async (i: Intent) => {
    try { return await limitCheck(i) } catch { const lim = secrets?.pay?.limit; return lim ? { limit: lim.amount, currency: lim.currency, spent: 0, amount: 0, over: true } : null }
  }
  // PIN checks run one at a time, in order: guesses fired together would each pass the "not paused" check before
  // any had been counted, and all be tested in one burst
  let pinTail: Promise<unknown> = Promise.resolve()
  const tryPin = (pin: unknown): ReturnType<typeof tryPinNow> => { const r = pinTail.then(() => tryPinNow(pin)); pinTail = r.catch(() => {}); return r }
  const tryPinNow = async (pin: unknown) => {
    if (!secrets) return { ok: false as const, error: 'Wallet is locked' }
    const stored = secrets.pay?.pin
    if (!stored) return { ok: false as const, error: 'Set up your payment PIN first', needSetup: true }
    const now = Date.now(), g = { fails: secrets.pay?.fails ?? 0, lockUntil: secrets.pay?.lockUntil }
    if (pinBlocked(g, now)) return { ok: false as const, error: 'Too many wrong PINs. Payments are paused for a few minutes.', lockedUntil: g.lockUntil }
    secrets.pay = { ...secrets.pay, fails: g.fails + 1 } // counted before the (async) check, so parallel guesses each count
    await persist() // on disk before the check: killing the app mid-guess must not hand the attempt back
    if (typeof pin === 'string' && PIN_RE.test(pin) && (await checkPin(pin, stored))) {
      await savePay({ fails: 0, lockUntil: undefined })
      return { ok: true as const }
    }
    const r = onPinFail({ fails: Math.max(0, (secrets?.pay?.fails ?? 1) - 1), lockUntil: secrets?.pay?.lockUntil }, now)
    await savePay({ fails: r.guard.fails, lockUntil: r.guard.lockUntil })
    if (r.lockApp) {
      if (!decoyPin) await writeFile(P.pinLock(), '1', { mode: 0o600 }).catch(() => {}) // the decoy never marks the real wallet
      lock()
      return { ok: false as const, error: 'Ten wrong PINs. Astrala locked itself. Unlock with your password.', appLocked: true }
    }
    return { ok: false as const, error: r.lockUntil ? 'Five wrong PINs. Payments are paused for 5 minutes.' : 'Wrong PIN', remaining: r.remaining, lockedUntil: r.lockUntil }
  }
  h('payStatus', async () => {
    if (!secrets) return { pinSet: false }
    const lim = secrets.pay?.limit
    const spent = lim ? spent24h(secrets.activity ?? [], await fiatPrice(lim.currency), Date.now()) : undefined
    const lockedUntil = pinBlocked({ fails: secrets.pay?.fails ?? 0, lockUntil: secrets.pay?.lockUntil }, Date.now()) ? secrets.pay?.lockUntil : undefined
    return { pinSet: !!secrets.pay?.pin, lockedUntil, limit: lim, spent, confirmNative: !secrets.pay?.confirmOff, drainGuard: !secrets.pay?.guardOff }
  })
  h('payCheck', async (i: Intent) => {
    if (!secrets) return { pinSet: false }
    const lc = await safeLimit(i)
    const lockedUntil = pinBlocked({ fails: secrets.pay?.fails ?? 0, lockUntil: secrets.pay?.lockUntil }, Date.now()) ? secrets.pay?.lockUntil : undefined
    return { pinSet: !!secrets.pay?.pin, lockedUntil, overLimit: lc?.over ? { limit: lc.limit, spent: lc.spent, amount: lc.amount, currency: lc.currency } : undefined }
  })
  h('setPin', async ({ pin, password: pw }: { pin: string; password: string }) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) return { ok: false, error: 'Use exactly 6 digits' }
    if (/^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return { ok: false, error: 'Too easy to guess. Avoid repeats and runs like 123456.' }
    if (decoyPin) { if (pw !== decoyPin) return { ok: false, error: 'Wrong password' } }
    else { const file = await readJson<VaultFile>(P.vault()); try { await open(file!, pw) } catch { return { ok: false, error: 'Wrong password' } } }
    if (pin === pw) return { ok: false, error: 'Your PIN must be different from your password' }
    if (!decoyPin && duressEnabled() && (await openDuress(pin).catch(() => null))) return { ok: false, error: 'Your PIN must be different from your duress PIN' }
    await savePay({ pin: await hashPin(pin), fails: 0, lockUntil: undefined })
    return { ok: true }
  })
  h('verifyPin', async (pin: string, i: Intent, override?: boolean) => {
    const r = await tryPin(pin)
    if (!r.ok) return r
    const lc = await safeLimit(i)
    if (lc?.over && !override) return { ok: false, error: 'This is over your daily limit', overLimit: { limit: lc.limit, spent: lc.spent, amount: lc.amount, currency: lc.currency } }
    const n = normIntent(i), over = !!(lc?.over && override)
    // a PIN typed in the window isn't enough on its own: main shows what this token will pay, the user confirms outside the page
    if (!(await nativeConfirm({ title: 'Confirm payment', ...summaries(n, over), note: vaultLine(n, summaryCtx('full')) }))) return { ok: false, error: 'Cancelled' }
    return { ok: true, token: approvals.issue(n, Date.now(), over) }
  })
  h('setLimit', async ({ amount, pin }: { amount: number | null; pin: string }) => {
    const r = await tryPin(pin)
    if (!r.ok) return r
    if (amount != null && !(Number(amount) > 0 && Number(amount) < 1e12)) return { ok: false, error: 'Enter an amount above zero' }
    await savePay({ limit: amount == null ? undefined : { amount: Number(amount), currency: prefs.currency } })
    return { ok: true }
  })
  // On is free. Off needs the payment PIN and one last native confirmation, so the page alone can't switch it off.
  h('setConfirmNative', async ({ on, pin }: { on: boolean; pin?: string }) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    if (on === true) { await savePay({ confirmOff: undefined }); return { ok: true } }
    if (on !== false) return { ok: false, error: 'Bad request' }
    const r = await tryPin(pin)
    if (!r.ok) return r
    const msg = 'Turn off the system confirmation for payments. Sends and swaps will then need only your payment PIN.'
    if (!(await nativeConfirm({ title: 'Turn off payment confirmation', short: 'Turn off payment confirmation', full: msg, force: true }))) return { ok: false, error: 'Cancelled' }
    await savePay({ confirmOff: true })
    return { ok: true }
  })
  // The Drain guard lives in the vault and has its own switch, so neither a screen nor the browser extension can turn
  // it off by writing a setting: off takes the payment PIN and main's own confirmation, like the one above.
  h('setDrainGuard', async ({ on, pin }: { on: boolean; pin?: string }) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    if (on === true) { await savePay({ guardOff: undefined }); return { ok: true } }
    if (on !== false) return { ok: false, error: 'Bad request' }
    const r = await tryPin(pin)
    if (!r.ok) return r
    const msg = 'Turn off the Drain guard. Websites will then be able to ask you for unlimited approvals, permits and hidden signatures again; Astrala will only warn you.'
    if (!(await nativeConfirm({ title: 'Turn off the Drain guard', short: 'Turn off the Drain guard', full: msg, force: true }))) return { ok: false, error: 'Cancelled' }
    await savePay({ guardOff: true })
    return { ok: true }
  })
  // the approval must exist, be unexpired, unused and match this exact payment
  const approved = async (token: unknown, i: Intent): Promise<null | { ok: false; error: string; auth: true }> => {
    const a = approvals.consume(token, normIntent(i), Date.now())
    if (!a.ok) return { ok: false, error: 'Confirm this payment with your PIN again', auth: true }
    const lc = await safeLimit(i)
    if (lc?.over && !a.override) return { ok: false, error: 'This is over your daily limit', auth: true }
    return null
  }
  h('swapQuote', async (req: SwapRequest) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked', routes: [] }
    const addrs = addressesFor(req.account ?? activeAcct())
    if (!addrs) return { ok: false, error: 'Unknown account', routes: [] }
    return swapQuote(req, addrs, await usdPrice(), { feeBps: FEES.swapBps })
  })
  h('swap', (req: SwapRequest, provider: Provider, minOut: number, token?: string) => oneAtATime(async () => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    const denied = await approved(token, { kind: 'swap', req, provider, minOut })
    if (denied) return denied
    const acct = req.account ?? activeAcct()
    const hwNo = hwRefusal(acct, 'Swapping'); if (hwNo) return hwNo
    const addrs = addressesFor(acct)
    if (!addrs) return { ok: false, error: 'Unknown account' }
    const m = secrets.mnemonic, S = secrets
    try {
      const r = await swapExecute(req, provider, minOut, addrs, (f) => signingKey(m, f, acct), { feeBps: FEES.swapBps })
      if (r.feeError) diag('[fee] not collected:', r.feeError)
      const item: ActivityItem = {
        id: `${r.network}:${r.txid}`, kind: 'swap', asset: req.from, network: r.network, amount: Number(req.amount), fee: r.route.networkFee, feeAsset: r.route.networkFeeAsset,
        to: r.route.providerName, txid: r.txid, time: Date.now(), status: 'pending', account: acct,
        swap: { toAsset: req.to, expectedOut: r.route.amountOut, minOut: r.route.minOut, provider, providerName: r.route.providerName, stage: 'pending', approveTxid: r.approveTxid, ref: r.ref, ourFee: r.route.ourFee, feeTxid: r.feeTxid }
      }
      await recordSent(S, item)
      return { ok: true, item }
    } catch (e: any) {
      return { ok: false, error: (e?.shortMessage ?? e?.message ?? 'Swap failed').slice(0, 240) }
    }
  }))
  /** Records a broadcast transaction. Never throws: the coins already left, so a lock mid-flight or a failed
   *  save must not turn "sent" into "failed" and invite the user to pay a second time. */
  const recordSent = async (S: VaultSecrets, item: ActivityItem) => {
    S.activity = [item, ...(S.activity ?? [])].slice(0, 500)
    if (secrets !== S) return
    try { await persist() } catch (e: any) { diag('[activity] save failed after broadcast:', String(e?.message ?? e)) }
    pushActivity()
  }
  // the one send path
  const sendNow = async (req: SendRequest, token?: string): Promise<{ ok: true; item: ActivityItem } | { ok: false; error: string; auth?: true }> => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    const denied = await approved(token, { kind: 'send', req })
    if (denied) return denied
    const acct = req.account ?? activeAcct()
    const addrs = addressesFor(acct)
    if (!addrs) return { ok: false, error: 'Unknown account' }
    const m = secrets.mnemonic, S = secrets
    try {
      const q = await quote(req, addrs, (f) => signingKey(m, f, acct))
      const { txid, network } = await execute(req, addrs, (f) => signingKey(m, f, acct))
      const item: ActivityItem = { id: `${network}:${txid}`, kind: 'send', asset: req.assetId, network, amount: q.amount, fee: q.fee, feeAsset: q.feeAsset, to: req.to.trim(), txid, time: Date.now(), status: 'pending', account: acct }
      await recordSent(S, item)
      return { ok: true, item }
    } catch (e: any) {
      return { ok: false, error: (e?.shortMessage ?? e?.message ?? 'Send failed').slice(0, 240) }
    }
  }
  h('send', (req: SendRequest, token?: string) => oneAtATime(() => sendNow(req, token)))
  h('activity', () => secrets?.activity ?? [])
  // ---------- Split: one coin into several, each landing in its own new wallet ----------
  const pushSplits = () => toWin('splits', secrets?.splits ?? [])
  h('splits', () => secrets?.splits ?? [])
  h('splitQuote', async (req: SplitRequest) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked', fee: 0, feeBps: FEES.splitBps, net: 0, legs: [], etaSec: 0 }
    const addrs = addressesFor(req.account ?? activeAcct())
    if (!addrs) return { ok: false, error: 'Unknown account', fee: 0, feeBps: FEES.splitBps, net: 0, legs: [], etaSec: 0 }
    return splitQuote(req, addrs, await usdPrice())
  })
  h('split', async (req: SplitRequest, picks: Pick[], token?: string) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    if (decoyPin) return { ok: false, error: 'Not available right now' }
    const bad = checkSplit(req)
    if (bad) return { ok: false, error: bad }
    if (!Array.isArray(picks) || picks.length !== req.legs.length) return { ok: false, error: 'Review the split again' }
    const denied = await approved(token, { kind: 'split', req, picks })
    if (denied) return denied
    const acct = req.account ?? activeAcct()
    const hwNo = hwRefusal(acct, 'Splitting'); if (hwNo) return hwNo
    const src = addressesFor(acct)
    if (!src) return { ok: false, error: 'Unknown account' }
    const from = ASSET[req.from], fam = networkOf(req.from).family
    const { fee, parts } = splitAmounts(parseUnits(req.amount, from.decimals), req.legs.map((l) => l.pct), FEES.splitBps, fam)
    const n = (secrets.splits?.length ?? 0) + 1
    const name = (String(req.name ?? '').trim() || `Split ${n}`).slice(0, 24)
    // one brand-new wallet per coin, never the source or any existing wallet
    let next = Math.max(...secrets.accounts.map((a) => a.index)) + 1
    const legs: SplitRecord['legs'] = req.legs.map((l, i) => {
      const index = next++
      secrets!.accounts.push({ index, name: `${name} · ${ASSET[l.to].symbol}`.slice(0, 40), avatar: defaultAvatar(index) })
      return { to: l.to, pct: l.pct, amountIn: Number(parts[i]) / 10 ** from.decimals, account: index, status: 'waiting', provider: picks[i].provider }
    })
    buildAccounts()
    const rec: SplitRecord = { id: randomBytes(8).toString('hex'), name, from: req.from, amount: Number(req.amount), fee: Number(fee) / 10 ** from.decimals, feeBps: fee > 0n ? FEES.splitBps : 0, account: acct, created: Date.now(), status: 'running', legs }
    secrets.splits = [rec, ...(secrets.splits ?? [])].slice(0, 100)
    await persist(); pushSplits()
    void oneAtATime(() => runSplit(rec, req, picks, parts, fee, src))
    return { ok: true, split: rec }
  })
  async function runSplit(rec: SplitRecord, req: SplitRequest, picks: Pick[], parts: bigint[], fee: bigint, src: Addresses) {
    const S = secrets!, m = S.mnemonic, acct = rec.account, from = ASSET[req.from]
    const keyFor = (f: any) => signingKey(m, f, acct)
    const save = async () => { if (secrets === S) { await persist(); pushSplits(); pushActivity() } }
    const dests = rec.legs.map((l) => addressesFor(l.account)!) // derived now: after a lock the cache is gone
    for (const [i, leg] of rec.legs.entries()) {
      if (secrets !== S) return // locked mid-way: nothing more is sent; the next unlock marks the rest as stopped
      // shortcut: on UTXO chains give the explorer a moment to see the last leg's change before spending it again
      if (i && ['btc', 'ltc', 'doge'].includes(networkOf(req.from).family)) await new Promise((ok) => setTimeout(ok, 4000))
      const dest = dests[i]
      leg.status = 'sending'; await save()
      try {
        const amount = legAmount(parts[i], from.decimals)
        let item: ActivityItem
        if (leg.to === req.from) {
          const r = await moveTo(req.from, parts[i], src, dest, keyFor)
          item = { id: `${from.network}:${r.txid}`, kind: 'send', asset: req.from, network: from.network, amount: leg.amountIn, fee: 0, feeAsset: networkOf(req.from).native, to: dest[networkOf(req.from).family]!, txid: r.txid, time: Date.now(), status: 'pending', account: acct, split: rec.id }
          leg.providerName = 'Direct move'; leg.expectedOut = leg.amountIn
        } else {
          const r = await swapExecute({ from: req.from, to: leg.to, amount, slippageBps: req.slippageBps, account: acct }, picks[i].provider, picks[i].minOut, src, keyFor, { dest })
          item = {
            id: `${r.network}:${r.txid}`, kind: 'swap', asset: req.from, network: r.network, amount: leg.amountIn, fee: r.route.networkFee, feeAsset: r.route.networkFeeAsset,
            to: r.route.providerName, txid: r.txid, time: Date.now(), status: 'pending', account: acct, split: rec.id,
            swap: { toAsset: leg.to, expectedOut: r.route.amountOut, minOut: r.route.minOut, provider: picks[i].provider, providerName: r.route.providerName, stage: 'pending', approveTxid: r.approveTxid, ref: r.ref }
          }
          leg.providerName = r.route.providerName; leg.expectedOut = r.route.amountOut; leg.etaSec = r.route.etaSec
        }
        leg.activityId = item.id; leg.status = 'sent'
        if (secrets === S) S.activity = [item, ...(S.activity ?? [])].slice(0, 500)
        else orphans.push({ split: rec.id, leg: i, item }) // locked while this leg was signing: kept until the next unlock
      } catch (e: any) {
        leg.status = 'failed'; leg.error = String(e?.shortMessage ?? e?.message ?? e).slice(0, 200)
      }
      await save()
    }
    // the fee only covers the legs that actually went out
    const sentPct = rec.legs.filter((l) => l.status === 'sent').reduce((s, l) => s + l.pct, 0)
    const owed = (fee * BigInt(sentPct)) / 100n
    if (owed > 0n && secrets === S) {
      const r = await collectFee(req.from, owed, src, keyFor)
      rec.feeTxid = r.txid; rec.feeError = r.error
      rec.fee = Number(owed) / 10 ** from.decimals
    } else rec.fee = 0
    rec.status = sentPct === 100 ? 'done' : sentPct ? 'partial' : 'failed'
    await save()
    if (prefs.notifications !== false && Notification.isSupported() && !win?.isFocused()) new Notification({ title: 'Astrala', body: rec.status === 'done' ? 'Your split is on its way' : 'Your split needs a look', silent: true }).show()
  }
  // ---------- route ----------
  const pushRoutes = () => toWin('routes', secrets?.routes ?? [])
  h('routes', () => secrets?.routes ?? [])
  h('routeQuote', async (req: RouteRequest) => {
    const acct = req.account ?? activeAcct()
    const addrs = addressesFor(acct)
    if (!addrs) return { ok: false, error: 'Unknown account', fee: 0, feeBps: FEES.routeBps, net: 0, hops: [], etaSec: 0 }
    return coreRouteQuote(req, addrs, await usdPrice())
  })
  h('route', async (req: RouteRequest, picks: Pick[], token?: string) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    if (decoyPin) return { ok: false, error: 'Not available right now' }
    const bad = checkRoute(req)
    if (bad) return { ok: false, error: bad }
    if (!Array.isArray(picks) || picks.length !== req.hops.length) return { ok: false, error: 'Review the route again' }
    const denied = await approved(token, { kind: 'route', req, picks })
    if (denied) return denied
    const acct = req.account ?? activeAcct()
    const hwNo = hwRefusal(acct, 'Routing'); if (hwNo) return hwNo
    const src = addressesFor(acct)
    if (!src) return { ok: false, error: 'Unknown account' }
    const from = ASSET[req.from], fam = networkOf(req.from).family
    const bps = routeFeeBps(req)
    const { fee, net } = takeFee(parseUnits(req.amount, from.decimals), bps, fam)
    const n = (secrets.routes?.length ?? 0) + 1
    const name = (String(req.name ?? '').trim() || `Route ${n}`).slice(0, 24)
    const id = randomBytes(8).toString('hex')
    // Every stop gets a wallet of its own, made here and belonging to this route. The user picks
    // where the route ENDS (req.hops[last].account, one of their own); the stops on the way are
    // staging wallets they watch rather than accounts they have to manage.
    let next = Math.max(...secrets.accounts.map((a) => a.index)) + 1
    const last = req.hops.length - 1
    const hops: RouteRecord['hops'] = req.hops.map((h, i) => {
      let account = h.account
      if (i !== last) {
        account = next++
        secrets!.accounts.push({ index: account, name: `${name} · ${ASSET[h.to].symbol}`.slice(0, 40), avatar: defaultAvatar(account), route: id })
      }
      return { from: h.from, to: h.to, amountIn: i === 0 ? Number(net) / 10 ** from.decimals : 0, account, status: 'waiting' as const, provider: picks[i]?.provider, minOut: Number(picks[i]?.minOut) || 0, pauseHere: !!h.pauseHere }
    })
    if (hops.length > 1) buildAccounts()
    const rec: RouteRecord = {
      id, name, from: req.from, amount: Number(req.amount),
      fee: Number(fee) / 10 ** from.decimals, feeBps: fee > 0n ? bps : 0, feeUnits: String(fee),
      account: acct, created: Date.now(), status: 'running', hops, slippageBps: req.slippageBps
    }
    secrets.routes = keepRoutes([rec, ...(secrets.routes ?? [])])
    await persist(); pushRoutes()
    void runRoute(rec, 0, net)
    return { ok: true, route: rec }
  })
  /** The staging wallets of one route, with what is sitting in each. Read-only: the panel in the
   *  Route screen shows these so the user can watch their coins move without hunting through accounts. */
  /** Only the last 100 routes are kept. A dropped route takes its panel with it, so hand its wallets
   *  back to the account switcher first — otherwise anything left in one is reachable from nowhere:
   *  filtered out of the switcher by its route tag, and with no route left to open. */
  function keepRoutes(all: RouteRecord[]): RouteRecord[] {
    const kept = all.slice(0, 100)
    if (kept.length === all.length) return kept
    const live = new Set(kept.map((r) => r.id))
    for (const a of secrets!.accounts) if (a.route && !live.has(a.route)) delete a.route
    buildAccounts()
    return kept
  }
  h('routeWallets', async (id: string) => {
    const rec = secrets?.routes?.find((r) => r.id === id)
    if (!rec || !secrets) return { ok: false as const, wallets: [] }
    // Nothing may be taken out while the route is still moving: a leg reads the balance it is about
    // to spend, so a withdrawal mid-flight would break the chain.
    const settled = rec.status !== 'running'
    const wallets = await Promise.all(rec.hops.map(async (h, i) => {
      const a = secrets!.accounts.find((x) => x.index === h.account)
      const addrs = addressesForAny(h.account)
      const asset = ASSET[h.to]
      const bal = addrs ? await getBalance(asset, addrs).catch(() => null) : null
      return {
        hop: i, account: h.account, name: a?.name ?? `Stop ${i + 1}`, coin: h.to,
        address: addrs?.[networkOf(h.to).family] ?? '', amount: bal?.amount ?? null,
        status: h.status, mine: !a?.route, // the last stop is one of the user's own accounts
        canWithdraw: settled && (bal?.amount ?? 0) > 0
      }
    }))
    return { ok: true as const, status: rec.status, settled, wallets }
  })
  /** Forget a failed route. Refused while any of its one-time wallets still holds coins (or can't be read),
   *  because the route's record is the only place those wallets are shown: deleting it would hide money. */
  h('deleteRoute', async (id: string) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    if (decoyPin) return { ok: false, error: 'Not available right now' }
    const rec = secrets.routes?.find((r) => r.id === id)
    if (!rec) return { ok: false, error: 'Route not found' }
    if (rec.status !== 'failed') return { ok: false, error: 'Only failed routes can be deleted' }
    const staging = rec.hops.filter((h) => secrets!.accounts.find((a) => a.index === h.account)?.route)
    const left = await Promise.all(staging.map(async (h) => {
      const addrs = addressesForAny(h.account)
      const bal = addrs ? await getBalance(ASSET[h.to], addrs).catch(() => null) : null
      return bal?.amount == null ? Infinity : bal.amount
    }))
    if (left.some((n) => n === Infinity)) return { ok: false, error: "Couldn't check this route's wallets. Try again in a moment." }
    if (left.some((n) => n > 0)) return { ok: false, error: 'Coins are still sitting in this route\'s wallets. Move them out first.' }
    secrets.routes = secrets.routes!.filter((r) => r.id !== id)
    await persist()
    pushRoutes()
    return { ok: true }
  })
  /** Move everything out of one staging wallet into an account the user owns. Refused while the route runs. */
  h('routeWithdraw', async (id: string, hop: number, toAccount: number, token?: string) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    if (decoyPin) return { ok: false, error: 'Not available right now' }
    const rec = secrets.routes?.find((r) => r.id === id)
    if (!rec) return { ok: false, error: 'Route not found' }
    if (rec.status === 'running') return { ok: false, error: 'Wait for the route to finish before moving these coins' }
    const h0 = rec.hops[hop]
    if (!h0) return { ok: false, error: 'Unknown stop' }
    if (!accountsCache.some((a) => a.index === toAccount)) return { ok: false, error: 'Pick one of your own accounts' }
    const src = addressesForAny(h0.account), dest = addressesFor(toAccount)
    if (!src || !dest) return { ok: false, error: 'Unknown account' }
    const asset = ASSET[h0.to]
    const bal = await getBalance(asset, src).catch(() => null)
    const amount = bal?.amount ?? 0
    if (!(amount > 0)) return { ok: false, error: 'Nothing left in this wallet' }
    const denied = await approved(token, { kind: 'send', req: { assetId: h0.to, to: dest[networkOf(h0.to).family]!, amount: String(amount), account: h0.account, speed: 'normal', max: true } })
    if (denied) return denied
    const keyFor = (f: any) => signingKey(secrets!.mnemonic, f, h0.account)
    try {
      const r = await moveTo(h0.to, parseUnits(String(amount), asset.decimals), src, dest, keyFor)
      return { ok: true, txid: r.txid }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 140) }
    }
  })
  h('resumeRoute', async (id: string, token?: string) => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    if (decoyPin) return { ok: false, error: 'Not available right now' }
    const rec = secrets.routes?.find((r) => r.id === id)
    if (!rec || rec.status !== 'paused') return { ok: false, error: 'Route not found or not paused' }
    if (routeRunning.has(rec.id)) return { ok: false, error: 'This route is already moving' }
    const denied = await approved(token, { kind: 'route', req: { from: rec.from, amount: String(rec.amount), hops: rec.hops.map((h) => ({ from: h.from, to: h.to, account: h.account })) }, picks: rec.hops.map((h) => ({ provider: (h.provider ?? 'thorchain') as any, minOut: h.expectedOut ?? 0 })) })
    if (denied) return denied
    const at = rec.pausedAt ?? rec.hops.findIndex((h) => h.status !== 'sent')
    if (at < 0 || at >= rec.hops.length) return { ok: false, error: 'Nothing left to do on this route' }
    rec.status = 'running'; rec.pausedAt = undefined
    for (const h of rec.hops.slice(at)) h.error = undefined
    await persist(); pushRoutes()
    void runRoute(rec, at)
    return { ok: true }
  })

  /** Routes moving right now, so Resume can't start a second runner on the same one. */
  const routeRunning = new Set<string>()
  const ROUTE_ARRIVAL_WAIT = 3 * 60 * 60_000
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
  /** What a stop keeps back for the next swap's own network fee: a swap costs more gas than a plain transfer. */
  async function stageReserve(id: string): Promise<number> {
    const a = ASSET[id], fam = networkOf(id).family, rough = await roughFee(a).catch(() => 0)
    if (fam === 'evm') return Math.max(rough * 20, 0)
    if (fam === 'btc' || fam === 'ltc') return Math.max(rough * 4, fam === 'btc' ? 0.00005 : 0.0005)
    if (fam === 'doge') return 2
    if (fam === 'sol') return 0.006
    if (fam === 'trx') return 6
    return rough * 4
  }

  /** Runs a route from step `start`. Each step after the first waits until the coins have actually reached its stop,
   *  spends what arrived (less the next network fee) from that stop's own wallet, and keeps the price limit the user
   *  accepted, scaled to what arrived. It never sits inside the payment queue while waiting, so other sends go on.
   *  A lock ends the runner quietly; the next unlock marks the route paused (settleInterruptedRoutes). */
  async function runRoute(rec: RouteRecord, start: number, firstAmount?: bigint) {
    if (routeRunning.has(rec.id)) return
    routeRunning.add(rec.id)
    const S = secrets!
    const alive = () => secrets === S && !decoyPin
    const save = async () => { if (alive()) { await persist(); pushRoutes(); pushActivity() } }
    const slip = rec.slippageBps ?? 100
    try {
      for (let i = start; i < rec.hops.length; i++) {
        if (!alive()) return
        const hop = rec.hops[i], hopFrom = ASSET[hop.from]
        const srcAcct = i === 0 ? rec.account : rec.hops[i - 1].account
        const srcAddrs = addressesForAny(srcAcct), destAddrs = addressesForAny(hop.account)
        if (!srcAddrs || !destAddrs) { hop.status = 'failed'; hop.error = 'One of this route\'s wallets is missing'; break }

        let amount: bigint
        if (i === 0 && firstAmount != null) amount = firstAmount
        else if (i === 0) { hop.status = 'failed'; hop.error = 'The first step can only run when the route starts'; break }
        else {
          // wait for the previous step's coins to land here; a cross-chain swap can take a while
          const prev = rec.hops[i - 1]
          const want = (prev.expectedOut ?? 0) * (1 - (2 * slip) / 10_000)
          hop.status = 'waiting'; hop.error = undefined; await save()
          const until = Date.now() + ROUTE_ARRIVAL_WAIT
          let have = 0
          for (;;) {
            if (!alive()) return
            const b = await getBalance(hopFrom, srcAddrs).catch(() => null)
            have = b?.amount ?? 0
            if (have > 0 && have >= want) break
            if (Date.now() > until) break
            await sleep(30_000)
          }
          if (!(have > 0 && have >= want)) {
            hop.status = 'waiting'; hop.error = have > 0 ? `Only ${have} ${hopFrom.symbol} arrived so far. Press Resume to carry on with it` : `The coins haven't reached this stop yet. If the previous swap was refunded, they went back to where it started`
            rec.status = 'paused'; rec.pausedAt = i; await save(); return
          }
          const spend = have - (await stageReserve(hop.from))
          if (!(spend > 0)) { hop.status = 'failed'; hop.error = `Too little ${hopFrom.symbol} arrived to pay the next network fee`; break }
          amount = parseUnits(spend.toFixed(hopFrom.decimals), hopFrom.decimals)
        }

        hop.amountIn = Number(amount) / 10 ** hopFrom.decimals
        hop.status = 'sending'; await save()
        try {
          const amtStr = hop.amountIn.toFixed(hopFrom.decimals).replace(/\.?0+$/, '')
          const keyFor = (f: any) => signingKey(S.mnemonic, f, srcAcct)
          let item: ActivityItem
          if (hop.from === hop.to) {
            const r = await oneAtATime(() => moveTo(hop.from, amount, srcAddrs, destAddrs, keyFor))
            item = { id: `${hopFrom.network}:${r.txid}`, kind: 'send', asset: hop.from, network: hopFrom.network, amount: hop.amountIn, fee: 0, feeAsset: networkOf(hop.from).native, to: destAddrs[networkOf(hop.from).family]!, txid: r.txid, time: Date.now(), status: 'pending', account: srcAcct }
            hop.providerName = 'Direct move'; hop.expectedOut = hop.amountIn
          } else {
            // the accepted minimum was quoted for the planned input; scale it to what really arrived
            const plannedIn = i === 0 ? hop.amountIn : (rec.hops[i - 1].minOut ?? 0) / (1 - slip / 10_000)
            const accepted = (hop.minOut ?? 0) * (plannedIn > 0 ? Math.min(1, hop.amountIn / plannedIn) : 1)
            const provider = (hop.provider ?? 'thorchain') as any
            const r = await oneAtATime(() => swapExecute({ from: hop.from, to: hop.to, amount: amtStr, slippageBps: slip, account: srcAcct }, provider, accepted, srcAddrs, keyFor, { dest: destAddrs }))
            item = { id: `${r.network}:${r.txid}`, kind: 'swap', asset: hop.from, network: r.network, amount: hop.amountIn, fee: r.route.networkFee, feeAsset: r.route.networkFeeAsset, to: r.route.providerName, txid: r.txid, time: Date.now(), status: 'pending', account: srcAcct, swap: { toAsset: hop.to, expectedOut: r.route.amountOut, minOut: r.route.minOut, provider, providerName: r.route.providerName, stage: 'pending', approveTxid: r.approveTxid, ref: r.ref } }
            hop.providerName = r.route.providerName; hop.expectedOut = r.route.amountOut; hop.etaSec = r.route.etaSec
          }
          hop.activityId = item.id; hop.status = 'sent'
          if (alive()) S.activity = [item, ...(S.activity ?? [])].slice(0, 500)
        } catch (e: any) {
          hop.status = 'failed'; hop.error = String(e?.shortMessage ?? e?.message ?? e).slice(0, 200)
          break
        }
        await save()
        if (hop.pauseHere && i < rec.hops.length - 1) { rec.status = 'paused'; rec.pausedAt = i + 1; await save(); return }
      }
      if (!alive()) return
      const failed = rec.hops.some((h) => h.status === 'failed')
      rec.status = failed ? 'failed' : 'done'
      // the route fee, once, in proportion to the steps that ran
      const sent = rec.hops.filter((h) => h.status === 'sent').length
      const fee = BigInt(rec.feeUnits ?? '0')
      if (!rec.feeCollected && fee > 0n && sent > 0) {
        rec.feeCollected = true
        const owed = (fee * BigInt(sent)) / BigInt(rec.hops.length)
        const src = addressesFor(rec.account)
        if (src) {
          const r = await oneAtATime(() => collectFee(rec.from, owed, src, (f) => signingKey(S.mnemonic, f, rec.account)))
          rec.feeTxid = r.txid; rec.feeError = r.error
        }
        rec.fee = Number(owed) / 10 ** ASSET[rec.from].decimals
      } else if (!rec.feeCollected) rec.fee = 0
      await save()
      if (prefs.notifications !== false && Notification.isSupported() && !win?.isFocused()) new Notification({ title: 'Astrala', body: rec.status === 'done' ? 'Your route is complete' : 'Your route needs a look', silent: true }).show()
    } finally {
      routeRunning.delete(rec.id)
    }
  }

  // ---------- speed up a stuck BTC/LTC payment ----------
  h('speedUp', (id: string, token?: string) => oneAtATime(async () => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    const denied = await approved(token, { kind: 'bump', req: { id } })
    if (denied) return denied
    const item = secrets.activity?.find((a) => a.id === id)
    const fam = item ? networkOf(item.asset).family : ''
    if (!item || item.kind !== 'send' || item.status !== 'pending' || (fam !== 'btc' && fam !== 'ltc')) return { ok: false, error: 'Only pending Bitcoin and Litecoin payments can be sped up' }
    const acct = item.account ?? 0, addrs = addressesFor(acct), m = secrets.mnemonic
    if (!addrs?.[fam]) return { ok: false, error: 'Unknown account' }
    try {
      const r = await bumpFee(fam, item.txid, addrs[fam]!, (f) => signingKey(m, f, acct))
      item.bumped = [...(item.bumped ?? []), item.txid]
      item.txid = r.txid; item.id = `${item.network}:${r.txid}`; item.fee = r.fee; item.time = Date.now()
      await persist(); pushActivity()
      return { ok: true, item }
    } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) } }
  }))
  // ---------- cancel a stuck BTC/LTC/EVM payment: replace it with one that pays us back ----------
  h('cancelTx', (id: string, token?: string) => oneAtATime(async () => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    const denied = await approved(token, { kind: 'cancel', req: { id } })
    if (denied) return denied
    const item = secrets.activity?.find((a) => a.id === id)
    const fam = item ? networkOf(item.asset).family : ''
    if (!item || item.kind !== 'send' || item.status !== 'pending' || item.cancel || (fam !== 'btc' && fam !== 'ltc' && fam !== 'evm')) return { ok: false, error: 'Only pending Bitcoin, Litecoin and EVM payments can be cancelled' }
    const acct = item.account ?? 0, addrs = addressesFor(acct), m = secrets.mnemonic
    if (!addrs?.[fam]) return { ok: false, error: 'Unknown account' }
    try {
      const keyFor = (f: any) => signingKey(m, f, acct)
      const r = fam === 'evm' ? await cancelEvm(item.network, item.txid, addrs.evm!, keyFor) : await cancelTx(fam, item.txid, addrs[fam]!, keyFor)
      item.cancel = { of: item.txid }
      item.bumped = [...(item.bumped ?? []), item.txid]
      item.txid = r.txid; item.id = `${item.network}:${r.txid}`; item.fee = r.fee; item.time = Date.now()
      await persist(); pushActivity()
      return { ok: true, item }
    } catch (e: any) { return { ok: false, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) } }
  }))
  // ---------- token approvals (EVM): list and revoke ----------
  h('approvals', async () => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    const evm = addressesFor(activeAcct())?.evm
    if (!evm) return { ok: false, error: 'Unknown account' }
    try { return { ok: true, scan: await scanApprovals(evm) } } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) } }
  })
  h('revokeApproval', (req: RevokeRequest, token?: string) => oneAtATime(async () => {
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    const denied = await approved(token, { kind: 'revoke', req })
    if (denied) return denied
    const acct = activeAcct(), evm = addressesFor(acct)?.evm, m = secrets.mnemonic
    if (!evm) return { ok: false, error: 'Unknown account' }
    try {
      const r = await revokeApproval({ network: String(req?.network ?? ''), token: String(req?.token ?? ''), spender: String(req?.spender ?? '') }, evm, (f) => signingKey(m, f, acct))
      return { ok: true, txid: r.txid }
    } catch (e: any) { return { ok: false, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) } }
  }))
  // ---------- look up any address: balances + history, read-only ----------
  h('lookup', async (address: string) => {
    const a = String(address ?? '').trim()
    if (!a || a.length > 120) return { ok: false, error: 'Paste an address' }
    const probe: [string, string][] = [['evm', 'eth'], ['btc', 'btc'], ['ltc', 'ltc'], ['doge', 'doge'], ['sol', 'sol'], ['trx', 'trx']]
    const fam = probe.find(([, id]) => validateAddress(id, a))?.[0]
    if (!fam) return { ok: false, error: /^[48]/.test(a) ? "Monero hides balances by design, so they can't be looked up" : "That isn't an address Astrala recognises" }
    const addrs = { [fam]: a } as Addresses
    const [balances, history] = await Promise.all([
      Promise.all(ASSETS.filter((x) => networkOf(x.id).family === fam && x.id !== 'xmr').map((x) => getBalance(x, addrs))),
      getTxHistory(addrs).catch(() => [] as HistoryItem[])
    ])
    return { ok: true, family: fam, balances, history: history.slice(0, 60) }
  })
  // ---------- CSV export (outgoing summary) ----------
  h('saveCsv', async (name: string, text: string) => {
    if (typeof text !== 'string' || text.length > 5_000_000) return { ok: false }
    const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('documents'), String(name).replace(/[^\w .-]/g, '') || 'astrala.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (r.canceled || !r.filePath) return { ok: false }
    await writeFile(r.filePath, text, { mode: 0o600 })
    return { ok: true, path: r.filePath }
  })
  h('saveImage', async (name: string, dataUrl: string) => {
    const m = typeof dataUrl === 'string' && dataUrl.length < 12_000_000 ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null
    if (!m) return { ok: false }
    const file = String(name).replace(/[^\w .-]/g, '').slice(0, 80) || 'astrala-qr.png'
    const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('downloads'), file.endsWith('.png') ? file : `${file}.png`), filters: [{ name: 'PNG image', extensions: ['png'] }] })
    if (r.canceled || !r.filePath) return { ok: false }
    await writeFile(r.filePath, Buffer.from(m[1], 'base64'))
    return { ok: true, path: r.filePath }
  })
  // ---------- updates ----------
  h('checkUpdate', () => checkUpdate())
  h('downloadUpdate', () => downloadUpdate())
  // one at a time: a second click while an update is installing gets the same run
  let installing: ReturnType<typeof installUpdate> | null = null
  h('installUpdate', () => (installing ??= installUpdate((p) => toWin('updateProgress', p)).finally(() => { installing = null })))
  // chain history (sent + received), cached ~90s per account so the Activity page opens instantly.
  // Never waits on the slowest explorer: after 6 s it answers with what has landed and pushes the rest later.
  h('txHistory', async (account: number, force?: boolean) => {
    const addrs = addressesFor(account)
    if (!addrs) { diag('[history] no addresses for account', account); return [] }
    const c = histCache.get(account)
    if (c && !force && Date.now() - c.at < 90_000) return c.items
    if (c?.p) return c.p
    const got: HistoryItem[] = [], failed: string[] = []
    const report = (src: string, r: HistoryItem[] | Error, ms: number) => {
      if (r instanceof Error) { failed.push(src); diag(`[history] ${src} FAILED in ${ms} ms: ${r.message.slice(0, 120)}`) }
      else { got.push(...r); diag(`[history] ${src} ok: ${r.length} in ${ms} ms`) }
    }
    const t0 = Date.now()
    const p = Promise.all([getTxHistory(addrs, report), account === xmrAccount ? monero.transfers().catch(() => []) : Promise.resolve([])]).then(([items, xs]) => {
      const xmrItems: HistoryItem[] = xs.map((t) => ({ id: `monero:${t.txid}:${t.direction}`, asset: 'xmr', network: 'monero', direction: t.direction, amount: t.amount, counterparty: t.address, txid: t.txid, time: t.time, status: t.confirmations > 0 ? 'confirmed' : 'pending' }))
      const all = [...items, ...xmrItems].sort((a, b) => b.time - a.time)
      histCache.set(account, { at: Date.now(), items: all })
      histHealth.set(account, { failed, at: Date.now() })
      diag(`[history] account ${account}: ${all.length} items in ${Date.now() - t0} ms${failed.length ? `, unreachable: ${failed.join(', ')}` : ''}`)
      return all
    }).finally(() => { const e = histCache.get(account); if (e) delete e.p })
    histCache.set(account, { at: c?.at ?? 0, items: c?.items ?? [], p })
    const quick = await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 6000))])
    if (quick) return quick
    p.then((items) => toWin('txHistory', account, items)).catch(() => {})
    return tidy([...got, ...(c?.items ?? [])])
  })
  h('historyHealth', (account: number) => histHealth.get(account) ?? { failed: [], at: 0 })
  // inbound radar: payments on their way here, before they confirm (one radar per account)
  h('inbound', async (account: number) => {
    const addrs = addressesFor(account)
    if (!addrs) return { flying: [], landed: [], dropped: [] }
    let r = radars.get(account)
    if (!r) radars.set(account, (r = new InboundRadar()))
    const xmr = account === xmrAccount ? await monero.transfers().catch(() => null) : null
    const s = await r.scan(addrs, xmr)
    if (s.flying.length || s.landed.length || s.dropped.length) diag(`[inbound] flying ${s.flying.map((f) => `${f.asset} ${f.amount}`).join(', ') || '-'} · landed ${s.landed.length} · dropped ${s.dropped.length}`)
    return s
  })
  h('setPrefs', async (p: Partial<Prefs>) => {
    const prevAcct = prefs.activeAccount, prevNode = prefs.xmrNode
    delete (p as Partial<Prefs>).bridgePair // main's own: the interface can't pair an extension by writing a setting
    delete (p as Partial<Prefs>).phonePair
    prefs = { ...prefs, ...p }
    await writeJson(P.prefs(), { ...prefs, v: 2 })
    if (p.route) await applyRoute(prefs.route)
    if ('screenProtect' in p) applyScreenProtect()
    if ('bridge' in p) await applyBridge()
    if ('phone' in p) await applyPhone()
    if (p.notifications === false && process.platform === 'darwin') app.dock?.setBadge('')
    if (secrets && ((p.activeAccount !== undefined && p.activeAccount !== prevAcct) || (p.xmrNode !== undefined && p.xmrNode !== prevNode))) startMonero(activeAcct())
    toWin('prefs', prefs) // the window and the extension stay in step: a theme or Hide balances changed in one shows in the other at once
    return prefs
  })
  h('enableTouchId', async (pw: string) => {
    if (!touchIdAvailable()) return false
    const file = await readJson<VaultFile>(P.vault())
    if (!file) return false
    try { await open(file, pw) } catch { return false }
    await mkdir(dir(), { recursive: true })
    await writeFile(P.touch(), safeStorage.encryptString(pw), { mode: 0o600 })
    return true
  })
  h('disableTouchId', async () => { await rm(P.touch(), { force: true }) })
  h('revealMnemonic', async (pw: string) => {
    if (decoyPin) return pw === decoyPin ? secrets?.mnemonic ?? null : null
    const file = await readJson<VaultFile>(P.vault())
    if (!file) return null
    try { return (await open(file, pw)).mnemonic } catch { return null }
  })
  h('copy', (text: string) => {
    clipboard.writeText(text)
    if (clipTimer) clearTimeout(clipTimer)
    if (prefs.clipboardClearSec > 0) {
      clipTimer = setTimeout(async () => { if ((await clipboard.readText()) === text) clipboard.clear() }, prefs.clipboardClearSec * 1000)
    }
  })
  h('paste', () => clipboard.readText())
  // macOS notification only when Astrala isn't in front; never includes coins or amounts (lock-screen privacy)
  h('notifyOs', (title: string) => {
    if (prefs.notifications === false || win?.isFocused() || !Notification.isSupported()) return
    const n = new Notification({ title: 'Astrala', body: String(title).slice(0, 60), silent: true })
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus() } toWin('go', 'activity') })
    n.show()
  })
  // Browser extension. The listener and its rules are in bridge.ts; these are the app window's side of it.
  h('phoneInfo', () => ({ on: !!prefs.phone, running: phoneRunning(), error: phoneError, paired: !!prefs.phonePair, pairedAt: prefs.phonePair?.at,
    urls: lanAddresses().map((ip) => `https://${ip}:${PHONE_PORT}`), named: `https://${localName()}:${PHONE_PORT}` }))
  h('phoneForget', async () => { delete prefs.phonePair; await writeJson(P.prefs(), { ...prefs, v: 2 }); return true })
  const bridgeNow = () => ({ on: !!prefs.bridge && bridgePort() != null, port: bridgePort(), paired: !!prefs.bridgePair, sites: Object.entries(secrets?.dapps ?? {}).map(([origin, s]) => ({ origin, ...s })).sort((a, b) => b.at - a.at) })
  h('bridgeState', () => bridgeNow())
  h('bridgeAnswer', (id: string, ok: boolean) => { bridgeAsks.get(String(id))?.(ok === true) })
  h('bridgeForget', async (origin: string | null) => {
    if (secrets?.dapps) { if (origin == null) secrets.dapps = {}; else delete secrets.dapps[String(origin)]; await persist() }
    if (origin == null) { delete prefs.bridgePair; await writeJson(P.prefs(), { ...prefs, v: 2 }) }
    return bridgeNow()
  })
  // A website's signing request, answered from the review sheet. null = refused. With a token (from verifyPin for
  // { kind: 'dapp', id }), main signs its own stored copy of the request: the page can't swap in something else.
  h('dappAnswer', (id: string, token: string | null) => oneAtATime(async () => {
    const p = dappPending.get(String(id))
    if (!p) return { ok: false, error: 'That request is no longer waiting' }
    if (token == null) { dropDapp(p.id, new RpcError(4001, 'You rejected the request in Astrala')); return { ok: true } }
    if (!secrets) return { ok: false, error: 'Wallet is locked' }
    const denied = await approved(token, { kind: 'dapp', req: { id: p.id } })
    if (denied) return denied
    clearTimeout(p.timer); p.signing = true
    const m = secrets.mnemonic, keyFor = (f: any) => signingKey(m, f, p.account)
    try {
      let result: unknown
      if (p.req.kind === 'message') result = await signDappMessage(p.req, p.from, keyFor)
      else if (p.req.kind === 'typed') result = await signDappTyped(p.req, p.from, keyFor)
      else {
        const r = await sendDappTx(p.network, p.from, p.req, keyFor)
        result = r.txid
        const sp = p.view.spend
        if (sp && secrets) { // money visibly left: it belongs in Activity and in the daily total
          const item: ActivityItem = { id: `${p.network}:${r.txid}`, kind: 'send', asset: sp.assetId, network: p.network, amount: sp.amount, fee: r.feeMax, feeAsset: NETWORKS[p.network].native, to: sp.to, txid: r.txid, time: Date.now(), status: 'pending', account: p.account }
          secrets.activity = [item, ...(secrets.activity ?? [])].slice(0, 500)
          await persist(); pushActivity()
        }
      }
      clearTimeout(p.timer); dappPending.delete(p.id); toWin('dappAsk', { id: p.id, gone: true })
      p.done(result)
      return { ok: true }
    } catch (e: any) {
      const msg = String(e?.shortMessage ?? e?.message ?? e).slice(0, 200)
      p.signing = false
      dropDapp(p.id, new RpcError(e instanceof DappError ? e.code : -32000, msg))
      return { ok: false, error: msg }
    }
  }))
  // Discord status. The rules live here, not in the renderer: the setting off, a locked wallet, the decoy wallet or a
  // missing application ID all mean nothing is sent and anything showing is cleared.
  h('discordPresence', (p: { details: string; state?: string; since?: number } | null) => {
    const d = prefs.discord, details = line(p?.details)
    if (!p || !details || !d?.on || !secrets || decoyPin || !/^\d{17,20}$/.test(d.appId ?? '')) return setPresence('', null)
    return setPresence(d.appId, { details, state: line(p.state), since: Number.isFinite(p.since) && (p.since as number) > 0 ? p.since : undefined })
  })
  h('relaunch', () => { app.relaunch(); app.exit(0) })
  h('setBadge', (n: number) => { if (process.platform === 'darwin') app.dock?.setBadge(n > 0 && prefs.notifications !== false ? String(Math.min(99, n)) : '') })
  // Windows / Linux title bar buttons (macOS uses its own traffic lights). They can only move Astrala's own window.
  h('windowControl', (a: string) => {
    if (!win || win.isDestroyed()) return { maximized: false }
    if (a === 'minimize') win.minimize()
    else if (a === 'maximize') { if (win.isFullScreen()) win.setFullScreen(false); else if (win.isMaximized()) win.unmaximize(); else win.maximize() }
    else if (a === 'close') win.close()
    return { maximized: !win.isDestroyed() && (win.isMaximized() || win.isFullScreen()) }
  })
  h('resetWallet', async (pw: string) => {
    if (decoyPin) return false
    const file = await readJson<VaultFile>(P.vault())
    if (!file) return false
    try { await open(file, pw) } catch { return false }
    await rm(P.vault(), { force: true })
    await rm(P.touch(), { force: true })
    await rm(P.pinLock(), { force: true })
    await removeDuress()
    for (const f of await readdir(dir()).catch(() => [] as string[])) if (/^xmr-.*\.bin$/.test(f)) await rm(join(dir(), f), { force: true })
    await freshAccount() // the next wallet set up here must start on its own first account
    lock()
    return true
  })
}

const crashLog = (m: string) => appendFile(join(app.getPath('userData'), 'crash.log'), `${new Date().toISOString()} ${m}\n`).catch(() => {})
app.on('child-process-gone', (_e, d) => crashLog(`${d.type} gone: ${d.reason} (exit ${d.exitCode})`))

// Screen protection: the window is excluded from screenshots, recordings and screen sharing (it shows black).
// Honest limit: on macOS 15+ some recorders built on ScreenCaptureKit can ignore this flag.
// ---------- Browser extension bridge ----------
// Questions from the extension wait here for an answer from the app window; no answer in two minutes is a no.
const bridgeAsks = new Map<string, (ok: boolean) => void>()
let askChain: Promise<unknown> = Promise.resolve()
const connectAsks = new Map<string, Promise<boolean>>()
interface DappPending { signing?: boolean; id: string; origin: string; account: number; network: string; from: string; req: DappRequest; view: DappView; done: (v: unknown) => void; fail: (e: RpcError) => void; timer: ReturnType<typeof setTimeout> }
const dappPending = new Map<string, DappPending>()
let dappBusy = false // one website request on screen at a time
function dropDapp(id: string, e: RpcError) {
  const p = dappPending.get(id)
  if (!p || p.signing) return // being signed now: it finishes and answers the site itself
  clearTimeout(p.timer); dappPending.delete(id); toWin('dappAsk', { id, gone: true }); p.fail(e)
}
async function dappSign(origin: string, site: { account: number; chainId: number }, method: string, params: unknown[]): Promise<unknown> {
  if (!secrets || !win || win.isDestroyed()) throw new RpcError(4900, 'Astrala is locked. Unlock it and try again.')
  const from = addressesFor(site.account)?.evm, network = bridgeHost.chains[site.chainId]
  if (!from || !network) throw new RpcError(4100, 'This site is connected to an account Astrala no longer shows. Disconnect it and connect again.')
  if (hwOf(site.account)) throw new RpcError(4200, 'This is a hardware-wallet account. Websites can’t ask it to sign yet: connect a regular Astrala account to this site.')
  if (dappBusy || dappPending.size) throw new RpcError(-32002, 'Astrala is already showing a request. Answer that one first.')
  dappBusy = true
  try {
    let req: DappRequest
    try { req = parseDappRequest(method, params, from, site.chainId) } catch (e) { throw e instanceof DappError ? new RpcError(e.code, e.message) : e }
    const view = describeDapp(req, { origin, network })
    if (!secrets.pay?.guardOff) {
      const why = drainBlock(view, (sp) => !!spenderName(network, sp))
      if (why) { toWin('guard', { host: hostOf(origin), why }); throw new RpcError(4001, `Astrala's Drain guard blocked this request: ${why}.`) }
    }
    let fee: string | undefined
    if (req.kind === 'tx') {
      const sym = ASSET[NETWORKS[network].native].symbol
      const p = await planDappTx(network, from, req).catch(() => null)
      // a transaction the network says would revert is never put in front of the person: there is nothing to approve
      if (p?.fails) throw new RpcError(-32000, `The network says this transaction would fail, so Astrala didn't ask you to sign it: ${p.fails}`)
      fee = p ? `Up to ${Number(p.feeMax.toPrecision(3))} ${sym}` : "Couldn't be estimated right now"
      // a single transaction that takes nearly all of the coin is worth one more look, whoever asked
      if (p && req.value > 0n && req.value * 10n >= p.balance * 9n) view.warnings.unshift({ level: 'danger', text: `This sends nearly all the ${sym} in this account. Check the address and that you meant to move everything.` })
    }
    if (!secrets || !win || win.isDestroyed()) throw new RpcError(4900, 'Astrala is locked. Unlock it and try again.')
    return await new Promise<unknown>((done, fail) => {
      const id = randomUUID()
      const timer = setTimeout(() => dropDapp(id, new RpcError(4001, 'No answer in Astrala, so the request was dropped')), 180_000)
      dappPending.set(id, { id, origin, account: site.account, network, from, req, view, done, fail, timer })
      if (win!.isMinimized()) win!.restore()
      win!.show(); win!.focus()
      toWin('dappAsk', { id, origin, account: site.account, view, fee })
    })
  } finally { dappBusy = false }
}
function askNow(q: Ask): Promise<boolean> {
  return new Promise<boolean>((done) => {
    if (!secrets || !win || win.isDestroyed()) return done(false)
    const like = q.kind === 'connect' ? lookalikeSite(hostOf(q.origin)) : null
    if (like && q.kind === 'connect' && !secrets.pay?.guardOff) { toWin('guard', { host: hostOf(q.origin), why: `its address imitates ${like}` }); throw new RpcError(4001, `Astrala's Drain guard blocked this site: its address imitates ${like}.`) }
    const id = randomUUID()
    const answer = (ok: boolean) => { clearTimeout(timer); bridgeAsks.delete(id); toWin('bridgeAsk', { id, gone: true }); done(ok) }
    const timer = setTimeout(() => answer(false), 120_000)
    bridgeAsks.set(id, answer)
    if (win.isMinimized()) win.restore()
    win.show(); win.focus()
    toWin('bridgeAsk', { id, ...q, ...(like ? { warn: `This address resembles ${like}, but it is a different site.` } : {}) })
  })
}
const bridgeHost: BridgeHost = {
  unlocked: () => !!secrets,
  pairHash: () => prefs.bridgePair?.hash ?? null,
  setPair: async (hash) => { tunnelLog.length = 0; if (hash) prefs.bridgePair = { hash, at: Date.now() }; else delete prefs.bridgePair; await writeJson(P.prefs(), { ...prefs, v: 2 }) },
  sites: () => (secrets!.dapps ??= {}),
  save: () => persist(),
  ask: (q: Ask) => {
    const key = q.kind === 'connect' ? q.origin : null
    if (key && connectAsks.has(key)) return connectAsks.get(key)!
    // queued behind whatever is on screen, so a second site's question can't replace the first under your cursor
    const run = askChain.then(() => askNow(q))
    askChain = run.catch(() => {})
    if (key) { connectAsks.set(key, run); run.finally(() => connectAsks.delete(key)).catch(() => {}) }
    return run
  },  account: () => activeAcct(),
  address: (i) => addressesFor(i)?.evm ?? null,
  chains: Object.fromEntries(Object.values(NETWORKS).filter((n) => n.family === 'evm' && n.chainId).map((n) => [n.chainId as number, n.id])),
  // the same client the app reads balances with, so a website's reads leave through Astral Route like everything else
  read: (network, method, params) => (evmClient(network) as unknown as { request(a: { method: string; params: unknown[] }): Promise<unknown> }).request({ method, params }),
  sign: dappSign,
  // locked: the guard's own setting can't be read, so it counts as on
  site: (origin) => ({ imitates: lookalikeSite(hostOf(origin)), guard: !secrets?.pay?.guardOff }),
  ipc: async (name, args) => {
    const fn = ipcHandlers.get(name)
    if (!fn || APP_ONLY.has(name)) return { denied: true }
    if (secrets) lastUse = Date.now() // the extension in use keeps the wallet open, like using the window does
    if (name === 'setPrefs') {
      const p = { ...(args[0] as Record<string, unknown>) }
      for (const k of TUNNEL_PREFS_BLOCKED) delete p[k]
      return { result: await fn(p) }
    }
    if (name === 'unlock' || name === 'unlockTouchId') {
      const wait = Math.min(300_000, tunnelUnlockFails >= 5 ? 2 ** (tunnelUnlockFails - 5) * 30_000 : 0)
      if (Date.now() - tunnelUnlockAt < wait) return { result: false }
      const ok = await fn(...args)
      tunnelUnlockAt = Date.now(); tunnelUnlockFails = ok ? 0 : tunnelUnlockFails + 1
      return { result: ok }
    }
    return { result: await fn(...args) }
  },
  events: (after) => new Promise((done) => {
    const news = () => tunnelLog.filter((e) => e.seq > after && (secrets || e.channel === 'locked'))
    // a first call (after = -1), or one from before a restart, just learns where the stream is now
    if (after < 0 || after > tunnelSeq) return done({ seq: tunnelSeq, events: [] })
    if (news().length) return done({ seq: tunnelSeq, events: news() })
    const wake = () => { clearTimeout(t); tunnelWaiting.delete(wake); done({ seq: tunnelSeq, events: news() }) }
    const t = setTimeout(wake, 25_000)
    tunnelWaiting.add(wake)
  })
}
async function applyBridge() { if (prefs.bridge) await startBridge(bridgeHost); else stopBridge() }
// the iPhone: the same tunnel with its own pairing, served over HTTPS on the local network (main/phone.ts)
const phoneHost: BridgeHost = {
  ...bridgeHost,
  pairHash: () => prefs.phonePair?.hash ?? null,
  setPair: async (hash) => { if (hash) prefs.phonePair = { hash, at: Date.now() }; else delete prefs.phonePair; await writeJson(P.prefs(), { ...prefs, v: 2 }) }
}
let phoneError = ''
async function applyPhone() {
  if (!prefs.phone) { stopPhone(); phoneError = ''; return }
  const r = await startPhone(phoneHost, join(import.meta.dirname, '../renderer'), join(dir(), 'phone-tls'))
  phoneError = r.ok ? '' : r.error ?? 'Could not start'
}

function applyScreenProtect() {
  const on = prefs.screenProtect !== false
  if (win && !win.isDestroyed()) win.setContentProtection(on)
  if (on) startShotWatch(() => toWin('screenshot'))
  else stopShotWatch()
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    // macOS keeps its traffic lights inset into our title bar. Windows and Linux get a frameless window and the
    // renderer draws matching minimize / maximize / close buttons (components/WindowControls.tsx).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 20, y: 20 } }
      : { frame: false, autoHideMenuBar: true }),
    backgroundColor: '#04030a',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      partition: UI_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })
  applyScreenProtect()
  void applyBridge()
  void applyPhone()
  const sendWinState = () => { if (win && !win.isDestroyed()) win.webContents.send('winState', { maximized: win.isMaximized() || win.isFullScreen() }) }
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as any, sendWinState)
  // Show only once React has actually drawn (the renderer says 'painted'); never a bare black frame.
  // Fallback after 8 s so a slow first launch still shows something.
  const reveal = () => { if (win && !win.isDestroyed() && !win.isVisible()) win.show() }
  ipcMain.removeAllListeners('painted')
  ipcMain.once('painted', reveal)
  setTimeout(reveal, 8000)
  // Chromium stops drawing windows it thinks are hidden; force a fresh frame whenever the window comes back.
  for (const ev of ['show', 'focus', 'restore'] as const) win.on(ev as any, () => win?.webContents.invalidate())
  // If the page ever dies (GPU/renderer crash), log it and bring it straight back instead of leaving a black window.
  let crashes = 0
  win.webContents.on('render-process-gone', (_e, d) => {
    crashLog(`renderer gone: ${d.reason} (exit ${d.exitCode})`)
    if (++crashes <= 3 && win && !win.isDestroyed()) setTimeout(() => win?.webContents.reload(), 500)
  })
  win.webContents.on('unresponsive', () => crashLog('renderer unresponsive'))
  win.webContents.on('did-fail-load', (_e, code, desc) => { crashLog(`load failed: ${code} ${desc}`); setTimeout(() => win?.webContents.reload(), 1000) })
  // Never navigate away or open windows from inside the wallet. The UI may only open block-explorer pages
  // (built from the transaction id) and the Mullvad download page in your browser. Anything else is dropped,
  // so the UI can't smuggle data out inside a link.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (externalAllowed(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Only the wallet's own page may load in this window. Any other file:// page (an HTML file dropped on the window,
  // a link to one) would replace the wallet's interface and get its preload API.
  const ownPage = pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
  win.webContents.on('will-navigate', (e, url) => {
    const devOk = !!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)
    if (!devOk && url.split(/[?#]/)[0] !== ownPage) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'), process.env.ASTRALA_PERF ? { search: 'perf=1' } : undefined)
}

const UI_PARTITION = 'astrala-ui' // in-memory: no cookies, storage or cache ever reach the disk
// What the UI window may load: its own files (and the dev server while developing). No http(s) anywhere else.
function uiRequestAllowed(url: string) {
  if (/^(file|data|blob|devtools|chrome-extension):/.test(url)) return true
  const dev = process.env.ELECTRON_RENDERER_URL
  return !!dev && (url.startsWith(dev) || /^wss?:\/\/localhost(:\d+)?\//.test(url))
}
// Links the UI may open in your browser: explorer pages for a transaction, and Mullvad's download page.
const EXTERNAL_HOSTS = new Set([...Object.values(NETWORKS).map((n) => new URL(n.explorerTx.replace('{tx}', 'x')).host), 'mullvad.net'])
function externalAllowed(url: string) {
  try { const u = new URL(url); return u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.host) && !u.search && !u.username } catch { return false }
}

app.whenReady().then(async () => {
  beat()
  if (!primary) return
  if (process.platform === 'win32') app.setAppUserModelId('com.astrala.wallet') // notifications and taskbar grouping
  const saved = (await readJson<Prefs & { v?: number }>(P.prefs())) ?? {}
  prefs = { ...DEFAULT_PREFS, ...saved }
  // Anonymous install heartbeat + live config poller. Both no-op when ops/hq-url.ts is absent
  // (the public build); the file is gitignored, so only this build sees it. The id below is a
  // one-time random blob; it is not derived from any wallet.
  if (!prefs.heartbeatId) { prefs.heartbeatId = randomUUID().replaceAll('-', ''); await writeJson(P.prefs(), { ...prefs, v: 2 }) }
  const heartbeatRun = () => hqBeat({ id: prefs.heartbeatId!, v: app.getVersion(), p: 'mac', enabled: !!prefs.heartbeat })
  setInterval(heartbeatRun, 60 * 60e3).unref() // first run waits for Astral Route, below
  // Live config — latest versions + broadcast announcements. Pulled hourly; renderer reads it over IPC.
  let liveConfig: LiveConfig | null = null
  const pollLive = async () => {
    if (!hqEnabled()) return
    const next = await hqFetchLive()
    if (!next) return // offline: keep the last rates we had
    liveConfig = next
    applyRemoteFees(next.fees)
    BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.webContents.send('live', liveConfig) }) }
  setInterval(pollLive, 10 * 60e3).unref() // fee or banner changes made in HQ reach the wallet within 10 minutes
  let lastFocusPoll = 0
  app.on('browser-window-focus', () => { if (Date.now() - lastFocusPoll > 60e3) { lastFocusPoll = Date.now(); pollLive() } })
  ipcMain.handle('liveConfig', () => liveConfig)
  ipcMain.handle('fees', () => ({ swapBps: FEES.swapBps, splitBps: FEES.splitBps, routeBps: FEES.routeBps }))
  // an automatic switch to safe graphics sticks until it's turned off in Settings
  if (safeGraphics.auto) { prefs.safeGraphics = true; await writeJson(P.prefs(), { ...prefs, v: 2 }) }
  // v2: Overkill motion is the standard for everyone (one-time reset; you can still change it in Settings).
  if ((saved as { v?: number }).v !== 2) { prefs.motion = 'overkill'; await writeJson(P.prefs(), { ...prefs, v: 2 }) }
  // The UI window runs in a memory-only session ('astrala-ui' has no "persist:" prefix): nothing it holds can be
  // written to disk. It gets no permissions, and a network wall: it can load its own bundled files and nothing else.
  // Every real request (balances, prices, swaps) is made here in the main process, through Astral Route.
  for (const ses of [session.defaultSession, session.fromPartition(UI_PARTITION)]) {
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !uiRequestAllowed(d.url) }))
  }
  setDuressPath(P.duress())
  registerIpc()
  // all wallet traffic goes through one routed session (direct / Tor / proxy, with kill switch)
  let lastSocks: string | null | undefined, lastBlocked: boolean | undefined
  initRoute({
    notify: (st) => BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.webContents.send('route', st) }),
    onSocks: (uri, blocked) => {
      if (uri === lastSocks && blocked === lastBlocked) return
      lastSocks = uri; lastBlocked = blocked
      monero.proxy = uri
      monero.blocked = blocked
      if (secrets) startMonero(xmrAccount)
    }
  })
  applyRoute(prefs.route ?? DEFAULT_PREFS.route)
  // only now: HQ requests go through net(), which follows Astral Route once initRoute has set it up
  heartbeatRun(); void pollLive()
  createWindow()
  initTray(() => { if (!win || win.isDestroyed()) createWindow(); return win }, { lock: () => lock(), go: (page) => toWin('go', page) })
  powerMonitor.on('lock-screen', lock) // macOS and Windows; Linux has no screen-lock event, only suspend below
  powerMonitor.on('suspend', lock)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else if (win && !win.isDestroyed()) { win.show(); win.webContents.invalidate() } })
})

// Closing the window locks the wallet (unless the extension is paired: then the idle auto-lock does it). macOS and Windows keep Astrala in the menu bar / notification area (tray menu
// or Ctrl+Alt+Space brings it back). Linux quits: many desktops hide tray icons, so a hidden copy could be left running.
app.on('window-all-closed', () => {
  // with the extension paired the wallet stays open for it, and the idle auto-lock above still locks it on time
  if (!(((prefs.bridge && prefs.bridgePair) || (prefs.phone && prefs.phonePair)) && prefs.autoLockMin > 0)) lock()
  if (process.platform === 'linux') app.quit()
})
app.on('before-quit', () => { lock(); stopTor(); destroyTray(); if (clipTimer) clipboard.clear() })
