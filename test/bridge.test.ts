import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { requestListener, handleRpc, RpcError, type BridgeHost, type Site, type Ask } from '../src/main/bridge'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
function fakeHost(over: Partial<BridgeHost> = {}) {
  const st = { hash: null as string | null, sites: {} as Record<string, Site>, asked: [] as Ask[], answer: true, unlocked: true, reads: [] as unknown[], signs: [] as string[], opened: [] as string[] }
  const host: BridgeHost = {
    unlocked: () => st.unlocked, pairHash: () => st.hash, setPair: (h) => { st.hash = h }, sites: () => st.sites, save: () => {},
    ask: async (q) => { st.asked.push(q); return st.answer },
    account: () => 0, address: (i) => (i === 0 ? '0x1111111111111111111111111111111111111111' : null),
    chains: { 1: 'ethereum', 8453: 'base' },
    read: async (network, method, params) => { st.reads.push([network, method, params]); return '0x10' },
    sign: async (_o, _s, method) => { st.signs.push(method); return '0xsigned' },
    site: (origin) => ({ imitates: origin.includes('unlswap') ? 'uniswap.org' : null, guard: true }),
    ipc: async (name, args) => (name === 'revealMnemonic' ? { denied: true } : name === 'boom' ? Promise.reject(new Error('nope')) : { result: { name, args } }),
    events: async (after) => ({ seq: 7, events: after < 7 && after >= 0 ? [{ seq: 7, channel: 'balance', args: [{ account: 0 }] }] : [] }),
    ...over
  }
  return { host, st }
}

