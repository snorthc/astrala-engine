import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0', getAppPath: () => '/nonexistent', getPath: () => '/tmp' }, shell: {} }))
import { TOR_BUNDLES, TOR_VERSION, torSupported } from '../src/main/tor-bundles'
import { MULLVAD_CLI } from '../src/main/mullvad'
import { pickInstaller } from '../src/main/updates'

describe('Tor bundle pins', () => {
  it('pins every platform Astrala ships for, by SHA-256', () => {
    for (const k of ['darwin-x64', 'darwin-arm64', 'linux-x64', 'win32-x64']) expect(torSupported(k)).toBe(true)
    for (const [k, b] of Object.entries(TOR_BUNDLES)) {
      expect(b.sha256, k).toMatch(/^[0-9a-f]{64}$/)
      expect(b.file, k).toContain(`-${TOR_VERSION}.tar.gz`)
      const os = k.split('-')[0]
      expect(b.file, k).toContain({ darwin: 'macos', linux: 'linux', win32: 'windows' }[os]!)
    }
    // the official sha256sums-signed-build.txt for 16.0 (signature checked against the Tor Browser key)
    expect(TOR_BUNDLES['win32-x64'].sha256).toBe('2ee123e9167318a3742778ff704e75f01d4780f05a14522d451fe011011077c4')
    expect(TOR_BUNDLES['linux-x64'].sha256).toBe('cc950ebe9acb80188325c3a2cd8817def7dd7237d6fdcd861bb87b234a0cb2fd')
  })
  it('says "not available" for anything unpinned instead of guessing', () => {
    expect(torSupported('win32-arm64')).toBe(false)
    expect(torSupported('freebsd-x64')).toBe(false)
  })
})

describe('Mullvad CLI locations', () => {
  it('knows the CLI path on macOS, Windows and Linux', () => {
    expect(MULLVAD_CLI.darwin).toContain('/Applications/Mullvad VPN.app/Contents/Resources/mullvad')
    expect(MULLVAD_CLI.win32).toContain('C:\\Program Files\\Mullvad VPN\\resources\\mullvad.exe')
    expect(MULLVAD_CLI.linux).toContain('/usr/bin/mullvad')
    for (const list of Object.values(MULLVAD_CLI)) for (const p of list) expect(p).toMatch(/^(\/|[A-Z]:\\)/) // absolute only, never PATH
  })
})

describe('update installer per OS', () => {
  const assets = ['Astrala-Wallet-1.1.0-universal.dmg', 'Astrala-Wallet-1.1.0-x64-setup.exe', 'Astrala-Wallet-1.1.0-x86_64.AppImage', 'Astrala-Wallet-1.1.0-amd64.deb', 'SHA256SUMS'].map((name) => ({ name, url: `https://x/${name}` }))
  it('picks the .dmg, the setup .exe or the AppImage', () => {
    expect(pickInstaller(assets, 'darwin', 'arm64')?.name).toBe('Astrala-Wallet-1.1.0-universal.dmg')
    expect(pickInstaller(assets, 'win32', 'x64')?.name).toBe('Astrala-Wallet-1.1.0-x64-setup.exe')
    expect(pickInstaller(assets, 'linux', 'x64')?.name).toBe('Astrala-Wallet-1.1.0-x86_64.AppImage')
    expect(pickInstaller(assets, 'freebsd', 'x64')).toBeUndefined()
  })
})
