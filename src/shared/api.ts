// The only surface the UI can touch. Secrets stay in the main process; the renderer gets addresses and numbers.
import type { ChainId, DerivedAddress } from '../core/derive'
import type { Balance, PriceInfo } from '../core/chain'
import type { SendRequest, Quote, Speed } from '../core/send'
import type { ActivityItem, Avatar } from '../core/vault'
import type { HistoryItem } from '../core/history'
import type { Inbound, Scan } from '../core/inbound'
import type { NetHealth, ChainProbe, ProbeState } from '../core/health'
export type { NetHealth, ChainProbe, ProbeState }
import type { AccountType } from '../core/account-types'
export type { AccountType }

import type { Contact, PriceAlert, Watched } from '../core/vault'
export type { Contact, PriceAlert, Watched }
/** a payment seen landing (balance went up / radar), kept until the chain history lists it */
export interface ArrivedItem { key: string; account: number; asset: string; amount: number; time: number; txid?: string; from?: string }
export interface VaultLists { book: Contact[]; favs: string[]; alerts: PriceAlert[]; watch: Watched[]; sky: string[]; arrived: ArrivedItem[] }
import type { CustomToken } from '../core/assets'
import type { TokenHit } from '../core/tokens'
export type { CustomToken, TokenHit }
import type { StakeAccount, Validator } from '../core/stake'
export type { StakeAccount, Validator }
import type { SwapRequest, SwapQuote, SwapRoute, Provider } from '../core/swap'
export type { SwapRequest, SwapQuote, SwapRoute, Provider }
import type { SplitRequest, SplitQuote, SplitRecord, SplitLegQuote } from '../core/split'
import type { RouteRequest, RouteQuote, RouteRecord, RouteHop } from '../core/route'
export type { RouteRequest, RouteQuote, RouteRecord, RouteHop }
export type { SplitRequest, SplitQuote, SplitRecord, SplitLegQuote }
import type { TokenApproval, ApprovalScan, RevokeRequest } from '../core/approvals'
export type { TokenApproval, ApprovalScan, RevokeRequest }
export interface Lookup { ok: boolean; error?: string; family?: string; balances?: Balance[]; history?: HistoryItem[] }
export interface UpdateInfo { current: string; latest?: string; newer: boolean; notes?: string; dmg?: string; error?: string; repo?: string }
export interface UpdateProgress { phase: 'download' | 'verify' | 'install' | 'relaunch'; pct?: number; received?: number; total?: number }
export interface UpdateResult { ok: boolean; error?: string; dryRun?: boolean; steps?: string[]; sha256?: string }
export interface FeeInfo { swapBps: number; splitBps: number; routeBps: number }
export type { ChainId, DerivedAddress, Balance, PriceInfo, SendRequest, Quote, Speed, ActivityItem, Avatar, HistoryItem, Inbound, Scan }

