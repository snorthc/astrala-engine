// Tor Expert Bundle 16.0 from dist.torproject.org. Hashes are copied from sha256sums-signed-build.txt, whose signature
// was checked against the Tor Browser signing key (EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87 9329 8290): macOS on 2026-10-31,
// Linux and Windows on 2026-11-06. A platform missing here gets "not available on this OS yet", never an unpinned binary.
export const TOR_VERSION = '16.0'
export const TOR_BUNDLES: Record<string, { file: string; sha256: string; mb: number }> = {
  'darwin-x64': { file: 'tor-expert-bundle-macos-x86_64-16.0.tar.gz', sha256: '5b1860215c26f2d408392d1d79e798a2f81d65eb939510bb94c11f237bd0bfc3', mb: 19 },
  'darwin-arm64': { file: 'tor-expert-bundle-macos-aarch64-16.0.tar.gz', sha256: 'b8da251eccbe9e82f3681ee3af3c97fb4291c4a4e153e5b824bde48a1117cd6a', mb: 19 },
  'linux-x64': { file: 'tor-expert-bundle-linux-x86_64-16.0.tar.gz', sha256: 'cc950ebe9acb80188325c3a2cd8817def7dd7237d6fdcd861bb87b234a0cb2fd', mb: 34 },
  'linux-arm64': { file: 'tor-expert-bundle-linux-aarch64-16.0.tar.gz', sha256: 'bed98744e093a0dc3a22be0eecfdce7a33cb36866d3f15fcf011a35bf3513d0d', mb: 33 },
  'win32-x64': { file: 'tor-expert-bundle-windows-x86_64-16.0.tar.gz', sha256: '2ee123e9167318a3742778ff704e75f01d4780f05a14522d451fe011011077c4', mb: 24 }
}
export const torSupported = (key = `${process.platform}-${process.arch}`) => key in TOR_BUNDLES
