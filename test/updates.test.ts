import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isNewer, pickInstaller, parseSums, expectedHash, downloadVerified, HashMismatch, macBundleOf, macBundleProblem, parseMountPoint, swapInto, installPlan, sha256Hex } from '../src/core/update-core'

const ASSETS = [
  'Astrala-Wallet-1.2.0-universal.dmg', 'Astrala-Wallet-1.2.0-universal.dmg.blockmap', 'Astrala-Wallet-1.2.0-arm64.dmg',
  'Astrala-Wallet-1.2.0-x64-setup.exe', 'Astrala-Wallet-1.2.0-x86_64.AppImage', 'Astrala-Wallet-1.2.0-arm64.AppImage', 'SHA256SUMS'
].map((name) => ({ name, url: `https://example.invalid/${name}` }))

describe('choosing the installer', () => {
  it('picks the universal dmg on any Mac, the setup exe on Windows and the right AppImage on Linux', () => {
    expect(pickInstaller(ASSETS, 'darwin', 'arm64')?.name).toBe('Astrala-Wallet-1.2.0-universal.dmg')
    expect(pickInstaller(ASSETS, 'darwin', 'x64')?.name).toBe('Astrala-Wallet-1.2.0-universal.dmg')
    expect(pickInstaller(ASSETS, 'win32', 'x64')?.name).toBe('Astrala-Wallet-1.2.0-x64-setup.exe')
    expect(pickInstaller(ASSETS, 'linux', 'x64')?.name).toBe('Astrala-Wallet-1.2.0-x86_64.AppImage')
    expect(pickInstaller(ASSETS, 'linux', 'arm64')?.name).toBe('Astrala-Wallet-1.2.0-arm64.AppImage')
  })
  it("never hands one CPU the other CPU's build, and never a blockmap", () => {
    const onlyArm = ASSETS.filter((a) => a.name.includes('arm64'))
    expect(pickInstaller(onlyArm, 'linux', 'x64')).toBeUndefined()
    expect(pickInstaller([{ name: 'Astrala.dmg.blockmap', url: '' }], 'darwin', 'x64')).toBeUndefined()
    expect(pickInstaller([{ name: 'Astrala-1.2.0.dmg', url: '' }], 'darwin', 'arm64')?.name).toBe('Astrala-1.2.0.dmg')
    expect(pickInstaller(ASSETS, 'freebsd', 'x64')).toBeUndefined()
  })
  it('compares versions', () => {
    expect(isNewer('v1.2.0', '1.1.9')).toBe(true)
    expect(isNewer('1.10.0', '1.9.0')).toBe(true)
    expect(isNewer('v1.2.0', '1.2.0')).toBe(false)
    expect(isNewer('1.1.0', '1.2.0')).toBe(false)
  })
})

describe('SHA256SUMS', () => {
  const A = 'a'.repeat(64), B = 'B'.repeat(64)
  const sums = `${A}  Astrala-Wallet-1.2.0-universal.dmg\n${B} *Astrala-Wallet-1.2.0-x64-setup.exe\r\nnot a line\n${'c'.repeat(63)}  short.dmg\n`
  it('reads both sha256sum formats and skips junk', () => {
    const m = parseSums(sums)
    expect(m.get('Astrala-Wallet-1.2.0-universal.dmg')).toBe(A)
    expect(m.get('Astrala-Wallet-1.2.0-x64-setup.exe')).toBe(B.toLowerCase())
    expect(m.has('short.dmg')).toBe(false)
    expect(m.size).toBe(2)
  })
  it('gives the hash for an exact file name only, and nothing if a name is listed twice', () => {
    expect(expectedHash(sums, 'Astrala-Wallet-1.2.0-universal.dmg')).toBe(A)
    expect(expectedHash(sums, 'Astrala-Wallet-1.2.0-universal')).toBeUndefined()
    expect(expectedHash(sums, 'universal.dmg')).toBeUndefined()
    expect(expectedHash(`${A}  x.dmg\n${'d'.repeat(64)}  x.dmg`, 'x.dmg')).toBeUndefined()
  })
})

describe('downloading with a running hash (real HTTP, local server)', () => {
  const body = Buffer.alloc(300_000).map((_, i) => (i * 31) % 251)
  const good = createHash('sha256').update(body).digest('hex')
  let server: Server, base = '', dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'astrala-upd-'))
    server = createServer((req, res) => {
      if (req.url === '/app.dmg') { res.writeHead(200, { 'content-length': body.length }); res.end(body) }
      else if (req.url === '/short.dmg') { res.writeHead(200, { 'content-length': body.length }); res.end(body.subarray(0, 1000)); res.socket?.destroy() }
      else { res.writeHead(404); res.end() }
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(async () => { server.close(); await rm(dir, { recursive: true, force: true }) })

  it('keeps the file when it matches, and reports progress up to 100%', async () => {
    const seen: number[] = []
    const dest = join(dir, 'ok.dmg')
    const got = await downloadVerified({ fetcher: fetch, url: `${base}/app.dmg`, want: good, dest, onProgress: (r, t) => seen.push(Math.round((r / t) * 100)) })
    expect(got).toBe(good)
    expect(sha256Hex(await readFile(dest))).toBe(good)
    expect(seen.at(-1)).toBe(100)
  })

  it('refuses and deletes a download whose hash does not match', async () => {
    const dest = join(dir, 'bad.dmg')
    await expect(downloadVerified({ fetcher: fetch, url: `${base}/app.dmg`, want: 'f'.repeat(64), dest })).rejects.toBeInstanceOf(HashMismatch)
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses a cut-short download, a missing file and a missing checksum', async () => {
    await expect(downloadVerified({ fetcher: fetch, url: `${base}/short.dmg`, want: good, dest: join(dir, 's.dmg') })).rejects.toThrow()
    expect(existsSync(join(dir, 's.dmg'))).toBe(false)
    await expect(downloadVerified({ fetcher: fetch, url: `${base}/nope.dmg`, want: good, dest: join(dir, 'n.dmg') })).rejects.toThrow(/404/)
    await expect(downloadVerified({ fetcher: fetch, url: `${base}/app.dmg`, want: 'not-a-hash', dest: join(dir, 'h.dmg') })).rejects.toThrow(/checksum/)
  })
})