export interface Prefs {
  currency: string
  motion: 'overkill' | 'balanced' | 'minimal'
  sound: boolean
  ambient: boolean
  volume: number
  autoLockMin: number // 0 = never
  clipboardClearSec: number // 0 = never
  activeAccount: number
  stealth: boolean
  blurOnFocusLoss: boolean
  xmrNode: string // '' = rotate through public nodes
  route: { mode: 'direct' | 'tor' | 'proxy' | 'mullvad'; proxy: string; killSwitch: boolean }
  /** the wallet's theme (renderer/src/lib/themes.ts THEME_IDS; older saves hold 'interstellar' | 'deepfield' | 'nebula') */
  sky: string
  /** Auto: the theme follows the time of day (off by default) */
  themeAuto?: boolean
  /** an account's own theme, by account index; accounts not listed use the wallet's */
  accountThemes?: Record<string, string>
  screenProtect: boolean // black out the window in screenshots, recordings and screen sharing
  /** Opsec. All optional so older saves read as "off" (notifications: on unless false). */
  stealthOnUnlock?: boolean // every unlock starts with balances hidden
  notifications?: boolean // false: no system notifications and no Dock badge
  /** Safe graphics: Astrala doesn't use the GPU (applies at launch). true on, false off by choice, missing = automatic */
  safeGraphics?: boolean
  /** The browser extension's local door (127.0.0.1 only). Off unless true. */
  bridge?: boolean
  /** Main only: the paired extension's token hash. The interface can read it but never set it. */
  bridgePair?: { hash: string; at: number }
  /** The iPhone web app's door (HTTPS on the local network). Off unless true. */
  phone?: boolean
  /** Main only: the paired phone's token hash. */
  phonePair?: { hash: string; at: number }
  /** Discord status. Off unless `on`. `appId` is the user's own Discord application; `mode` picks what the status says. */
  discord?: { on: boolean; appId: string; mode: 'name' | 'last' | 'custom'; line1: string; line2: string }
  /** first-run tour: 'pending' after a wallet is created or restored, 'done' once seen or skipped */
  tour?: 'pending' | 'done'
  /** Help Astrala by sending an anonymous install heartbeat (id + version + platform). Default off in the public build (no HQ configured anyway); the author's build enables it after onboarding. */
  heartbeat?: boolean
  /** A random id, generated once, used only by the heartbeat. Never derived from a wallet, never shared with anyone else. */
  heartbeatId?: string
}

export const DEFAULT_PREFS: Prefs = {
  currency: 'GBP',
  motion: 'overkill',
  sound: true,
  ambient: false,
  volume: 0.6,
  autoLockMin: 15,
  clipboardClearSec: 60,
  xmrNode: '',
  route: { mode: 'direct', proxy: '', killSwitch: true },
  sky: 'interstellar',
  activeAccount: 0,
  stealth: false,
  blurOnFocusLoss: true,
  screenProtect: true,
  heartbeat: false,
  heartbeatId: '',
}

export interface BridgeState { on: boolean; port: number | null; paired: boolean; sites: { origin: string; account: number; chainId: number; at: number }[] }
/** A question from the extension, shown in the app window. `gone`: it timed out or was answered elsewhere. */
export type BridgeAsk = { id: string; gone?: boolean } & ({ kind: 'pair'; code: string; /** the asking extension's ID */ ext?: string } | { kind: 'connect'; origin: string; /** the site resembles a well-known one (shown when the Drain guard is off) */ warn?: string } | { kind?: undefined })

/** A signing request from a website, as main describes it. `gone`: answered, timed out or locked. */
export type DappAsk = { id: string; gone: true } | { id: string; gone?: false; origin: string; account: number; view: import('../core/dapp').DappView; fee?: string }

export interface AppState {
  hasVault: boolean
  unlocked: boolean
  touchIdAvailable: boolean
  touchIdEnabled: boolean
  /** a SHA-256-pinned Tor build exists for this OS and CPU */
  torAvailable?: boolean
  /** this launch runs without the GPU; auto: switched on by itself because the display froze during the last run */
  safeGraphics?: { on: boolean; auto: boolean }
  prefs: Prefs
}

export interface AccountScan { scanning: boolean; checked: number; found: number }
export interface Account {
  index: number
  name: string
  avatar: Avatar
  addresses: DerivedAddress[]
  /** the block this account's Monero scan starts from, if the user set one */
  xmrRestoreHeight?: number
  /** what the account is for: Vault, Spending, Trading or Stealth (older accounts read as Spending) */
  type: AccountType
  /** a hardware-wallet account: its keys are on the device, and it holds only the chains read from it */
  hw?: 'ledger' | 'trezor'
}

export interface RouteWallet {
  hop: number
  account: number
  name: string
  coin: string
  address: string
  amount: number | null
  status: string
  /** false for the staging wallets this route made; true for the account you chose as the end. */
  mine: boolean
  canWithdraw: boolean
}

