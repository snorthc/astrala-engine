import { contextBridge, ipcRenderer } from 'electron'
import type { AstralaApi } from '../shared/api'

const call = (ch: string) => (...a: unknown[]) => ipcRenderer.invoke(ch, ...a)

const api: AstralaApi = {
  state: call('state') as AstralaApi['state'],
  generateMnemonic: call('generateMnemonic') as AstralaApi['generateMnemonic'],
  validateMnemonic: call('validateMnemonic') as AstralaApi['validateMnemonic'],
  createVault: call('createVault') as AstralaApi['createVault'],
  unlock: call('unlock') as AstralaApi['unlock'],
  unlockTouchId: call('unlockTouchId') as AstralaApi['unlockTouchId'],
  lock: call('lock') as AstralaApi['lock'],
  touchActive: call('touchActive') as AstralaApi['touchActive'],
  accounts: call('accounts') as AstralaApi['accounts'],
  hwStatus: call('hwStatus') as AstralaApi['hwStatus'],
  hwAdd: call('hwAdd') as AstralaApi['hwAdd'],
  hwVerify: call('hwVerify') as AstralaApi['hwVerify'],
  phoneInfo: call('phoneInfo') as AstralaApi['phoneInfo'],
  phoneForget: call('phoneForget') as AstralaApi['phoneForget'],
  renameAccount: call('renameAccount') as AstralaApi['renameAccount'],
  addAccount: call('addAccount') as AstralaApi['addAccount'],
  updateAccount: call('updateAccount') as AstralaApi['updateAccount'],
  randomName: call('randomName') as AstralaApi['randomName'],
  balances: call('balances') as AstralaApi['balances'],
  prices: call('prices') as AstralaApi['prices'],
  history: call('history') as AstralaApi['history'],
  setPrefs: call('setPrefs') as AstralaApi['setPrefs'],
  enableTouchId: call('enableTouchId') as AstralaApi['enableTouchId'],
  disableTouchId: call('disableTouchId') as AstralaApi['disableTouchId'],
  revealMnemonic: call('revealMnemonic') as AstralaApi['revealMnemonic'],
  validateAddress: call('validateAddress') as AstralaApi['validateAddress'],
  quote: call('quote') as AstralaApi['quote'],
  send: call('send') as AstralaApi['send'],
  activity: call('activity') as AstralaApi['activity'],
  txHistory: call('txHistory') as AstralaApi['txHistory'],
  inbound: call('inbound') as AstralaApi['inbound'],
  historyHealth: call('historyHealth') as AstralaApi['historyHealth'],
  onTxHistory: (cb) => {
    const l = (_e: unknown, account: number, items: any) => cb(account, items)
    ipcRenderer.on('txHistory', l)
    return () => ipcRenderer.removeListener('txHistory', l)
  },
  onActivity: (cb) => {
    const l = (_e: unknown, items: any) => cb(items)
    ipcRenderer.on('activity', l)
    return () => ipcRenderer.removeListener('activity', l)
  },
  paste: call('paste') as AstralaApi['paste'],
  notifyOs: call('notifyOs') as AstralaApi['notifyOs'],
  setBadge: call('setBadge') as AstralaApi['setBadge'],
  relaunch: call('relaunch') as AstralaApi['relaunch'],
  discordPresence: call('discordPresence') as AstralaApi['discordPresence'],
  bridgeState: call('bridgeState') as AstralaApi['bridgeState'],
  bridgeAnswer: call('bridgeAnswer') as AstralaApi['bridgeAnswer'],
  bridgeForget: call('bridgeForget') as AstralaApi['bridgeForget'],
  dappAnswer: call('dappAnswer') as AstralaApi['dappAnswer'],
  onDappAsk: (cb) => {
    const l = (_e: unknown, q: any) => cb(q)
    ipcRenderer.on('dappAsk', l)
    return () => ipcRenderer.removeListener('dappAsk', l)
  },
  onBridgeAsk: (cb) => {
    const l = (_e: unknown, q: any) => cb(q)
    ipcRenderer.on('bridgeAsk', l)
    return () => ipcRenderer.removeListener('bridgeAsk', l)
  },
  platform: process.platform,
  windowControl: call('windowControl') as AstralaApi['windowControl'],
  onWindowState: (cb) => {
    const l = (_e: unknown, s: { maximized: boolean }) => cb({ maximized: !!s?.maximized })
    ipcRenderer.on('winState', l)
    return () => ipcRenderer.removeListener('winState', l)
  },
  copy: call('copy') as AstralaApi['copy'],
  resetWallet: call('resetWallet') as AstralaApi['resetWallet'],
  xmrStatus: call('xmrStatus') as AstralaApi['xmrStatus'],
  xmrReceive: call('xmrReceive') as AstralaApi['xmrReceive'],
  xmrRescan: call('xmrRescan') as AstralaApi['xmrRescan'],
  swapQuote: call('swapQuote') as AstralaApi['swapQuote'],
  splitQuote: call('splitQuote') as AstralaApi['splitQuote'],
  fees: call('fees') as AstralaApi['fees'],
  split: call('split') as AstralaApi['split'],
  splits: call('splits') as AstralaApi['splits'],
  onSplits: (cb) => {
    const l = (_e: unknown, s: any) => cb(s)
    ipcRenderer.on('splits', l)
    return () => ipcRenderer.removeListener('splits', l)
  },
  routeQuote: call('routeQuote') as AstralaApi['routeQuote'],
  route: call('route') as AstralaApi['route'],
  routes: call('routes') as AstralaApi['routes'],
  resumeRoute: call('resumeRoute') as AstralaApi['resumeRoute'],
  deleteRoute: call('deleteRoute') as AstralaApi['deleteRoute'],
  onRoutes: (cb) => {
    const l = (_e: unknown, r: any) => cb(r)
    ipcRenderer.on('routes', l)
    return () => ipcRenderer.removeListener('routes', l)
  },
  scanAccounts: call('scanAccounts') as AstralaApi['scanAccounts'],
  hiddenAccounts: call('hiddenAccounts') as AstralaApi['hiddenAccounts'],
  cachedBalances: call('cachedBalances') as AstralaApi['cachedBalances'],
  cachedPrices: call('cachedPrices') as AstralaApi['cachedPrices'],
  routeWallets: call('routeWallets') as AstralaApi['routeWallets'],
  routeWithdraw: call('routeWithdraw') as AstralaApi['routeWithdraw'],
  onBalance: (cb) => {
    const l = (_e: unknown, u: any) => cb(u)
    ipcRenderer.on('balance', l)
    return () => ipcRenderer.removeListener('balance', l)
  },
  onAccounts: (cb) => {
    const l = (_e: unknown, a: any) => cb(a)
    ipcRenderer.on('accounts', l)
    return () => ipcRenderer.removeListener('accounts', l)
  },
  onAccountScan: (cb) => {
    const l = (_e: unknown, s: any) => cb(s)
    ipcRenderer.on('accountScan', l)
    return () => ipcRenderer.removeListener('accountScan', l)
  },
  speedUp: call('speedUp') as AstralaApi['speedUp'],
  cancelTx: call('cancelTx') as AstralaApi['cancelTx'],
  approvals: call('approvals') as AstralaApi['approvals'],
  revokeApproval: call('revokeApproval') as AstralaApi['revokeApproval'],
  lookup: call('lookup') as AstralaApi['lookup'],
  saveCsv: call('saveCsv') as AstralaApi['saveCsv'],
  saveImage: call('saveImage') as AstralaApi['saveImage'],
  checkUpdate: call('checkUpdate') as AstralaApi['checkUpdate'],
  downloadUpdate: call('downloadUpdate') as AstralaApi['downloadUpdate'],
  installUpdate: call('installUpdate') as AstralaApi['installUpdate'],
  onUpdateProgress: (cb) => {
    const l = (_e: unknown, p: any) => cb(p)
    ipcRenderer.on('updateProgress', l)
    return () => ipcRenderer.removeListener('updateProgress', l)
  },
  routeStatus: call('routeStatus') as AstralaApi['routeStatus'],
  netHealth: call('netHealth') as AstralaApi['netHealth'],
  mullvadStatus: call('mullvadStatus') as AstralaApi['mullvadStatus'],
  mullvadRelays: call('mullvadRelays') as AstralaApi['mullvadRelays'],
  mullvadControl: call('mullvadControl') as AstralaApi['mullvadControl'],
  mullvadCheck: call('mullvadCheck') as AstralaApi['mullvadCheck'],
  stakeInfo: call('stakeInfo') as AstralaApi['stakeInfo'],
  validators: call('validators') as AstralaApi['validators'],
  stakeAction: call('stakeAction') as AstralaApi['stakeAction'],
  payStatus: call('payStatus') as AstralaApi['payStatus'],
  payCheck: call('payCheck') as AstralaApi['payCheck'],
  setPin: call('setPin') as AstralaApi['setPin'],
  verifyPin: call('verifyPin') as AstralaApi['verifyPin'],
  setLimit: call('setLimit') as AstralaApi['setLimit'],
  setConfirmNative: call('setConfirmNative') as AstralaApi['setConfirmNative'],
  setDrainGuard: call('setDrainGuard') as AstralaApi['setDrainGuard'],
  onGuard: (cb) => {
    const l = (_e: unknown, g: any) => cb(g)
    ipcRenderer.on('guard', l)
    return () => ipcRenderer.removeListener('guard', l)
  },
  onScreenshot: (cb) => {
    const l = () => cb()
    ipcRenderer.on('screenshot', l)
    return () => ipcRenderer.removeListener('screenshot', l)
  },
  exportBackup: call('exportBackup') as AstralaApi['exportBackup'],
  pickBackup: call('pickBackup') as AstralaApi['pickBackup'],
  restoreBackup: call('restoreBackup') as AstralaApi['restoreBackup'],
  splitShares: call('splitShares') as AstralaApi['splitShares'],
  joinShares: call('joinShares') as AstralaApi['joinShares'],
  validShare: call('validShare') as AstralaApi['validShare'],
  getData: call('getData') as AstralaApi['getData'],
  setData: call('setData') as AstralaApi['setData'],
  watchBalances: call('watchBalances') as AstralaApi['watchBalances'],
  tokens: call('tokens') as AstralaApi['tokens'],
  tokenSearch: call('tokenSearch') as AstralaApi['tokenSearch'],
  tokenAdd: call('tokenAdd') as AstralaApi['tokenAdd'],
  tokenRemove: call('tokenRemove') as AstralaApi['tokenRemove'],
  traySummary: call('traySummary') as AstralaApi['traySummary'],
  onGo: (cb) => {
    const l = (_e: unknown, p: string) => cb(p)
    ipcRenderer.on('go', l)
    return () => ipcRenderer.removeListener('go', l)
  },
  duressStatus: call('duressStatus') as AstralaApi['duressStatus'],
  duressNewVault: call('duressNewVault') as AstralaApi['duressNewVault'],
  duressSetup: call('duressSetup') as AstralaApi['duressSetup'],
  duressDisable: call('duressDisable') as AstralaApi['duressDisable'],
  torCheck: call('torCheck') as AstralaApi['torCheck'],
  onRoute: (cb) => {
    const l = (_e: unknown, s: any) => cb(s)
    ipcRenderer.on('route', l)
    return () => ipcRenderer.removeListener('route', l)
  },
  swap: call('swap') as AstralaApi['swap'],
  xmrTestNode: call('xmrTestNode') as AstralaApi['xmrTestNode'],
  onXmr: (cb) => {
    const l = (_e: unknown, s: any) => cb(s)
    ipcRenderer.on('xmr', l)
    return () => ipcRenderer.removeListener('xmr', l)
  },
  onPrefs: (cb) => {
    const l = (_e: unknown, p: any) => cb(p)
    ipcRenderer.on('prefs', l)
    return () => ipcRenderer.removeListener('prefs', l)
  },
  onLocked: (cb) => {
    const l = () => cb()
    ipcRenderer.on('locked', l)
    return () => ipcRenderer.removeListener('locked', l)
  }
}

contextBridge.exposeInMainWorld('astrala', api)
// tell main the first real frame is on screen (two frames after React mounts)
contextBridge.exposeInMainWorld('__painted', () => ipcRenderer.send('painted'))
