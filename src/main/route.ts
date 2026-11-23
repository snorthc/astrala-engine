// Astral Route: every network request from the wallet goes through one Chromium session whose proxy we control.
//   direct  → straight out
//   tor     → bundled Tor (downloaded once, signature-pinned by SHA-256), SOCKS5 with remote DNS
//   proxy   → your own SOCKS5 / HTTP proxy
//   mullvad → the Mullvad VPN app: traffic goes through its in-tunnel SOCKS5 (10.64.0.1:1080), which only exists while
//             the tunnel is up, so a dropped VPN can never leak your real IP
// Kill switch: while the route is down, requests go to a dead end instead of leaking out directly.
import { app, session, type Session } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { setFetcher } from '../core/chain'
import { startSocksBridge } from './socks-bridge'
import { mullvadStatus, type MullvadStatus } from './mullvad'
import { TOR_VERSION, TOR_BUNDLES } from './tor-bundles'
export { torSupported } from './tor-bundles'

export type RouteMode = 'direct' | 'tor' | 'proxy' | 'mullvad'
export interface RoutePrefs { mode: RouteMode; proxy: string; killSwitch: boolean }
export interface MullvadRoute { connected: boolean; country?: string; city?: string; ip?: string; relay?: string; verified?: boolean }
export interface RouteStatus { mode: RouteMode; state: 'off' | 'downloading' | 'starting' | 'ready' | 'error'; percent: number; detail?: string; socks?: string; mullvad?: MullvadRoute }

const TOR_MIRRORS = ['https://archive.torproject.org/tor-package-archive/torbrowser', 'https://dist.torproject.org/torbrowser']
const DEAD_END = 'socks5://127.0.0.1:9' // nothing listens here: requests fail instead of leaking
const MULLVAD_SOCKS = 'socks5://10.64.0.1:1080' // Mullvad's proxy inside the tunnel

let ses: Session
let current: RoutePrefs = { mode: 'direct', proxy: '', killSwitch: true }
let status: RouteStatus = { mode: 'direct', state: 'ready', percent: 100 }
let tor: ChildProcess | null = null
let bridge: { port: number; close: () => void } | null = null
let torPort = 0
let gen = 0
let notify: (s: RouteStatus) => void = () => {}
let onSocks: (uri: string | null, blocked: boolean) => void = () => {}
let watch: ReturnType<typeof setInterval> | null = null

const set = (p: Partial<RouteStatus>) => { status = { ...status, ...p }; notify(status) }
export const routeStatus = () => status

/** Called once after app ready. All wallet traffic flows through this session from now on. */
export function initRoute(opts: { notify: (s: RouteStatus) => void; onSocks: (uri: string | null, blocked: boolean) => void }) {
  notify = opts.notify
  onSocks = opts.onSocks
  ses = session.fromPartition('astrala-net', { cache: false })
  // same bland agent and language for every request, so nothing about this computer's locale or OS goes out
  ses.setUserAgent('Mozilla/5.0', 'en')
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = { ...d.requestHeaders }
    for (const k of Object.keys(h)) if (/^(sec-ch-|sec-fetch-|referer$|origin$|dnt$|x-client-data$)/i.test(k)) delete h[k]
    cb({ requestHeaders: h })
  })
  setFetcher(async (url, init) => {
    // on a private route, requests leave at slightly random times so polling can't be lined up against other traffic
    if (current.mode !== 'direct') await new Promise((ok) => setTimeout(ok, Math.random() * 350))
    return ses.fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(25000) } as any) as unknown as Promise<Response>
  })
}

export async function applyRoute(p: RoutePrefs) {
  const g = ++gen
  current = { ...p }
  if (p.mode !== 'tor') stopTor()
  if (watch) { clearInterval(watch); watch = null }
  if (bridge) { bridge.close(); bridge = null }
  if (p.mode === 'direct') {
    await ses.setProxy({ mode: 'direct' })
    await ses.closeAllConnections()
    onSocks(null, false)
    set({ mode: 'direct', state: 'ready', percent: 100, detail: undefined, socks: undefined, mullvad: undefined })
    return
  }
  set({ mode: p.mode, state: 'starting', percent: 0, detail: undefined, socks: undefined, mullvad: undefined })
  // block first, so nothing slips out while the route comes up; the caller can await just this part
  const hold = p.killSwitch || p.mode === 'mullvad'
  if (hold) await ses.setProxy({ proxyRules: DEAD_END })
  await ses.closeAllConnections()
  onSocks(null, hold)
  void (p.mode === 'mullvad' ? connectMullvad(g) : connect(p, g))
}