export interface AstralaApi {
  state(): Promise<AppState>
  generateMnemonic(): Promise<string>
  validateMnemonic(m: string): Promise<boolean>
  createVault(args: { mnemonic: string; password: string; name?: string; birthday?: number }): Promise<void>
  unlock(password: string): Promise<boolean>
  unlockTouchId(): Promise<boolean>
  lock(): Promise<void>
  /** Someone is using the wallet (a window or the extension): restarts the idle auto-lock, which main keeps. */
  touchActive(): Promise<void>
  accounts(): Promise<Account[]>
  /** Hardware wallet (Ledger or Trezor): is one plugged in, and (Ledger) which app is open */
  hwStatus(vendor: 'ledger' | 'trezor'): Promise<{ supported: boolean; connected: boolean; app?: string; error?: string }>
  /** Read one chain (ETH, Bitcoin or Solana) from the device into a hardware account: a new one, or `index` to add to one */
  hwAdd(vendor: 'ledger' | 'trezor', chain: 'evm' | 'btc' | 'sol', opts?: { index?: number; account?: number; name?: string }): Promise<{ ok: boolean; error?: string; index?: number; address?: string; accounts?: Account[] }>
  /** Show this account's address on its device, to check it before receiving */
  hwVerify(index: number, chain: 'evm' | 'btc' | 'sol'): Promise<{ ok: boolean; error?: string }>
  /** The iPhone web app: is its door open, where to reach it, is a phone paired */
  phoneInfo(): Promise<{ on: boolean; running: boolean; error: string; paired: boolean; pairedAt?: number; urls: string[]; named: string }>
  phoneForget(): Promise<boolean>
  renameAccount(index: number, name: string): Promise<void>
  addAccount(opts?: { xmrRestoreHeight?: number; type?: AccountType }): Promise<Account[]>
  /** xmrRestoreHeight: a block number, or null to go back to the wallet's default. Changing it rescans that account's Monero. */
  updateAccount(index: number, patch: { name?: string; avatar?: Avatar; hidden?: boolean; xmrRestoreHeight?: number | null; type?: AccountType }): Promise<Account[]>
  randomName(): Promise<string>
  /** Find accounts from your 24 words that have on-chain history but aren't in this wallet yet. */
  scanAccounts(): Promise<{ ok: boolean; found: number; error?: string }>
  hiddenAccounts(): Promise<{ index: number; name: string; avatar: Avatar; type?: AccountType }[]>
  onAccounts(cb: (a: Account[]) => void): () => void
  onAccountScan(cb: (s: AccountScan) => void): () => void
  balances(index: number): Promise<Balance[]>
  /** The balances last seen for this account, straight from the vault — shown while the live ones load. */
  cachedBalances(index: number): Promise<Balance[]>
  /** The last prices seen for this currency (memory, then the vault), shown while fresh ones load. */
  cachedPrices(currency: string): Promise<Record<string, PriceInfo> | null>
  /** Fires per coin as its chain answers, so the interface fills in instead of waiting for the slowest. */
  onBalance(cb: (u: { account: number; balance: Balance }) => void): () => void
  prices(currency: string): Promise<Record<string, PriceInfo> | null>
  history(cg: string, currency: string, days: number): Promise<[number, number][]>
  validateAddress(assetId: string, to: string): Promise<boolean>
  quote(req: SendRequest): Promise<Quote>
  /** token: the single-use approval returned by verifyPin for this exact payment (issued only after main's own native confirmation) */
  send(req: SendRequest, token?: string): Promise<{ ok: true; item: ActivityItem } | { ok: false; error: string; auth?: boolean }>
  activity(): Promise<ActivityItem[]>
  txHistory(account: number, force?: boolean): Promise<HistoryItem[]>
  /** payments on their way to this account: in flight, just landed, or dropped since the last scan */
  inbound(account: number): Promise<Scan>
  /** which history sources failed on the last full read */
  historyHealth(account: number): Promise<{ failed: string[]; at: number }>
  /** the rest of a slow history read, pushed when it finishes */
  onTxHistory(cb: (account: number, items: HistoryItem[]) => void): () => void
  onActivity(cb: (items: ActivityItem[]) => void): () => void
  setPrefs(p: Partial<Prefs>): Promise<Prefs>
  enableTouchId(password: string): Promise<boolean>
  disableTouchId(): Promise<void>
  revealMnemonic(password: string): Promise<string | null>
  copy(text: string): Promise<void>
  paste(): Promise<string>
  notifyOs(title: string): Promise<void>
  setBadge(n: number): Promise<void>
  /** Quit and reopen Astrala (graphics settings apply at launch). */
  relaunch(): Promise<void>
  /** Browser extension: is the door open, is an extension paired, and which sites are connected. */
  bridgeState(): Promise<BridgeState>
  /** Answer a question the extension raised (pair this extension? connect this site?). */
  bridgeAnswer(id: string, ok: boolean): Promise<void>
  /** Disconnect one site, or with null unpair the extension and disconnect every site. */
  bridgeForget(origin: string | null): Promise<BridgeState>
  onBridgeAsk(cb: (q: BridgeAsk) => void): () => void
  /** A website's signing request to review. Answer with the PIN approval token to sign it, or null to refuse. */
  onDappAsk(cb: (q: DappAsk) => void): () => void
  dappAnswer(id: string, token: string | null): Promise<{ ok: boolean; error?: string; auth?: boolean }>
  /** What to show on Discord, or null for nothing. Main decides whether anything is sent at all (the setting, lock, decoy). */
  discordPresence(p: { details: string; state?: string; since?: number } | null): Promise<'off' | 'on' | 'waiting'>
  /** process.platform of the main process ('darwin' | 'win32' | 'linux'), a plain value with no powers */
  readonly platform: string
  /** Windows / Linux title bar buttons: only ever moves Astrala's own window */
  windowControl(a: 'minimize' | 'maximize' | 'close'): Promise<{ maximized: boolean }>
  onWindowState(cb: (s: { maximized: boolean }) => void): () => void
  resetWallet(password: string): Promise<boolean>
  onLocked(cb: () => void): () => void
  /** settings changed somewhere else (the other window, or the extension) */
  onPrefs(cb: (p: Prefs) => void): () => void
  xmrStatus(): Promise<XmrStatus>
  xmrReceive(forceNew?: boolean): Promise<string>
  xmrRescan(): Promise<void>
  swapQuote(req: SwapRequest): Promise<SwapQuote>
  swap(req: SwapRequest, provider: Provider, minOut: number, token?: string): Promise<{ ok: boolean; error?: string; auth?: boolean; item?: ActivityItem }>
  payStatus(): Promise<PayStatus>
  payCheck(intent: PayIntent): Promise<{ pinSet: boolean; lockedUntil?: number; overLimit?: OverLimit }>
  setPin(args: { pin: string; password: string }): Promise<{ ok: boolean; error?: string }>
  verifyPin(pin: string, intent: PayIntent, override?: boolean): Promise<PinResult & { token?: string; overLimit?: OverLimit }>
  setLimit(args: { amount: number | null; pin: string }): Promise<PinResult>
  /** Main's native confirmation (Touch ID / OS dialog) before every payment. Turning it off needs the PIN and one more native confirm. */
  setConfirmNative(args: { on: boolean; pin?: string }): Promise<PinResult>
  /** Drain guard on or off. On is free; off needs the payment PIN and main's own confirmation. */
  setDrainGuard(args: { on: boolean; pin?: string }): Promise<PinResult>
  /** The guard refused something a website asked for. */
  onGuard(cb: (g: { host: string; why: string }) => void): () => void
  onScreenshot(cb: () => void): () => void
  xmrTestNode(uri: string): Promise<number | null>
  routeStatus(): Promise<RouteStatus>
  /** Status panel: time one cheap height read per chain through Astral Route (nothing is sent while the kill switch holds). Call only while the panel is open. */
  netHealth(): Promise<NetHealth>
  mullvadStatus(): Promise<MullvadStatus>
  mullvadRelays(): Promise<MullvadCountry[]>
  mullvadControl(action: 'connect' | 'disconnect' | 'location', country?: string, city?: string): Promise<{ ok: boolean; error?: string; status?: MullvadStatus }>
  mullvadCheck(): Promise<{ mullvad: boolean; ip?: string; country?: string; city?: string; relay?: string } | null>
  stakeInfo(): Promise<{ accounts: StakeAccount[]; epoch: number; epochProgress: number } | null>
  validators(): Promise<Validator[]>
  stakeAction(a: { kind: 'stake' | 'unstake' | 'withdraw'; amount?: number; vote?: string; account?: string }, password?: string): Promise<{ ok: boolean; error?: string; auth?: boolean; txid?: string }>
  exportBackup(a: { password: string; backupPassword: string }): Promise<{ ok: boolean; error?: string; path?: string }>
  pickBackup(): Promise<{ name: string; data: string } | null>
  restoreBackup(a: { data: string; backupPassword: string; password: string }): Promise<{ ok: boolean; error?: string }>
  splitShares(password: string): Promise<string[] | null>
  joinShares(shares: string[]): Promise<string | null>
  validShare(share: string): Promise<boolean>
  getData<K extends keyof VaultLists>(key: K): Promise<VaultLists[K]>
  setData<K extends keyof VaultLists>(key: K, value: VaultLists[K]): Promise<boolean>
  watchBalances(family: string, address: string): Promise<Balance[]>
  tokens(): Promise<CustomToken[]>
  tokenSearch(q: string): Promise<TokenHit[]>
  tokenAdd(t: { network: string; contract: string; cg?: string; logo?: string }): Promise<{ ok: true; tokens: CustomToken[] } | { ok: false; error: string }>
  tokenRemove(id: string): Promise<CustomToken[]>
  traySummary(t: { locked: boolean; stealth: boolean; total: string; lines: { label: string; value: string }[] }): Promise<void>
  onGo(cb: (page: string) => void): () => void
  duressStatus(): Promise<{ enabled: boolean; vault?: Partial<Record<string, string>> }>
  duressNewVault(): Promise<string | null>
  duressSetup(args: { pin: string; password: string; vaultMnemonic: string }): Promise<{ ok: boolean; error?: string; vault?: Partial<Record<string, string>> }>
  duressDisable(password: string): Promise<boolean>
  torCheck(): Promise<{ isTor: boolean } | null>
  onRoute(cb: (s: RouteStatus) => void): () => void
  splitQuote(req: SplitRequest): Promise<SplitQuote>
  /** Astrala's current fee rates (basis points). */
  fees(): Promise<FeeInfo>
  split(req: SplitRequest, picks: { provider: Provider; minOut: number }[], token?: string): Promise<{ ok: boolean; error?: string; auth?: boolean; split?: SplitRecord }>
  splits(): Promise<SplitRecord[]>
  onSplits(cb: (s: SplitRecord[]) => void): () => void
  routeQuote(req: RouteRequest): Promise<RouteQuote>
  route(req: RouteRequest, picks: { provider: Provider; minOut: number }[], token?: string): Promise<{ ok: boolean; error?: string; auth?: boolean; route?: RouteRecord }>
  routes(): Promise<RouteRecord[]>
  /** Delete a failed route. Refused while any of its wallets still holds coins. */
  deleteRoute(id: string): Promise<{ ok: boolean; error?: string }>
  /** The staging wallets of one route and what is sitting in each. Read-only. */
  routeWallets(id: string): Promise<{ ok: boolean; status?: RouteRecord['status']; settled?: boolean; wallets: RouteWallet[] }>
  /** Empty one staging wallet into an account you own. Refused while the route is still running. */
  routeWithdraw(id: string, hop: number, toAccount: number, token?: string): Promise<{ ok: boolean; error?: string; auth?: boolean; txid?: string }>
  onRoutes(cb: (r: RouteRecord[]) => void): () => void
  resumeRoute(id: string, token?: string): Promise<{ ok: boolean; error?: string; auth?: boolean }>
  speedUp(id: string, token?: string): Promise<{ ok: boolean; error?: string; auth?: boolean; item?: ActivityItem }>
  /** Replace a pending BTC/LTC/EVM payment with one that pays everything back to us at a higher fee. token: from verifyPin for { kind: 'cancel' } */
  cancelTx(id: string, token?: string): Promise<{ ok: boolean; error?: string; auth?: boolean; item?: ActivityItem }>
  /** Non-zero ERC-20 allowances the active account has granted, on every EVM network (read-only scan). */
  approvals(): Promise<{ ok: boolean; error?: string; scan?: ApprovalScan }>
  /** approve(spender, 0), signed in main. token: from verifyPin for { kind: 'revoke' } */
  revokeApproval(req: RevokeRequest, token?: string): Promise<{ ok: boolean; error?: string; auth?: boolean; txid?: string }>
  lookup(address: string): Promise<Lookup>
  saveCsv(name: string, text: string): Promise<{ ok: boolean; path?: string }>
  /** Save a PNG (data: URL) the user asked for, through the system save dialog. */
  saveImage(name: string, dataUrl: string): Promise<{ ok: boolean; path?: string }>
  checkUpdate(): Promise<UpdateInfo>
  downloadUpdate(): Promise<{ ok: boolean; path?: string; sha256?: string; error?: string }>
  /** Download this OS's installer through Astral Route, verify it against SHA256SUMS, swap it in and relaunch. Nothing changes on any failure. */
  installUpdate(): Promise<UpdateResult>
  onUpdateProgress(cb: (p: UpdateProgress) => void): () => void
  onXmr(cb: (s: XmrStatus) => void): () => void
}

