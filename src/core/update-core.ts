// The parts of self-updating that need no Electron: choosing this OS's installer, reading SHA256SUMS, downloading
// with a running hash, and swapping a new app in with a rollback. Kept pure so tests can run them for real.
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export type ReleaseAsset = { name: string; url: string }

const vparts = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0)
/** true when a is a later version than b */
export const isNewer = (a: string, b: string) => {
  const x = vparts(a), y = vparts(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

// the installer for this OS: .dmg on macOS, the NSIS setup .exe on Windows, the AppImage on Linux
const INSTALLER: Record<string, RegExp> = { darwin: /\.dmg$/i, win32: /\.exe$/i, linux: /\.AppImage$/i }
export const pickInstaller = (as: ReleaseAsset[], platform: string, cpu: string) => {
  const ext = INSTALLER[platform]
  if (!ext) return undefined
  const files = as.filter((a) => ext.test(a.name) && !/\.blockmap$/i.test(a.name))
  const arch = cpu === 'arm64' ? /arm64|aarch64/i : /x64|x86_64|amd64|intel/i
  const other = cpu === 'arm64' ? /x64|x86_64|amd64|intel/i : /arm64|aarch64/i
  return files.find((a) => /universal/i.test(a.name)) ?? files.find((a) => arch.test(a.name)) ?? files.find((a) => !other.test(a.name))
}

/** SHA256SUMS lines ("<hash>  <name>" or "<hash> *<name>") → name → lowercase hash. Malformed lines are skipped. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim())
    if (m) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

/** The published hash for one file, or undefined if SHA256SUMS doesn't list it exactly once. */
export function expectedHash(sums: string, name: string): string | undefined {
  const hits = String(sums ?? '').split(/\r?\n/).map((l) => /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(l.trim())).filter((m) => m && m[2] === name)
  return hits.length === 1 ? hits[0]![1].toLowerCase() : undefined
}

export const sha256Hex = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex')

export class HashMismatch extends Error {
  constructor(public got: string, public want: string) { super('The download does not match the published checksum. It was thrown away and nothing was installed.') }
}

/**
 * Streams `url` to `dest`, hashing as it goes. Keeps the file only if its SHA-256 equals `want`; otherwise deletes it
 * and throws HashMismatch. `fetcher` is the app's routed `net`, so the download goes through Astral Route.
 */
export async function downloadVerified(o: {
  fetcher: (url: string, init?: RequestInit) => Promise<Response>
  url: string; want: string; dest: string
  onProgress?: (received: number, total: number) => void
  signal?: AbortSignal
}): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(o.want)) throw new Error('No valid checksum to verify against. Not downloaded.')
  const res = await o.fetcher(o.url, { signal: o.signal ?? AbortSignal.timeout(20 * 60_000) } as RequestInit)
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const hash = createHash('sha256'), out = createWriteStream(o.dest, { mode: 0o600 })
  const done = new Promise<void>((ok, bad) => { out.on('finish', ok); out.on('error', bad) })
  let received = 0, last = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      hash.update(value); received += value.byteLength
      if (!out.write(value)) await new Promise((ok) => out.once('drain', ok))
      if (o.onProgress && (Date.now() - last > 120 || received === total)) { last = Date.now(); o.onProgress(received, total) }
    }
    out.end(); await done
  } catch (e) {
    // nobody awaits `done` on this path: mark it handled, and let the file close before removing it
    done.catch(() => {})
    await new Promise<void>((ok) => { if (out.closed) ok(); else { out.once('close', () => ok()); out.destroy() } })
    await rm(o.dest, { force: true })
    throw e
  }
  if (total && received !== total) { await rm(o.dest, { force: true }); throw new Error('The download was cut short. Nothing was installed.') }
  const got = hash.digest('hex')
  if (got !== o.want) { await rm(o.dest, { force: true }); throw new HashMismatch(got, o.want) }
  o.onProgress?.(received, total || received)
  return got
}

/** /Applications/Astrala.app/Contents/MacOS/Astrala → /Applications/Astrala.app (undefined outside a bundle) */
export function macBundleOf(exe: string): string | undefined {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)
  return m ? m[1] : undefined
}

/** Can a running copy at this path replace itself? Translocated or disk-image copies can't. */
export function macBundleProblem(bundle: string | undefined): string | undefined {
  if (!bundle) return "Astrala isn't running from an app bundle, so it can't update itself here."
  if (/\/AppTranslocation\//.test(bundle) || bundle.startsWith('/Volumes/')) return 'Move Astrala into your Applications folder first, then update.'
  return undefined
}

/** The mount point from `hdiutil attach -plist` output. */
export function parseMountPoint(plist: string): string | undefined {
  const all = [...String(plist ?? '').matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1])
  return all.find((p) => p.startsWith('/Volumes/')) ?? all[0]
}

/** A hidden sibling path on the same volume as `target`, so the final rename is a plain same-disk rename. */
export const siblingPath = (target: string, tag: string) => join(dirname(target), `.${basename(target)}.${tag}-${randomBytes(4).toString('hex')}`)

/**
 * Puts `fresh` where `target` is: target → hidden .old sibling, fresh → target. If the second step fails the old copy
 * goes straight back, so the running app's path always holds a complete app. Returns the .old path for the caller to remove.
 */
export async function swapInto(fresh: string, target: string, fs: { rename: typeof rename } = { rename }): Promise<string> {
  await stat(fresh) // must exist before anything moves
  const old = siblingPath(target, 'old')
  await fs.rename(target, old)
  try {
    await fs.rename(fresh, target)
  } catch (e) {
    await fs.rename(old, target)
    throw e
  }
  return old
}

/** What an install would do on this OS, in order. Shown in dry runs; the real run follows the same steps. */
export function installPlan(platform: string, o: { file: string; bundle?: string; appImage?: string }): string[] {
  if (platform === 'darwin') {
    const b = o.bundle ?? '(app bundle)'
    return [
      `hdiutil attach -nobrowse -readonly -noautoopen -plist ${o.file}`,
      `ditto <mounted>/Astrala.app ${join(dirname(b), `.${basename(b)}.new-…`)}`,
      'check the new app has the same bundle identifier',
      `rename ${b} → .old, new → ${b} (old put back if this fails)`,
      'hdiutil detach <mounted>',
      'relaunch'
    ]
  }
  if (platform === 'win32') return [`${o.file} --updated /S --force-run`, 'quit (the installer replaces Astrala and starts it again)']
  if (platform === 'linux') {
    const t = o.appImage ?? '(AppImage)'
    return [`copy to ${join(dirname(t), `.${basename(t)}.new-…`)}`, 'chmod 755', `rename over ${t}`, 'relaunch']
  }
  return ['unsupported OS']
}
