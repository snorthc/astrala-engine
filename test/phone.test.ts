// The iPhone door: its certificate (made with this Mac's openssl), its origin rule and the page it serves.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { ensureCerts, phonePage } from '../src/main/phone'
import { phoneOriginOk } from '../src/main/bridge'

describe('phone certificate', () => {
  it('makes an authority trusted only for local names, and a server certificate for these addresses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'astrala-phone-'))
    const t = await ensureCerts(dir, ['192.168.1.20', '100.101.102.103'], 'test-mac.local')
    const ca = new X509Certificate(t.ca), srv = new X509Certificate(t.cert)
    expect(ca.ca).toBe(true)
    expect(srv.ca).toBe(false)
    expect(srv.verify(ca.publicKey)).toBe(true)
    expect(srv.subjectAltName).toContain('IP Address:192.168.1.20')
    expect(srv.subjectAltName).toContain('DNS:test-mac.local')
    const text = execFileSync('openssl', ['x509', '-in', join(dir, 'ca.crt'), '-noout', '-text']).toString()
    expect(text).toMatch(/Name Constraints: critical/)
    expect(text).toMatch(/Permitted:[\s\S]*DNS:\.local/)
    // the server certificate passes the authority's own rules (its names are inside the permitted ones)
    expect(() => execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'srv.crt')]).toString()).not.toThrow()
    // same addresses: the same certificate; new addresses: a new one from the same authority
    const again = await ensureCerts(dir, ['192.168.1.20', '100.101.102.103'], 'test-mac.local')
    expect(again.cert.equals(t.cert)).toBe(true)
    const moved = await ensureCerts(dir, ['10.0.0.5'], 'test-mac.local')
    expect(moved.cert.equals(t.cert)).toBe(false)
    expect(moved.ca.equals(t.ca)).toBe(true)
    expect(readFileSync(join(dir, 'srv.sans'), 'utf8')).toBe('IP:10.0.0.5,DNS:test-mac.local')
  }, 60_000)
})

describe('phone origin rule', () => {
  it('takes only the page served from this very https address', () => {
    expect(phoneOriginOk('https://192.168.1.20:47830', '192.168.1.20:47830')).toBe(true)
    expect(phoneOriginOk('https://test-mac.local:47830', 'test-mac.local:47830')).toBe(true)
    expect(phoneOriginOk('http://192.168.1.20:47830', '192.168.1.20:47830')).toBe(false) // not https
    expect(phoneOriginOk('https://evil.example', '192.168.1.20:47830')).toBe(false) // another website
    expect(phoneOriginOk('https://evil.example:47830', 'evil.example:47830')).toBe(false) // a rebound hostname
    expect(phoneOriginOk('', '192.168.1.20:47830')).toBe(false)
  })
  it('serves the wallet page with the tunnel first and Home Screen app tags', () => {
    const html = phonePage('<!doctype html><html><head><meta name="viewport" content="width=device-width" /></head><body><script type="module" src="/a.js"></script></body></html>')
    expect(html.indexOf('/phone-tunnel.js')).toBeLessThan(html.indexOf('type="module"'))
    expect(html).toContain('apple-mobile-web-app-capable')
    expect(html).toContain('viewport-fit=cover')
  })
})

describe('phone server', () => {
  it('serves the wallet over HTTPS to its own origin only, with no website routes', async () => {
    const { startPhone, stopPhone, PHONE_PORT } = await import('../src/main/phone')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const https = await import('node:https')
    const root = mkdtempSync(join(tmpdir(), 'astrala-root-')), certs = mkdtempSync(join(tmpdir(), 'astrala-tls-'))
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="x" /></head><body><script type="module" src="/assets/a.js"></script></body></html>')
    writeFileSync(join(root, 'assets', 'a.js'), 'console.log(1)')
    let hash: string | null = null
    const host: any = { unlocked: () => true, pairHash: () => hash, setPair: async (h: string) => { hash = h }, ask: async () => true, ipc: async (n: string) => ({ result: n }), events: async () => ({ seq: 1, events: [] }) }
    const r = await startPhone(host, root, certs)
    expect(r.ok).toBe(true)
    const ca = readFileSync(join(certs, 'ca.crt'))
    const ask = (path: string, o: { method?: string; origin?: string; body?: unknown; token?: string } = {}) => new Promise<{ status: number; body: string; type?: string }>((done, fail) => {
      const q = https.request({ host: '127.0.0.1', port: PHONE_PORT, path, method: o.method ?? 'GET', ca, servername: 'test', checkServerIdentity: () => undefined,
        headers: { host: `192.168.1.20:${PHONE_PORT}`, ...(o.origin ? { origin: o.origin } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), 'content-type': 'application/json' } },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => done({ status: res.statusCode!, body: d, type: res.headers['content-type'] })) })
      q.on('error', fail); q.end(o.body ? JSON.stringify(o.body) : undefined)
    })
    const me = `https://192.168.1.20:${PHONE_PORT}`
    try {
      const page = await ask('/')
      expect(page.status).toBe(200)
      expect(page.body).toContain('/phone-tunnel.js')
      expect((await ask('/assets/a.js')).status).toBe(200)
      expect((await ask('/../../etc/passwd')).status).toBe(404) // nothing outside the wallet's files
      expect((await ask('/%2e%2e/%2e%2e/etc/hosts')).status).toBe(404)
      expect((await ask('/astrala-local.crt')).type).toBe('application/x-x509-ca-cert')
      expect((await ask('/hello', { method: 'POST', origin: 'https://evil.example', body: {} })).status).toBe(403)
      expect((await ask('/hello', { method: 'POST', body: {} })).status).toBe(403) // no origin at all
      expect(JSON.parse((await ask('/hello', { method: 'POST', origin: me, body: {} })).body)).toMatchObject({ astrala: 1, paired: false })
      expect((await ask('/ipc', { method: 'POST', origin: me, body: { name: 'state', args: [] } })).status).toBe(401)
      const paired = JSON.parse((await ask('/pair', { method: 'POST', origin: me, body: { code: '123456' } })).body)
      expect(paired.token).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.parse((await ask('/ipc', { method: 'POST', origin: me, token: paired.token, body: { name: 'state', args: [] } })).body)).toEqual({ result: 'state' })
      expect((await ask('/rpc', { method: 'POST', origin: me, token: paired.token, body: { origin: 'https://x.example', method: 'eth_accounts' } })).status).toBe(404) // no website routes
    } finally { stopPhone() }
  }, 60_000)
})
