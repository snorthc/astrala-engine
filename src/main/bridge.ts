// The browser extension's door into Astrala: a small HTTP listener on 127.0.0.1 only, off unless switched on in
// Settings. The extension holds no keys and decides nothing. It forwards what a website asks; this file answers
// what is safe to answer (which account, which network, read-only chain calls) and asks the person, in the app
// window, before a site learns an address. Signing is never decided here: a message, typed data or a transaction is
// handed to the app, which shows what it is and signs only after the person reviews it and enters their PIN.
// Raw hashes (eth_sign) and pre-built transactions are refused outright.
//
// Who may talk to it:
//   - only a browser extension (the Origin header, which a web page cannot forge), on a loopback Host;
//   - only the one extension the person paired, by comparing a 6-digit code shown in both places. Pairing hands
//     the extension a random token; only its SHA-256 is kept.
// Pure Node (no Electron) so the rules can be tested on their own: see test/bridge.test.ts.
import http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const BRIDGE_PORTS = [47821, 47822, 47823]

export interface Site { account: number; chainId: number; at: number }
export type Ask = { kind: 'pair'; code: string; ext: string } | { kind: 'connect'; origin: string }
export interface BridgeHost {
  unlocked(): boolean
  /** the paired extension's token hash (kept outside the vault, so it is the same whichever wallet is open) */
  pairHash(): string | null
  setPair(hash: string | null): Promise<void> | void
  /** connected sites, inside the vault: which sites you use is private */
  sites(): Record<string, Site>
  save(): Promise<void> | void
  /** ask the person in the app window; false on "no", lock or timeout */
  ask(q: Ask): Promise<boolean>
  account(): number
  address(account: number): string | null
  /** EVM chain id → Astrala network id */
  chains: Record<number, string>
  /** a read-only JSON-RPC call, sent the way the app sends its own (through Astral Route) */
  read(network: string, method: string, params: unknown[]): Promise<unknown>
  /** For the extension's on-page warning: the well-known site this one imitates (or null), and whether the Drain guard is on. */
  site(origin: string): { imitates: string | null; guard: boolean }
  /** One call from the wallet screens running in the extension: the same call the desktop window makes over IPC.
   *  `denied`: this one stays in the app (seed phrase, backups, removing the wallet, updates). */
  ipc(name: string, args: unknown[]): Promise<{ result?: unknown; denied?: true }>
  /** What main has told its screens since `after` (balances arriving, activity, questions): waits up to ~25 s for news. */
  events(after: number): Promise<{ seq: number; events: { seq: number; channel: string; args: unknown[] }[] }>
  /** a signing request from a connected site: review, PIN, then the signature or transaction hash. Rejects with RpcError. */
  sign(origin: string, site: Site, method: string, params: unknown[]): Promise<unknown>
}

export class RpcError extends Error { constructor(public code: number, message: string) { super(message) } }

/** Read-only chain calls a site may make once connected. Anything not listed is refused. */
const READS = new Set(['eth_blockNumber', 'eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
  'eth_estimateGas', 'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs', 'eth_getStorageAt'])
/** Signed only after review and PIN in the app. */
const SIGNABLE = new Set(['personal_sign', 'eth_signTypedData_v4', 'eth_signTypedData', 'eth_sendTransaction'])
/** Never: a raw hash can be anything, and a pre-built transaction can't be reviewed field by field. */
const NEVER = /^(eth_sign|eth_sendRawTransaction|eth_signTransaction|eth_signTypedData_v[13]|eth_decrypt|eth_getEncryptionPublicKey)$/
const hex = (n: number) => '0x' + n.toString(16)

export function stateOf(host: BridgeHost, origin: string) {
  const s = host.sites()[origin], a = s && host.address(s.account)
  return { accounts: a ? [a] : [], chainId: hex(s?.chainId ?? 1) }
}