// ---------- Mullvad ----------
const mv = (s: MullvadStatus, verified?: boolean): MullvadRoute => ({ connected: s.state === 'connected', country: s.country, city: s.city, ip: s.ip, relay: s.relay, verified })

async function connectMullvad(g: number) {
  const s = await mullvadStatus()
  if (g !== gen) return
  if (!s.installed) { set({ state: 'error', percent: 0, detail: 'Mullvad VPN is not installed. All traffic is held.' }); return }
  if (s.state !== 'connected') {
    set({ state: 'starting', percent: 20, detail: s.state === 'connecting' ? 'Mullvad is connecting…' : 'Connect Mullvad to go online. All traffic is held.', mullvad: mv(s) })
    startWatch(g, false)
    return
  }
  // no direct:// fallback: if the tunnel drops, 10.64.0.1 vanishes and requests simply fail
  await ses.setProxy({ proxyRules: MULLVAD_SOCKS })
  await ses.closeAllConnections()
  set({ state: 'starting', percent: 70, detail: 'Checking the Mullvad exit', socks: MULLVAD_SOCKS, mullvad: mv(s) })
  const c = await mullvadCheck()
  if (g !== gen) return
  if (!c) {
    await ses.setProxy({ proxyRules: DEAD_END })
    onSocks(null, true)
    set({ state: 'error', percent: 0, detail: 'Mullvad is up but its proxy did not answer. All traffic is held.', socks: undefined, mullvad: mv(s, false) })
    startWatch(g, false)
    return
  }
  onSocks(MULLVAD_SOCKS, false)
  set({ state: 'ready', percent: 100, detail: undefined, mullvad: { ...mv(s, c.mullvad), ip: c.ip ?? s.ip, country: c.country ?? s.country, city: c.city ?? s.city, relay: c.relay ?? s.relay } })
  startWatch(g, true)
}

/** Every 5 s while in Mullvad mode: hold traffic the moment the tunnel drops, resume when it's back. */
function startWatch(g: number, up: boolean) {
  if (watch) clearInterval(watch)
  let busy = false
  watch = setInterval(async () => {
    if (busy || g !== gen) return
    busy = true
    try {
      const s = await mullvadStatus()
      if (g !== gen) return
      const now = s.state === 'connected'
      if (up && !now) {
        up = false
        await ses.setProxy({ proxyRules: DEAD_END })
        await ses.closeAllConnections()
        onSocks(null, true)
        set({ state: 'error', percent: 0, detail: 'Mullvad disconnected. All traffic is held until it reconnects.', socks: undefined, mullvad: mv(s) })
      } else if (!up && now) {
        clearInterval(watch!); watch = null
        await connectMullvad(g)
      } else if (!now) set({ mullvad: mv(s), detail: s.state === 'connecting' ? 'Mullvad is connecting…' : status.detail })
      else if (s.relay !== status.mullvad?.relay) set({ mullvad: { ...mv(s, status.mullvad?.verified), ip: s.ip ?? status.mullvad?.ip } }) // switched server
    } finally { busy = false }
  }, 5000)
}

/** Asks Mullvad's own checker (through the current route) whether traffic exits via Mullvad. */
export async function mullvadCheck(): Promise<{ mullvad: boolean; ip?: string; country?: string; city?: string; relay?: string } | null> {
  try {
    const r = await ses.fetch('https://am.i.mullvad.net/json', { signal: AbortSignal.timeout(15000) } as any)
    const j: any = await r.json()
    return { mullvad: !!j.mullvad_exit_ip, ip: j.ip, country: j.country, city: j.city, relay: j.mullvad_exit_ip_hostname }
  } catch { return null }
}