declare global {
  interface Window { astrala: AstralaApi }
}

export interface XmrStatus { state: 'idle' | 'connecting' | 'syncing' | 'synced' | 'offline'; percent: number; height: number; startHeight?: number; daemonHeight: number; node: string; error?: string; changed?: boolean }
export interface MullvadRoute { connected: boolean; country?: string; city?: string; ip?: string; relay?: string; verified?: boolean }
export interface RouteStatus { mode: 'direct' | 'tor' | 'proxy' | 'mullvad'; state: 'off' | 'downloading' | 'starting' | 'ready' | 'error'; percent: number; detail?: string; socks?: string; mullvad?: MullvadRoute }
export interface MullvadStatus { installed: boolean; state: 'connected' | 'connecting' | 'disconnected' | 'blocked' | 'error' | 'unknown'; relay?: string; country?: string; city?: string; ip?: string; detail?: string }
export interface MullvadCountry { code: string; name: string; cities: { code: string; name: string; relays: number }[] }

export type PayIntent = { kind: 'send'; req: SendRequest } | { kind: 'swap'; req: SwapRequest; provider: Provider; minOut: number } | { kind: 'route'; req: RouteRequest; picks: { provider: Provider; minOut: number }[] }
  | { kind: 'split'; req: SplitRequest; picks: { provider: Provider; minOut: number }[] } | { kind: 'bump'; req: { id: string } }
  | { kind: 'cancel'; req: { id: string } } | { kind: 'revoke'; req: RevokeRequest } | { kind: 'dapp'; req: { id: string } }
export interface OverLimit { limit: number; spent: number; amount: number; currency: string }
export interface PinResult { ok: boolean; error?: string; remaining?: number; lockedUntil?: number; appLocked?: boolean; needSetup?: boolean }
export interface PayStatus { pinSet: boolean; lockedUntil?: number; limit?: { amount: number; currency: string }; spent?: number; confirmNative?: boolean; /** Drain guard: on unless turned off with the PIN */ drainGuard?: boolean }