describe('installing', () => {
  it('finds the running bundle and refuses copies that cannot replace themselves', () => {
    expect(macBundleOf('/Applications/Astrala.app/Contents/MacOS/Astrala')).toBe('/Applications/Astrala.app')
    expect(macBundleOf('/Applications/Tools/Astrala Wallet.app/Contents/MacOS/Astrala Wallet')).toBe('/Applications/Tools/Astrala Wallet.app')
    expect(macBundleOf('/usr/local/bin/astrala')).toBeUndefined()
    expect(macBundleProblem('/Applications/Astrala.app')).toBeUndefined()
    expect(macBundleProblem('/private/var/folders/x/AppTranslocation/ABC/d/Astrala.app')).toMatch(/Applications folder/)
    expect(macBundleProblem('/Volumes/Astrala 1.2.0/Astrala.app')).toMatch(/Applications folder/)
    expect(macBundleProblem(undefined)).toMatch(/bundle/)
  })

  it('reads the mount point out of hdiutil -plist output', () => {
    const plist = `<?xml version="1.0"?><plist><dict><key>system-entities</key><array>
      <dict><key>content-hint</key><string>GUID_partition_scheme</string><key>dev-entry</key><string>/dev/disk4</string></dict>
      <dict><key>content-hint</key><string>Apple_HFS</string><key>mount-point</key><string>/Volumes/Astrala 1.2.0-universal</string></dict>
    </array></dict></plist>`
    expect(parseMountPoint(plist)).toBe('/Volumes/Astrala 1.2.0-universal')
    expect(parseMountPoint('<plist/>')).toBeUndefined()
  })

  it('swaps a new app bundle into place and hands back the old one', async () => {
    const d = await mkdtemp(join(tmpdir(), 'astrala-swap-'))
    const app = join(d, 'Astrala.app'), fresh = join(d, '.Astrala.app.new-1')
    await mkdir(join(app, 'Contents'), { recursive: true }); await writeFile(join(app, 'Contents', 'v'), '1.1.0')
    await mkdir(join(fresh, 'Contents'), { recursive: true }); await writeFile(join(fresh, 'Contents', 'v'), '1.2.0')
    const old = await swapInto(fresh, app)
    expect(await readFile(join(app, 'Contents', 'v'), 'utf8')).toBe('1.2.0')
    expect(await readFile(join(old, 'Contents', 'v'), 'utf8')).toBe('1.1.0')
    expect(old.startsWith(join(d, '.Astrala.app.old-'))).toBe(true)
    await rm(d, { recursive: true, force: true })
  })

  it('puts the old app straight back if the new one cannot be moved in', async () => {
    const d = await mkdtemp(join(tmpdir(), 'astrala-swap-'))
    const img = join(d, 'Astrala.AppImage'), fresh = join(d, '.Astrala.AppImage.new-1')
    await writeFile(img, 'old'); await writeFile(fresh, 'new')
    let calls = 0
    const flaky = { rename: (async (a: string, b: string) => { if (++calls === 2) throw new Error('disk full'); return rename(a, b) }) as typeof rename }
    await expect(swapInto(fresh, img, flaky)).rejects.toThrow('disk full')
    expect(await readFile(img, 'utf8')).toBe('old')
    expect((await readdir(d)).filter((n) => n.includes('.old-'))).toEqual([])
    await expect(swapInto(join(d, 'missing'), img)).rejects.toThrow()
    expect(await readFile(img, 'utf8')).toBe('old')
    await rm(d, { recursive: true, force: true })
  })

  it('plans the same steps a real install takes (shown in dry runs)', () => {
    const mac = installPlan('darwin', { file: '/tmp/u/A.dmg', bundle: '/Applications/Astrala.app' })
    expect(mac[0]).toBe('hdiutil attach -nobrowse -readonly -noautoopen -plist /tmp/u/A.dmg')
    expect(mac.some((s) => s.startsWith('ditto '))).toBe(true)
    expect(mac.at(-1)).toBe('relaunch')
    expect(installPlan('win32', { file: 'C:\\t\\setup.exe' })[0]).toBe('C:\\t\\setup.exe --updated /S --force-run')
    expect(installPlan('linux', { file: '/tmp/a', appImage: '/home/k/Astrala.AppImage' })).toContain('rename over /home/k/Astrala.AppImage')
  })
})
