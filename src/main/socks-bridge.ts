// A tiny local SOCKS5 server that tunnels each connection through an HTTP proxy (CONNECT).
// Monero's wallet library only speaks SOCKS, so this lets HTTP proxies cover Monero too.
// Listens on 127.0.0.1 only; hostnames are passed to the proxy unresolved (no local DNS).
import { createServer, connect, type Server, type Socket } from 'node:net'

export async function startSocksBridge(httpProxy: string): Promise<{ port: number; close: () => void }> {
  const u = new URL(httpProxy)
  const proxyHost = u.hostname, proxyPort = Number(u.port || 80)
  const auth = u.username ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') : ''

  const server: Server = createServer((client: Socket) => {
    client.once('data', (hello: Buffer) => {
      if (hello[0] !== 5) return client.destroy()
      client.write(Buffer.from([5, 0])) // no auth
      client.once('data', (req: Buffer) => {
        if (req[0] !== 5 || req[1] !== 1) { client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return }
        let host = '', i = 4
        if (req[3] === 1) { host = [...req.subarray(4, 8)].join('.'); i = 8 }
        else if (req[3] === 3) { const n = req[4]; host = req.subarray(5, 5 + n).toString(); i = 5 + n }
        else if (req[3] === 4) { const b = req.subarray(4, 20); host = `[${[...Array(8)].map((_, k) => b.readUInt16BE(k * 2).toString(16)).join(':')}]`; i = 20 }
        else { client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return }
        const port = req.readUInt16BE(i)
        const up = connect(proxyPort, proxyHost)
        up.once('error', () => { client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])) })
        up.once('connect', () => {
          up.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`)
          let head = Buffer.alloc(0)
          const onData = (d: Buffer) => {
            head = Buffer.concat([head, d])
            const end = head.indexOf('\r\n\r\n')
            if (end < 0) return
            up.off('data', onData)
            if (!/^HTTP\/1\.[01] 200/.test(head.subarray(0, end).toString())) { client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); up.destroy(); return }
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            const rest = head.subarray(end + 4)
            if (rest.length) client.write(rest)
            client.pipe(up); up.pipe(client)
          }
          up.on('data', onData)
        })
        client.on('error', () => up.destroy())
        up.on('close', () => client.destroy())
        client.on('close', () => up.destroy())
      })
    })
    client.on('error', () => {})
  })
  await new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', () => ok()) })
  return { port: (server.address() as any).port, close: () => server.close() }
}