async function connect(p: RoutePrefs, g: number) {
  if (p.mode === 'proxy') {
    const u = parseProxy(p.proxy)
    if (!u) { set({ mode: 'proxy', state: 'error', percent: 0, detail: 'Enter a proxy like socks5://10.64.0.1:1080' }); return }
    await ses.setProxy({ proxyRules: p.killSwitch ? u : `${u},direct://` })
    await ses.closeAllConnections()
    set({ mode: 'proxy', state: 'starting', percent: 50, detail: 'Checking the proxy', socks: u.startsWith('socks') ? u : undefined })
    const ok = await probe()
    if (g !== gen) return
    let moneroSocks: string | null = u.startsWith('socks') ? u : null
    if (!moneroSocks && u.startsWith('http:')) {
      try { bridge = await startSocksBridge(u); moneroSocks = `socks5://127.0.0.1:${bridge.port}` } catch { /* Monero stays blocked/direct */ }
    }
    if (g !== gen) return
    onSocks(moneroSocks, p.killSwitch && !moneroSocks)
    set(ok ? { state: 'ready', percent: 100, detail: undefined } : { state: 'error', percent: 0, detail: p.killSwitch ? 'Proxy unreachable. Kill switch is holding all traffic.' : 'Proxy unreachable, falling back to direct' })
    return
  }
  // tor
  try {
    const port = await startTor(g)
    if (g !== gen) return
    const uri = `socks5://127.0.0.1:${port}`
    await ses.setProxy({ proxyRules: p.killSwitch ? uri : `${uri},direct://` })
    await ses.closeAllConnections()
    onSocks(uri, false)
    set({ mode: 'tor', state: 'ready', percent: 100, detail: undefined, socks: uri })
  } catch (e: any) {
    if (g !== gen) return
    set({ mode: 'tor', state: 'error', percent: 0, detail: `${String(e?.message ?? e).slice(0, 120)}${p.killSwitch ? ' · Kill switch is holding all traffic.' : ''}` })
    if (!p.killSwitch) { await ses.setProxy({ mode: 'direct' }); onSocks(null, false) }
  }
}

export function parseProxy(s: string): string | null {
  const t = s.trim()
  const m = /^(socks5h?|socks5|socks|http|https):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\]):(\d{1,5})\/?$/i.exec(t)
  if (!m || Number(m[3]) > 65535) return null
  const scheme = m[1].toLowerCase().startsWith('socks') ? 'socks5' : m[1].toLowerCase()
  return `${scheme}://${m[2]}:${m[3]}`
}

/** A tiny request that proves the route works without revealing anything (Tor's own check page). */
async function probe(): Promise<boolean> {
  try {
    const r = await ses.fetch('https://check.torproject.org/api/ip', { signal: AbortSignal.timeout(20000) } as any)
    return r.ok
  } catch { return false }
}

export async function torCheck(): Promise<{ isTor: boolean } | null> {
  try { const r = await ses.fetch('https://check.torproject.org/api/ip', { signal: AbortSignal.timeout(25000) } as any); const j: any = await r.json(); return { isTor: !!j.IsTor } } catch { return null }
}

// ---------- Tor ----------
const torDir = () => join(app.getPath('userData'), 'tor', TOR_VERSION)
const torBin = () => join(torDir(), 'tor', process.platform === 'win32' ? 'tor.exe' : 'tor')
// torrc paths: Tor on Windows reads forward slashes fine, and a backslash at a line end would be read as a continuation
const torPath = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p)
// Windows 10+ ships bsdtar as System32\\tar.exe; use it by full path so nothing earlier on PATH can stand in
const tarBin = () => (process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar')

async function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = createServer()
    s.once('error', bad)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)) })
  })
}