describe('bridge rules for a website', () => {
  it('gives no address until the person approves, then remembers the site', async () => {
    const { host, st } = fakeHost()
    expect(await handleRpc(host, 'https://app.example', 'eth_accounts', [])).toEqual([])
    st.answer = false
    await expect(handleRpc(host, 'https://app.example', 'eth_requestAccounts', [])).rejects.toMatchObject({ code: 4001 })
    expect(st.sites).toEqual({})
    st.answer = true
    expect(await handleRpc(host, 'https://app.example', 'eth_requestAccounts', [])).toEqual(['0x1111111111111111111111111111111111111111'])
    expect(st.asked).toHaveLength(2)
    await handleRpc(host, 'https://app.example', 'eth_requestAccounts', []) // already connected: no second question
    expect(st.asked).toHaveLength(2)
    expect(await handleRpc(host, 'https://other.example', 'eth_accounts', [])).toEqual([]) // per site
  })
  it('hands a signing request to the app only for a connected site, and never signs a raw hash or a pre-built transaction', async () => {
    const { host, st } = fakeHost()
    await expect(handleRpc(host, 'https://app.example', 'personal_sign', ['0x00', '0x11'])).rejects.toMatchObject({ code: 4100 })
    expect(st.signs).toEqual([])
    await handleRpc(host, 'https://app.example', 'eth_requestAccounts', [])
    for (const m of ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction']) expect(await handleRpc(host, 'https://app.example', m, [{}])).toBe('0xsigned')
    expect(st.signs).toEqual(['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'])
    for (const m of ['eth_sign', 'eth_sendRawTransaction', 'eth_signTransaction', 'eth_signTypedData_v1', 'eth_signTypedData_v3', 'eth_decrypt'])
      await expect(handleRpc(host, 'https://app.example', m, [{}])).rejects.toMatchObject({ code: 4200 })
    expect(st.signs).toHaveLength(3)
  })
  it('only passes listed read calls, only for a connected site, on the site\'s own chain', async () => {
    const { host, st } = fakeHost()
    await expect(handleRpc(host, 'https://app.example', 'eth_call', [{}])).rejects.toMatchObject({ code: 4100 })
    await handleRpc(host, 'https://app.example', 'eth_requestAccounts', [])
    await expect(handleRpc(host, 'https://app.example', 'debug_traceCall', [])).rejects.toBeInstanceOf(RpcError)
    await expect(handleRpc(host, 'https://app.example', 'wallet_switchEthereumChain', [{ chainId: '0x539' }])).rejects.toMatchObject({ code: 4902 })
    await handleRpc(host, 'https://app.example', 'wallet_switchEthereumChain', [{ chainId: '0x2105' }])
    expect(await handleRpc(host, 'https://app.example', 'eth_chainId', [])).toBe('0x2105')
    expect(await handleRpc(host, 'https://app.example', 'eth_getBalance', ['0xabc', 'latest'])).toBe('0x10')
    expect(st.reads).toEqual([['base', 'eth_getBalance', ['0xabc', 'latest']]])
    await handleRpc(host, 'https://app.example', 'wallet_revokePermissions', [])
    expect(await handleRpc(host, 'https://app.example', 'eth_accounts', [])).toEqual([])
  })
})

describe('bridge listener', () => {
  const { host, st } = fakeHost()
  const server = http.createServer(requestListener(host))
  let base = ''
  beforeAll(async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
  afterAll(() => { server.close() })
  // fetch won't let a test set Origin or Host, so speak HTTP directly
  const call = (path: string, o: { method?: string; origin?: string; host?: string; token?: string; body?: unknown } = {}) => new Promise<{ status: number; json: any }>((done, fail) => {
    const u = new URL(base + path)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: o.method ?? (o.body ? 'POST' : 'GET'), headers: { ...(o.origin !== '' ? { origin: o.origin ?? EXT } : {}), host: o.host ?? u.host, ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), 'content-type': 'application/json' } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json: any = {}; try { json = JSON.parse(d) } catch { /* empty */ } done({ status: res.statusCode!, json }) }) })
    req.on('error', fail); req.end(o.body ? JSON.stringify(o.body) : undefined)
  })

  it('turns away web pages, missing origins and rebinding hosts', async () => {
    expect((await call('/hello', { origin: 'https://evil.example', body: {} })).status).toBe(403)
    expect((await call('/hello', { origin: '', body: {} })).status).toBe(403)
    expect((await call('/hello', { host: 'evil.example', body: {} })).status).toBe(403)
    expect((await call('/hello')).status).toBe(404) // a GET is never answered: a page can send one with no Origin at all
    expect((await call('/hello', { body: {} })).json).toMatchObject({ astrala: 1, paired: false })
  })
  it('needs pairing before any request, and pairing needs a yes in the app', async () => {
    expect((await call('/rpc', { body: { origin: 'https://app.example', method: 'eth_accounts' } })).status).toBe(401)
    expect((await call('/rpc', { token: 'guess', body: { origin: 'https://app.example', method: 'eth_accounts' } })).status).toBe(401)
    expect((await call('/pair', { body: { code: 'abc' } })).status).toBe(400)
    const paired = await call('/pair', { body: { code: '123456' } })
    expect(st.asked.at(-1)).toEqual({ kind: 'pair', code: '123456', ext: 'abcdefghijklmnopabcdefghijklmnop' }) // the app shows which extension asked
    expect(paired.status).toBe(200)
    expect(st.hash).toBe(createHash('sha256').update(paired.json.token).digest('hex')) // only the hash is kept
    const r = await call('/rpc', { token: paired.json.token, body: { origin: 'https://app.example', method: 'eth_requestAccounts' } })
    expect(r.json).toMatchObject({ result: ['0x1111111111111111111111111111111111111111'], state: { chainId: '0x1' } })
    expect((await call('/rpc', { token: paired.json.token, body: { origin: 'javascript:alert(1)', method: 'eth_accounts' } })).status).toBe(400)
    const sign = await call('/rpc', { token: paired.json.token, body: { origin: 'https://app.example', method: 'eth_sign', params: ['0x11', '0x22'] } })
    expect(sign.json.error.code).toBe(4200)
    st.unlocked = false
    expect((await call('/rpc', { token: paired.json.token, body: { origin: 'https://app.example', method: 'eth_accounts' } })).json.error.code).toBe(4900)
    st.unlocked = true
    // the extension's look-alike check: paired only, and only for a real web origin
    expect((await call('/site', { body: { origin: 'https://unlswap.org' } })).status).toBe(401)
    expect((await call('/site', { token: paired.json.token, body: { origin: 'https://unlswap.org' } })).json).toEqual({ imitates: 'uniswap.org', guard: true })
    expect((await call('/site', { token: paired.json.token, body: { origin: 'https://app.uniswap.org' } })).json).toEqual({ imitates: null, guard: true })
    expect((await call('/site', { token: paired.json.token, body: { origin: 'chrome://settings' } })).status).toBe(400)
    // the wallet screens in the extension: the paired token only; app-only calls come back denied; errors are reported
    expect((await call('/ipc', { body: { name: 'state', args: [] } })).status).toBe(401)
    expect((await call('/ipc', { token: paired.json.token, body: { name: 'state', args: [1, 'a'] } })).json).toEqual({ result: { name: 'state', args: [1, 'a'] } })
    expect((await call('/ipc', { token: paired.json.token, body: { name: 'revealMnemonic', args: ['pw'] } })).json).toEqual({ denied: true })
    expect((await call('/ipc', { token: paired.json.token, body: { name: 'boom', args: [] } })).json).toEqual({ error: 'nope' })
    expect((await call('/ipc', { token: paired.json.token, body: { name: '../x', args: [] } })).status).toBe(400)
    expect((await call('/events', { body: { after: 0 } })).status).toBe(401)
    expect((await call('/events', { token: paired.json.token, body: { after: 3 } })).json).toEqual({ seq: 7, events: [{ seq: 7, channel: 'balance', args: [{ account: 0 }] }] })
  })
})
