// Discord status ("Rich Presence"), over Discord's own local socket. Nothing here touches the network: Astrala
// writes to the Discord app running on this computer, and Discord shows it on your profile. Off unless switched on
// in Settings, and main only ever calls this for an unlocked, real (not decoy) wallet.
import net from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface Presence { details: string; state?: string; since?: number }
export type DiscordState = 'off' | 'on' | 'waiting'

/** One message on the socket: 4-byte opcode, 4-byte length (little-endian), then JSON. */
export function frame(op: number, body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body))
  const head = Buffer.alloc(8)
  head.writeInt32LE(op, 0); head.writeInt32LE(json.length, 4)
  return Buffer.concat([head, json])
}
/** Splits what has arrived into whole messages; `rest` is the unfinished tail to keep for the next chunk. */
export function unframe(buf: Buffer): { msgs: { op: number; body: any }[]; rest: Buffer } {
  const msgs: { op: number; body: any }[] = []
  while (buf.length >= 8) {
    const len = buf.readInt32LE(4)
    if (len < 0 || len > 1 << 20) return { msgs, rest: Buffer.alloc(0) } // not Discord talking: drop it
    if (buf.length < 8 + len) break
    try { msgs.push({ op: buf.readInt32LE(0), body: JSON.parse(buf.subarray(8, 8 + len).toString()) }) } catch { /* skip a bad one */ }
    buf = buf.subarray(8 + len)
  }
  return { msgs, rest: buf }
}
/** Discord takes 2 to 128 characters a line. */
export const line = (s: unknown) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 128); return t.length >= 2 ? t : undefined }

const pipes = () => process.platform === 'win32'
  ? Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`)
  : [...new Set([process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, tmpdir(), '/tmp'].filter((d): d is string => !!d))]
      .flatMap((d) => [d, join(d, 'app/com.discordapp.Discord'), join(d, 'snap.discord')])
      .flatMap((d) => Array.from({ length: 10 }, (_, i) => join(d, `discord-ipc-${i}`)))

let sock: net.Socket | null = null, connecting: net.Socket | null = null, ready = false, appId = '', want: Presence | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let gen = 0 // bumped by drop(): a socket from before it must not carry on trying the next pipe

function push() {
  if (!sock || !ready) return
  const a = want
  sock.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: `${Date.now()}-${Math.random()}`, args: { pid: process.pid, activity: a ? {
    details: a.details, ...(a.state ? { state: a.state } : {}), ...(a.since ? { timestamps: { start: Math.round(a.since) } } : {}),
    assets: { large_image: 'astrala', large_text: 'Astrala Wallet' }, instance: false
  } : null } }))
}
function drop() { gen++; sock?.destroy(); connecting?.destroy(); sock = null; connecting = null; ready = false }
function connect(list?: string[]) {
  const first = list === undefined
  list ??= pipes()
  if (sock || !want || (connecting && first)) return // a connection is already being tried
  const path = list.shift()
  if (!path) { if (!retry) retry = setTimeout(() => { retry = null; connect() }, 30_000); return } // Discord isn't open: look again in a while
  const g = gen, s = net.createConnection(path)
  connecting = s
  let buf: Buffer = Buffer.alloc(0), mine = false
  s.once('connect', () => { mine = true; sock = s; if (connecting === s) connecting = null; s.write(frame(0, { v: 1, client_id: appId })) })
  s.on('data', (d: Buffer) => {
    const r = unframe(Buffer.concat([buf, d])); buf = r.rest
    for (const m of r.msgs) {
      if (m.op === 3) s.write(frame(4, m.body)) // ping
      else if (m.op === 2) s.destroy() // Discord closed it (a wrong application ID lands here)
      else if (m.op === 1 && m.body?.evt === 'READY') { ready = true; push() }
    }
  })
  s.on('error', () => { /* 'close' follows */ })
  s.once('close', () => { if (connecting === s) connecting = null; if (g !== gen || (sock !== s && mine)) return; if (mine) { if (sock === s) { sock = null; ready = false } if (want && !retry) retry = setTimeout(() => { retry = null; connect() }, 30_000) } else connect(list) })
}

/** Show this on Discord (or nothing, with null). Resolves once Discord has it, or 'waiting' if Discord isn't answering. */
export function setPresence(id: string, p: Presence | null): Promise<DiscordState> {
  want = p
  if (!p) { if (retry) { clearTimeout(retry); retry = null } gen++; connecting?.destroy(); connecting = null; if (sock && ready) { push(); const s = sock; setTimeout(() => s.destroy(), 300) } else drop(); sock = null; ready = false; return Promise.resolve('off') }
  if (id !== appId) { drop(); appId = id }
  if (sock && ready) { push(); return Promise.resolve('on') }
  connect()
  return new Promise((done) => { let n = 0; const t = setInterval(() => { if (ready || ++n >= 15) { clearInterval(t); done(ready ? 'on' : 'waiting') } }, 100) })
}