/** One request from one website. Throws RpcError with the standard wallet codes (4001 refused, 4100 not connected, 4200 unsupported, 4902 unknown chain). */
export async function handleRpc(host: BridgeHost, origin: string, method: string, params: unknown[]): Promise<unknown> {
  const sites = host.sites()
  const perms = () => (sites[origin] ? [{ parentCapability: 'eth_accounts' }] : [])
  switch (method) {
    case 'eth_requestAccounts':
    case 'wallet_requestPermissions': {
      if (!sites[origin]) {
        if (!(await host.ask({ kind: 'connect', origin }))) throw new RpcError(4001, 'You declined the connection in Astrala')
        if (!host.address(host.account())) throw new RpcError(4100, 'This account has no address a website can use')
        sites[origin] = { account: host.account(), chainId: 1, at: Date.now() }
        await host.save()
      }
      return method === 'eth_requestAccounts' ? stateOf(host, origin).accounts : perms()
    }
    case 'eth_accounts': return stateOf(host, origin).accounts
    case 'eth_chainId': return stateOf(host, origin).chainId
    case 'net_version': return String(sites[origin]?.chainId ?? 1)
    case 'wallet_getPermissions': return perms()
    case 'wallet_revokePermissions': if (sites[origin]) { delete sites[origin]; await host.save() } return null
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain': {
      const id = Number((params[0] as { chainId?: string } | undefined)?.chainId)
      if (!sites[origin]) throw new RpcError(4100, 'Connect this site to Astrala first')
      if (!Number.isInteger(id) || !host.chains[id]) throw new RpcError(method === 'wallet_switchEthereumChain' ? 4902 : 4200, "Astrala doesn't have that network")
      if (sites[origin].chainId !== id) { sites[origin].chainId = id; await host.save() }
      return null
    }
  }
  if (NEVER.test(method)) throw new RpcError(4200, "Astrala doesn't sign raw hashes, old-format data or pre-built transactions for websites")
  if (SIGNABLE.has(method)) {
    if (!sites[origin]) throw new RpcError(4100, 'Connect this site to Astrala first')
    return host.sign(origin, sites[origin], method, params)
  }
  if (!READS.has(method)) throw new RpcError(4200, `Astrala doesn't support ${method.slice(0, 60)}`)
  if (!sites[origin]) throw new RpcError(4100, 'Connect this site to Astrala first')
  return host.read(host.chains[sites[origin].chainId], method, params)
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
/** Does this token match the paired extension? Constant-time. */
export function tokenOk(host: BridgeHost, token: string | undefined): boolean {
  const want = host.pairHash()
  if (!want || !token) return false
  const a = Buffer.from(sha(token)), b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}
const EXT_ORIGIN = /^(chrome|moz)-extension:\/\/[a-z0-9-]{8,64}$/i
const siteOrigin = (o: unknown) => { try { const u = new URL(String(o)); return /^https?:$/.test(u.protocol) && u.origin === o ? u.origin : null } catch { return null } }

/** The phone's page origin: https, an IP address or a .local name, and the very host the request came to. */
export function phoneOriginOk(origin: string, hostHeader: string | undefined): boolean {
  if (!hostHeader || origin !== `https://${hostHeader}`) return false
  const name = hostHeader.replace(/:\d+$/, '')
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(name) || /^[a-z0-9-]{1,63}\.local$/i.test(name)
}

let server: http.Server | null = null, port: number | null = null, pairing = false, pairCooldown = 0
export const bridgePort = () => port

/**
 * mode 'phone': the same door for the iPhone web app (main/phone.ts serves it over HTTPS on the local network).
 * The page and the door share one origin, so a request must carry exactly that Origin (another website open on the
 * phone, or one rebinding a hostname, can't), there are no cross-origin headers, and only the wallet's own screens
 * are served: no website connections or signing.
 */
