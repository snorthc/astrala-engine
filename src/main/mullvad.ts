// Mullvad VPN control through its own CLI (the app ships one). No shell, short timeouts, nothing stored.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export interface MullvadStatus {
  installed: boolean
  state: 'connected' | 'connecting' | 'disconnected' | 'blocked' | 'error' | 'unknown'
  relay?: string
  country?: string
  city?: string
  ip?: string
  detail?: string
}
export interface MullvadCountry { code: string; name: string; cities: { code: string; name: string; relays: number }[] }

// Where the Mullvad app puts its CLI on each OS (fixed paths only: PATH is never searched, so nothing can stand in for it)
export const MULLVAD_CLI: Record<string, string[]> = {
  darwin: ['/usr/local/bin/mullvad', '/Applications/Mullvad VPN.app/Contents/Resources/mullvad', '/opt/homebrew/bin/mullvad'],
  win32: [win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Mullvad VPN', 'resources', 'mullvad.exe'), 'C:\\Program Files\\Mullvad VPN\\resources\\mullvad.exe'],
  linux: ['/usr/bin/mullvad', '/usr/local/bin/mullvad', '/opt/Mullvad VPN/resources/mullvad']
}
export const cliPath = () => (MULLVAD_CLI[process.platform] ?? []).find((p) => existsSync(p)) ?? null

function run(args: string[], timeout = 8000): Promise<string> {
  const bin = cliPath()
  if (!bin) return Promise.reject(new Error('Mullvad is not installed'))
  return new Promise((ok, bad) => execFile(bin, args, { timeout, maxBuffer: 4 << 20, windowsHide: true }, (e, out, err) => (e ? bad(new Error(String(err || e.message).trim().split('\n')[0].slice(0, 160))) : ok(String(out)))))
}

/** Parses `mullvad status --json` (newer CLIs) or the plain / -v text output (all versions). */
export function parseStatus(out: string): MullvadStatus {
  const t = out.trim()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t)
      const raw = String(j.state ?? j.tunnel_state ?? j.status ?? '').toLowerCase()
      const loc = j.details?.location ?? j.location ?? {}
      return {
        installed: true,
        state: raw.includes('disconnect') ? 'disconnected' : raw.includes('connecting') ? 'connecting' : raw.includes('connected') ? 'connected' : raw.includes('error') ? 'error' : raw.includes('block') ? 'blocked' : 'unknown',
        relay: loc.hostname ?? j.details?.endpoint?.hostname ?? undefined,
        country: loc.country ?? undefined,
        city: loc.city ?? undefined,
        ip: loc.ipv4 ?? loc.ip ?? undefined
      }
    } catch { /* fall through to text */ }
  }
  const first = t.split('\n')[0].trim()
  const s: MullvadStatus = { installed: true, state: 'unknown' }
  if (/^disconnect/i.test(first)) s.state = 'disconnected'
  else if (/^connecting/i.test(first)) s.state = 'connecting'
  else if (/^connected/i.test(first)) s.state = 'connected'
  else if (/^blocked/i.test(first)) { s.state = 'blocked'; s.detail = first.replace(/^blocked:?\s*/i, '') }
  else if (/^error/i.test(first)) { s.state = 'error'; s.detail = first }
  // "Connected to se-got-wg-001 in Gothenburg, Sweden"
  const inline = /to ([a-z]{2}-[a-z0-9]{3}-[a-z0-9-]+)(?: in ([^,\n]+), ([^\n]+))?/i.exec(first)
  if (inline) { s.relay = inline[1]; if (inline[2]) { s.city = inline[2].trim(); s.country = inline[3].trim() } }
  const relay = /Relay:\s*(\S+)/i.exec(t)
  if (relay) s.relay = relay[1]
  // "Visible location:       Sweden, Gothenburg. IPv4: 185.213.154.68"  /  older "Location: Gothenburg, Sweden"
  const vis = /Visible location:\s*([^,\n]+),\s*([^.\n]+)\.?(?:\s*IPv4:\s*([\d.]+))?/i.exec(t)
  if (vis) { s.country = vis[1].trim(); s.city = vis[2].trim(); if (vis[3]) s.ip = vis[3] }
  const ip = /IPv4:\s*([\d.]+)/i.exec(t)
  if (ip) s.ip = ip[1]
  return s
}

/** Parses `mullvad relay list`: countries at column 0, cities one tab in, relays two tabs in. */
export function parseRelays(out: string): MullvadCountry[] {
  const list: MullvadCountry[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const depth = /^\t\t|^ {8}/.test(line) ? 2 : /^\t|^ {4}/.test(line) ? 1 : 0
    const m = /^\s*(.+?) \(([a-z0-9-]+)\)/i.exec(line)
    if (!m) continue
    if (depth === 0) list.push({ code: m[2].toLowerCase(), name: m[1].trim(), cities: [] })
    else if (depth === 1) list.at(-1)?.cities.push({ code: m[2].toLowerCase(), name: m[1].trim(), relays: 0 })
    else { const c = list.at(-1)?.cities.at(-1); if (c) c.relays++ }
  }
  return list.filter((c) => c.cities.length)
}

export async function mullvadStatus(): Promise<MullvadStatus> {
  if (!cliPath()) return { installed: existsSync('/Applications/Mullvad VPN.app'), state: 'unknown', detail: existsSync('/Applications/Mullvad VPN.app') ? 'Mullvad app found but its command-line tool is missing' : undefined }
  try {
    const j = await run(['status', '--json']).catch(() => '')
    if (j.trim().startsWith('{')) return parseStatus(j)
    return parseStatus(await run(['status', '-v']).catch(() => run(['status'])))
  } catch (e: any) { return { installed: true, state: 'error', detail: e.message } }
}

let relayCache: { at: number; list: MullvadCountry[] } | null = null
export async function mullvadRelays(): Promise<MullvadCountry[]> {
  if (relayCache && Date.now() - relayCache.at < 3600_000) return relayCache.list
  const list = parseRelays(await run(['relay', 'list'], 15000))
  relayCache = { at: Date.now(), list }
  return list
}

export const mullvadConnect = () => run(['connect']).then(() => true)
export const mullvadDisconnect = () => run(['disconnect']).then(() => true)
export async function mullvadSetLocation(country: string, city?: string) {
  if (!/^[a-z]{2}$/.test(country) || (city && !/^[a-z0-9]{3,4}$/.test(city))) throw new Error('Bad location')
  await run(['relay', 'set', 'location', country, ...(city ? [city] : [])])
  return true
}

/** Waits for the tunnel to come up (or go down) after connect/disconnect. */
export async function waitFor(state: MullvadStatus['state'], ms = 20000): Promise<MullvadStatus> {
  const end = Date.now() + ms
  let s = await mullvadStatus()
  while (s.state !== state && Date.now() < end) { await new Promise((r) => setTimeout(r, 700)); s = await mullvadStatus() }
  return s
}
