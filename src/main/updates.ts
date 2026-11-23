// Updates: read the latest release from the public engine repo, download this OS's installer through Astral Route,
// and only use it if its SHA-256 matches the release's SHA256SUMS.
//   Download only: the verified installer is saved to Downloads for the user to open.
//   Update now:    the verified installer replaces the running app and Astrala relaunches. Any failure before the
//                  final swap leaves the installed app exactly as it was; the swap itself rolls back if it fails.
// Dry run (ASTRALA_UPDATE_DRYRUN=1): download and verify for real, then report the install steps without doing them.
import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, chmod, copyFile, mkdtemp, readdir, rename, rm, writeFile, constants } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { net } from '../core/chain'
import { isNewer, pickInstaller as pick, expectedHash, downloadVerified, sha256Hex, macBundleOf, macBundleProblem, parseMountPoint, siblingPath, swapInto, installPlan, type ReleaseAsset } from '../core/update-core'
import type { UpdateProgress, UpdateResult } from '../shared/api'

export { isNewer }
export interface UpdateInfo { current: string; latest?: string; newer: boolean; notes?: string; dmg?: string; error?: string; repo?: string }

const run = promisify(execFile)
// the release repo is written into package.json by Publish Release.command
const repo = () => { try { return String(JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).astrala?.updateRepo ?? '').trim() } catch { return '' } }
// Development only: point at a local stand-in for the GitHub API to rehearse an update. Ignored in the packaged app.
const apiBase = () => (!app.isPackaged && process.env.ASTRALA_UPDATE_API) || 'https://api.github.com'
const dryRun = () => !!process.env.ASTRALA_UPDATE_DRYRUN

let latest: { tag: string; notes: string; assets: ReleaseAsset[] } | null = null

export async function checkUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion(), r = repo() || (!app.isPackaged ? process.env.ASTRALA_UPDATE_REPO ?? '' : '')
  if (!r) return { current, newer: false, error: 'No release source set yet' }
  try {
    const res = await net(`${apiBase()}/repos/${r}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
    if (res.status === 404) return { current, newer: false, repo: r, error: 'No release published yet' }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const j: any = await res.json()
    latest = { tag: String(j.tag_name ?? ''), notes: String(j.body ?? '').slice(0, 4000), assets: (j.assets ?? []).map((a: any) => ({ name: String(a.name), url: String(a.browser_download_url) })) }
    const dmg = pickInstaller(latest.assets)?.name
    return { current, latest: latest.tag, newer: isNewer(latest.tag, current), notes: latest.notes, dmg, repo: r }
  } catch (e: any) {
    return { current, newer: false, repo: r, error: String(e?.message ?? e).slice(0, 140) }
  }
}

export const pickInstaller = (as: ReleaseAsset[], platform: string = process.platform, cpu: string = process.arch) => pick(as, platform, cpu)

/** The installer for this OS and its published hash, or why there isn't one. */
async function verifiedSource(): Promise<{ asset: ReleaseAsset; want: string } | { error: string }> {
  if (!latest) await checkUpdate()
  if (!latest) return { error: 'Could not reach the release' }
  const asset = pickInstaller(latest.assets), sums = latest.assets.find((a) => a.name === 'SHA256SUMS')
  if (!asset) return { error: 'This release has no download for this OS' }
  if (!sums) return { error: 'This release has no SHA256SUMS, so it cannot be verified. Not downloaded.' }
  const res = await net(sums.url)
  if (!res.ok) return { error: `Could not read SHA256SUMS (${res.status}). Not downloaded.` }
  const want = expectedHash(await res.text(), asset.name)
  if (!want) return { error: `SHA256SUMS doesn't list ${asset.name}. Not downloaded.` }
  return { asset, want }
}

/** Downloads the new installer, checks it against SHA256SUMS, and shows it in Finder / Explorer / the file manager. A mismatch is deleted, never opened. */
export async function downloadUpdate(): Promise<{ ok: boolean; path?: string; sha256?: string; error?: string }> {
  try {
    const src = await verifiedSource()
    if ('error' in src) return { ok: false, error: src.error }
    const res = await net(src.asset.url, { signal: AbortSignal.timeout(15 * 60_000) } as RequestInit)
    if (!res.ok) return { ok: false, error: `Download failed (${res.status})` }
    const buf = Buffer.from(await res.arrayBuffer())
    const got = sha256Hex(buf)
    if (got !== src.want) return { ok: false, error: 'The download does not match the published checksum. It was thrown away.' }
    const path = join(app.getPath('downloads'), basename(src.asset.name))
    await rm(path, { force: true })
    await writeFile(path, buf)
    shell.showItemInFolder(path)
    return { ok: true, path, sha256: got }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160) }
  }
}