export function requestListener(host: BridgeHost, mode: 'extension' | 'phone' = 'extension'): http.RequestListener {
  return async (req, res) => {
    const origin = req.headers.origin ?? ''
    const phone = mode === 'phone'
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(!phone && EXT_ORIGIN.test(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' } : {}) })
      res.end(JSON.stringify(body))
    }
    try {
      // a web page can reach 127.0.0.1 too, but it cannot fake these two headers
      if (phone ? !phoneOriginOk(origin, req.headers.host) : !EXT_ORIGIN.test(origin) || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(403, { error: 'forbidden' })
      if (phone && req.method === 'OPTIONS') return send(404, { error: 'not found' })
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST', vary: 'Origin' }); return res.end() }
      const url = (req.url ?? '').split('?')[0]
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      // Everything is a POST, /hello included: Chrome only puts an extension's Origin on requests that aren't GET,
      // and that header is the one thing a web page can't fake.
      if (req.method !== 'POST') return send(404, { error: 'not found' })
      if (url === '/hello') { req.resume(); return send(200, { astrala: 1, unlocked: host.unlocked(), paired: tokenOk(host, token) }) }
      const chunks: Buffer[] = []; let size = 0
      for await (const c of req) { size += (c as Buffer).length; if (size > 2 * 1024 * 1024) return send(413, { error: 'too large' }); chunks.push(c as Buffer) }
      let body: any
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { return send(400, { error: 'bad json' }) }

      if (url === '/pair') {
        if (!host.unlocked()) return send(423, { error: 'locked' })
        if (!/^\d{6}$/.test(String(body?.code))) return send(400, { error: 'bad code' })
        if (pairing || Date.now() < pairCooldown) return send(429, { error: 'busy' }) // one question at a time, and no hammering after a "no"
        pairing = true
        let ok = false
        try { ok = await host.ask({ kind: 'pair', code: String(body.code), ext: phone ? 'iphone' : origin.replace(/^[a-z-]+:\/\//i, '') }) } finally { pairing = false }
        if (!ok) { pairCooldown = Date.now() + 10_000; return send(403, { error: 'declined' }) }
        const fresh = randomBytes(32).toString('hex')
        await host.setPair(sha(fresh))
        return send(200, { token: fresh })
      }
      // The extension's own pages (never a website: only they hold the pairing token) run the wallet's real screens.
      // Each call is one the desktop window could make; main's own gates (PIN, system confirmation, limits) still apply.
      if (url === '/ipc' || url === '/events') {
        if (!tokenOk(host, token)) return send(401, { error: 'unpaired' })
        if (url === '/events') return send(200, await host.events(Number.isInteger(body?.after) ? body.after : -1))
        const name = String(body?.name ?? '')
        if (!/^[a-zA-Z]{1,40}$/.test(name) || !Array.isArray(body?.args)) return send(400, { error: 'bad request' })
        try { return send(200, await host.ipc(name, body.args)) } catch (e: any) { return send(200, { error: String(e?.message ?? e).slice(0, 300) }) }
      }
      if (phone) return send(404, { error: 'not found' }) // the phone runs the wallet's screens, never a website's requests
      if (url === '/site') {
        if (!tokenOk(host, token)) return send(401, { error: 'unpaired' })
        const site = siteOrigin(body?.origin)
        return site ? send(200, host.site(site)) : send(400, { error: 'bad request' })
      }
      if (url === '/rpc') {
        if (!tokenOk(host, token)) return send(401, { error: 'unpaired' })
        if (!host.unlocked()) return send(200, { error: { code: 4900, message: 'Astrala is locked. Unlock it and try again.' } })
        const site = siteOrigin(body?.origin), method = String(body?.method ?? ''), params = Array.isArray(body?.params) ? body.params : body?.params == null ? [] : [body.params]
        if (!site || !/^[a-zA-Z0-9_]{1,64}$/.test(method)) return send(400, { error: 'bad request' })
        try { return send(200, { result: (await handleRpc(host, site, method, params)) ?? null, state: stateOf(host, site) }) }
        catch (e) {
          const err = e instanceof RpcError ? { code: e.code, message: e.message } : { code: -32603, message: "Astrala couldn't reach the network for that" }
          return send(200, { error: err, state: host.unlocked() ? stateOf(host, site) : undefined })
        }
      }
      return send(404, { error: 'not found' })
    } catch { if (!res.headersSent) send(500, { error: 'internal' }); else res.end() }
  }
}

/** Open the door (first free port of BRIDGE_PORTS). Resolves with the port, or null if none could be bound. */
export async function startBridge(host: BridgeHost): Promise<number | null> {
  if (server) return port
  for (const p of BRIDGE_PORTS) {
    const s = http.createServer(requestListener(host))
    const ok = await new Promise<boolean>((done) => { s.once('error', () => done(false)); s.listen(p, '127.0.0.1', () => done(true)) })
    if (ok) { server = s; port = p; return p }
  }
  return null
}
export function stopBridge() { server?.close(); server?.closeAllConnections?.(); server = null; port = null }