async function ensureTor(g: number) {
  if (existsSync(torBin())) return
  const key = `${process.platform}-${process.arch}`
  const b = TOR_BUNDLES[key]
  if (!b) throw new Error('Tor is not available on this OS yet')
  set({ state: 'downloading', percent: 0, detail: `Fetching Tor (one time, ~${b.mb} MB)` })
  // A fresh install has no Tor to go through yet, so this one download uses the computer's own network settings.
  // It reveals only that Tor is being fetched, and the file is pinned by hash.
  const direct = session.fromPartition('astrala-bootstrap', { cache: false })
  await direct.setProxy({ mode: 'system' })
  let buf: Buffer | null = null
  for (const m of TOR_MIRRORS) {
    try {
      const r = await direct.fetch(`${m}/${TOR_VERSION}/${b.file}`, { signal: AbortSignal.timeout(240000) } as any)
      if (!r.ok || !r.body) continue
      const total = Number(r.headers.get('content-length') ?? 0)
      const chunks: Uint8Array[] = []
      let got = 0
      const reader = (r.body as any).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value); got += value.length
        if (total && g === gen) set({ percent: Math.round((got / total) * 60) })
      }
      buf = Buffer.concat(chunks)
      break
    } catch { /* next mirror */ }
  }
  if (!buf) throw new Error('Could not download Tor')
  if (createHash('sha256').update(buf).digest('hex') !== b.sha256) throw new Error('Tor download failed verification, discarded')
  await rm(torDir(), { recursive: true, force: true })
  await mkdir(torDir(), { recursive: true })
  const tgz = join(torDir(), 'bundle.tar.gz')
  await writeFile(tgz, buf)
  await new Promise<void>((ok, bad) => execFile(tarBin(), ['-xzf', tgz, '-C', torDir()], (e) => (e ? bad(e) : ok())))
  await rm(tgz, { force: true })
  await chmod(torBin(), 0o755)
}

async function startTor(g: number): Promise<number> {
  if (tor && torPort && status.state === 'ready') return torPort
  await ensureTor(g)
  if (g !== gen) throw new Error('cancelled')
  stopTor()
  torPort = await freePort()
  const data = join(app.getPath('userData'), 'tor', 'data')
  await mkdir(data, { recursive: true, mode: 0o700 })
  const torrc = [
    `SocksPort 127.0.0.1:${torPort} IsolateDestAddr IsolateDestPort`, // every node/API host gets its own Tor circuit, so they can't be linked by exit
    `DataDirectory ${torPath(data)}`,
    `GeoIPFile ${torPath(join(torDir(), 'data', 'geoip'))}`,
    `GeoIPv6File ${torPath(join(torDir(), 'data', 'geoip6'))}`,
    'ClientOnly 1',
    'AvoidDiskWrites 1',
    'Log notice stdout',
    `__OwningControllerProcess ${process.pid}` // Tor exits if Astrala dies
  ].join('\n')
  const rc = join(app.getPath('userData'), 'tor', 'torrc')
  await writeFile(rc, torrc)
  set({ state: 'starting', percent: 60, detail: 'Building a Tor circuit' })
  const env = { ...process.env, LD_LIBRARY_PATH: join(torDir(), 'tor') }
  const proc = spawn(torBin(), ['-f', rc], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  tor = proc
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => { bad(new Error('Tor took too long to connect')); stopTor() }, 120_000)
    proc.stdout!.on('data', (d: Buffer) => {
      const s = d.toString()
      const m = /Bootstrapped (\d+)%/.exec(s)
      if (m && g === gen) set({ percent: 60 + Math.round(Number(m[1]) * 0.4), detail: `Tor ${m[1]}%` })
      if (/Bootstrapped 100%/.test(s)) { clearTimeout(timer); ok(torPort) }
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (tor === proc) { tor = null; if (current.mode === 'tor' && status.state === 'ready') { set({ state: 'error', detail: 'Tor stopped. Reconnecting…' }); setTimeout(() => current.mode === 'tor' && applyRoute(current), 3000) } }
      bad(new Error(`Tor exited (${code})`))
    })
  })
}

export function stopTor() {
  if (tor) { const t = tor; tor = null; try { t.kill() } catch { /* gone */ } }
}

export async function torInstalled() { return existsSync(torBin()) && (await readFile(torBin()).then(() => true).catch(() => false)) }