/** Where this copy of Astrala lives and whether it can replace itself, checked before anything is downloaded. */
async function target(): Promise<{ bundle?: string; appImage?: string } | { error: string }> {
  const writable = async (d: string) => access(d, constants.W_OK).then(() => true, () => false)
  if (process.platform === 'darwin') {
    if (!app.isPackaged) return { error: 'Updates only install into the packaged app.' }
    const bundle = macBundleOf(app.getPath('exe'))
    const problem = macBundleProblem(bundle)
    if (problem) return { error: problem }
    if (!(await writable(dirname(bundle!)))) return { error: `Astrala can't write to ${dirname(bundle!)}. Use Download only and install it yourself.` }
    return { bundle }
  }
  if (process.platform === 'win32') return app.isPackaged ? {} : { error: 'Updates only install into the packaged app.' }
  if (process.platform === 'linux') {
    const appImage = process.env.APPIMAGE
    if (!appImage || !existsSync(appImage)) return { error: 'Only the AppImage build can update itself. Use Download only for other installs.' }
    if (!(await writable(dirname(appImage)))) return { error: `Astrala can't write to ${dirname(appImage)}. Use Download only and replace it yourself.` }
    return { appImage }
  }
  return { error: 'Self-update is not available on this system.' }
}

const bundleId = async (appPath: string) => (await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')], { timeout: 15_000 })).stdout.trim()

/** macOS: mount the verified .dmg read-only, copy its app beside ours, check it's the same app, swap, detach. */
async function installMac(file: string, bundle: string) {
  const { stdout } = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-plist', file], { timeout: 120_000, maxBuffer: 4 << 20 })
  const mount = parseMountPoint(stdout)
  if (!mount) throw new Error("The update's disk image didn't mount.")
  let staged: string | undefined
  try {
    const apps = (await readdir(mount)).filter((n) => n.endsWith('.app') && !n.startsWith('.'))
    const src = apps.find((n) => n === basename(bundle)) ?? apps[0]
    if (!src) throw new Error('No app found inside the update.')
    staged = siblingPath(bundle, 'new')
    await run('ditto', [join(mount, src), staged], { timeout: 300_000 })
    const [mine, theirs] = await Promise.all([bundleId(bundle), bundleId(staged)])
    if (!theirs || theirs !== mine) throw new Error("The update isn't the same app (bundle identifier differs). Not installed.")
    const old = await swapInto(staged, bundle)
    staged = undefined
    await rm(old, { recursive: true, force: true }).catch(() => {})
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {})
    await run('hdiutil', ['detach', mount, '-quiet'], { timeout: 60_000 }).catch(() => run('hdiutil', ['detach', mount, '-force'], { timeout: 60_000 }).catch(() => {}))
  }
}

/** Linux: the verified AppImage replaces the running one with a single same-folder rename. */
async function installAppImage(file: string, appImage: string) {
  const staged = siblingPath(appImage, 'new')
  try {
    await copyFile(file, staged)
    await chmod(staged, 0o755)
    await rename(staged, appImage)
  } catch (e) {
    await rm(staged, { force: true }).catch(() => {})
    throw e
  }
}

/** Update now: download → verify → install → relaunch, reporting each phase. */
export async function installUpdate(progress: (p: UpdateProgress) => void): Promise<UpdateResult> {
  const dry = dryRun()
  let work: string | undefined, keepWork = false
  try {
    if (!latest) await checkUpdate()
    if (!latest) return { ok: false, error: 'Could not reach the release' }
    if (!isNewer(latest.tag, app.getVersion()) && !dry) return { ok: false, error: "You're already on the latest version." }
    const where = await target()
    if ('error' in where && !dry) return { ok: false, error: where.error }
    const src = await verifiedSource()
    if ('error' in src) return { ok: false, error: src.error }

    work = await mkdtemp(join(app.getPath('temp'), 'astrala-update-'))
    const file = join(work, basename(src.asset.name))
    progress({ phase: 'download', pct: 0 })
    const sha256 = await downloadVerified({
      fetcher: net, url: src.asset.url, want: src.want, dest: file,
      onProgress: (received, total) => progress({ phase: 'download', pct: total ? Math.min(100, Math.round((received / total) * 100)) : undefined, received, total })
    })
    progress({ phase: 'verify', pct: 100 }) // hashed while downloading: by here it matched

    const t = 'error' in where ? {} : where
    if (dry) return { ok: true, dryRun: true, sha256, steps: installPlan(process.platform, { file, ...t }) }

    progress({ phase: 'install' })
    if (process.platform === 'darwin') await installMac(file, t.bundle!)
    else if (process.platform === 'linux') await installAppImage(file, t.appImage!)
    else if (process.platform === 'win32') {
      // the NSIS installer replaces Astrala silently and starts it again; it needs its file until it has run
      spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      keepWork = true
      progress({ phase: 'relaunch' })
      setTimeout(() => app.quit(), 600)
      return { ok: true, sha256 }
    }

    progress({ phase: 'relaunch' })
    // relaunch, then quit normally so the wallet locks, Tor stops and the clipboard clears on the way out
    setTimeout(() => {
      if (process.platform === 'linux') app.relaunch({ execPath: t.appImage, args: process.argv.slice(1) })
      else app.relaunch()
      app.quit()
    }, 700)
    return { ok: true, sha256 }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) }
  } finally {
    if (work && !keepWork) await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
