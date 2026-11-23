// The iPhone web app's door: the wallet's own screens, served by this Mac over HTTPS on the local network, talking
// back through the same narrow tunnel the browser extension uses (bridge.ts in 'phone' mode). Keys never leave
// the Mac; the phone holds only a pairing token, and every payment still needs your PIN.
//
// HTTPS matters here: on shared Wi-Fi a plain page would show your PIN and balances to anyone listening. So this
// Mac makes its own certificate authority (with openssl, once) and a server certificate for its local addresses.
// You trust that authority on the phone once. Its name constraints mean the phone trusts it only for private
// network addresses and .local names, never for a real website, even if its key were ever taken.
import https from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { networkInterfaces, hostname } from 'node:os'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, normalize, extname, sep } from 'node:path'
import { requestListener, type BridgeHost } from './bridge'

const run = promisify(execFile)
export const PHONE_PORT = 47830

/** This Mac's private-network IPv4 addresses (home Wi-Fi, Ethernet, Tailscale), never a public one. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) {
    if (a.family !== 'IPv4' || a.internal) continue
    const [p, q] = a.address.split('.').map(Number)
    if (p === 10 || (p === 192 && q === 168) || (p === 172 && q >= 16 && q <= 31) || (p === 100 && q >= 64 && q <= 127)) out.push(a.address)
  }
  return [...new Set(out)]
}
/** The Mac's Bonjour name (what the phone can also reach it by): "Your-MacBook-Pro.local" */
export const localName = () => `${hostname().replace(/\.local$/i, '').replace(/[^a-z0-9-]/gi, '-').slice(0, 60) || 'astrala'}.local`

const PRIVATE = ['IP:10.0.0.0/255.0.0.0', 'IP:172.16.0.0/255.240.0.0', 'IP:192.168.0.0/255.255.0.0', 'IP:100.64.0.0/255.192.0.0']
/**
 * The certificate authority (made once) and a server certificate for today's addresses (remade when they change).
 * Returns the server key and certificate, and the authority's certificate for the phone to install.
 */
export async function ensureCerts(dir: string, ips: string[], name: string): Promise<{ key: Buffer; cert: Buffer; ca: Buffer }> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const f = (n: string) => join(dir, n)
  const ossl = (args: string[]) => run('openssl', args, { cwd: dir, timeout: 20_000 })
  if (!existsSync(f('ca.crt')) || !existsSync(f('ca.key'))) {
    await writeFile(f('ca.cnf'), [
      '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no', '[dn]', `CN=Astrala on ${name.replace(/\.local$/, '')}`,
      '[v3]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash',
      // trusted only for this kind of name, nowhere on the internet
      `nameConstraints=critical,${[...PRIVATE, 'DNS:.local'].map((x) => `permitted;${x}`).join(',')}`
    ].join('\n'))
    await ossl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650', '-config', 'ca.cnf'])
    await chmod(f('ca.key'), 0o600)
  }
  const sans = [...ips.map((ip) => `IP:${ip}`), `DNS:${name}`].join(',')
  const had = existsSync(f('srv.sans')) ? readFileSync(f('srv.sans'), 'utf8') : ''
  if (had !== sans || !existsSync(f('srv.crt')) || !existsSync(f('srv.key'))) {
    await writeFile(f('srv.cnf'), ['basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=serverAuth', `subjectAltName=${sans}`].join('\n'))
    await ossl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', `/CN=${name}`])
    // 397 days: the longest a phone accepts for a server certificate
    await ossl(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '397', '-extfile', 'srv.cnf'])
    await chmod(f('srv.key'), 0o600)
    await writeFile(f('srv.sans'), sans)
  }
  return { key: await readFile(f('srv.key')), cert: await readFile(f('srv.crt')), ca: await readFile(f('ca.crt')) }
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.jpg': 'image/jpeg' }
const MANIFEST = JSON.stringify({ name: 'Astrala', short_name: 'Astrala', start_url: '/?phone', scope: '/', display: 'standalone', background_color: '#050507', theme_color: '#050507',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] })

/** The wallet's page, told it's on a phone: the tunnel script first, then a Home Screen app's icon and manifest. */
export function phonePage(html: string): string {
  if (!html.includes('<script type="module"')) throw new Error('no module script in index.html')
  return html
    .replace('<head>', '<head>\n    <meta name="apple-mobile-web-app-capable" content="yes" /><meta name="mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" /><meta name="apple-mobile-web-app-title" content="Astrala" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" /><link rel="manifest" href="/manifest.webmanifest" /><meta name="theme-color" content="#050507" />')
    .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />')
    .replace('<script type="module"', '<script src="/phone-tunnel.js"></script>\n    <script type="module"')
}

let server: https.Server | null = null
export const phoneRunning = () => !!server

/** Serve the wallet to the phone. root: the built renderer (the same files the desktop window loads). */
export async function startPhone(host: BridgeHost, root: string, certDir: string): Promise<{ ok: boolean; error?: string }> {
  if (server) return { ok: true }
  let tls: Awaited<ReturnType<typeof ensureCerts>>
  try { tls = await ensureCerts(certDir, lanAddresses(), localName()) } catch (e: any) { return { ok: false, error: `Could not make the phone's certificate: ${String(e?.message ?? e).slice(0, 160)}` } }
  const api = requestListener(host, 'phone')
  const base = normalize(root + sep)
  const s = https.createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
    const head = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin' }
    if (req.method === 'POST') return api(req, res)
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, head); return res.end() }
    const path = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (path === '/astrala-local.crt') { res.writeHead(200, { ...head, 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="Astrala local.crt"' }); return res.end(tls.ca) }
    if (path === '/manifest.webmanifest') { res.writeHead(200, { ...head, 'content-type': TYPES['.webmanifest'] }); return res.end(MANIFEST) }
    const file = normalize(join(base, path === '/' ? 'index.html' : path))
    if (!file.startsWith(base)) { res.writeHead(404, head); return res.end() } // nothing outside the wallet's own files
    try {
      const page = file.endsWith(`${sep}index.html`)
      const body = page ? Buffer.from(phonePage(await readFile(file, 'utf8'))) : await readFile(file)
      res.writeHead(200, { ...head, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': page ? 'no-store' : 'public, max-age=31536000, immutable' })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch { res.writeHead(404, head); res.end() }
  })
  const ok = await new Promise<boolean>((done) => { s.once('error', () => done(false)); s.listen(PHONE_PORT, '0.0.0.0', () => done(true)) })
  if (!ok) return { ok: false, error: `Port ${PHONE_PORT} is in use by another app` }
  server = s
  return { ok: true }
}
export function stopPhone() { server?.close(); server?.closeAllConnections?.(); server = null }
