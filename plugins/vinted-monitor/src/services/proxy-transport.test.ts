import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createTcpServer, connect } from 'node:net'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProxyRecord } from '../domain/types.js'
import { createProxyTransport } from './proxy-transport.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function listen(
  server: ReturnType<typeof createServer> | ReturnType<typeof createTcpServer>,
) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('no port')
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  )
  return address.port
}

const config = (port: number, scheme: ProxyRecord['scheme']): ProxyRecord => ({
  id: 'p',
  name: 'test',
  host: '127.0.0.1',
  port,
  scheme,
  username: 'user',
  password: 'pass',
  enabled: true,
})

describe('scoped proxy transport', () => {
  it('supports authenticated HTTPS proxies and verifies the proxy certificate', async () => {
    const cert = readFileSync(
      new URL('./fixtures/proxy-test.cert.pem', import.meta.url),
      'utf8',
    )
    const key = readFileSync(new URL('./fixtures/proxy-test.key.pem', import.meta.url))
    let authenticated = false
    const origin = createServer((_req, res) => res.end('secure-proxy'))
    const originPort = await listen(origin)
    const proxy = createHttpsServer({ cert, key })
    proxy.on('connect', (req, socket) => {
      authenticated =
        req.headers['proxy-authorization'] ===
        `Basic ${Buffer.from('user:pass').toString('base64')}`
      const upstream = connect(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      socket.on('close', () => upstream.destroy())
    })
    const port = await listen(proxy)
    const untrusted = createProxyTransport({
      ...config(port, 'https'),
      host: 'localhost',
    })
    try {
      await expect(untrusted.fetch('http://target.invalid/')).rejects.toThrow()
    } finally {
      await untrusted.close()
    }
    expect(authenticated).toBe(false)
    const roots = getCACertificates('default')
    setDefaultCACertificates([...roots, cert])
    cleanups.push(async () => setDefaultCACertificates(roots))
    const trusted = createProxyTransport({ ...config(port, 'https'), host: 'localhost' })
    cleanups.push(() => trusted.close())
    expect(await (await trusted.fetch('http://target.invalid/')).text()).toBe(
      'secure-proxy',
    )
    expect(authenticated).toBe(true)
  })

  it('uses HTTP CONNECT basic auth without passing credentials to the target', async () => {
    let authorization: string | undefined
    const origin = createServer((req, res) => {
      expect(req.headers['proxy-authorization']).toBeUndefined()
      res.end('through-proxy')
    })
    const originPort = await listen(origin)
    const proxy = createServer()
    proxy.on('connect', (req, socket, head) => {
      authorization = req.headers['proxy-authorization']
      const upstream = connect(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      socket.on('close', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
    })
    const port = await listen(proxy)
    const transport = createProxyTransport(config(port, 'http'))
    cleanups.push(() => transport.close())
    expect(await (await transport.fetch('http://unresolvable.invalid/a')).text()).toBe(
      'through-proxy',
    )
    expect(authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`)
  })

  it.each(['socks5', 'socks5h'] as const)(
    'authenticates %s and resolves names on the correct side',
    async (scheme) => {
      let remoteHost = ''
      const origin = createServer((_req, res) => res.end('socks-ok'))
      const originPort = await listen(origin)
      const proxy = createTcpServer((socket) => {
        let stage = 0
        socket.on('data', function receive(data) {
          if (stage === 0) {
            stage++
            socket.write(Buffer.from([5, 2]))
            return
          }
          if (stage === 1) {
            const userLength = data[1]!
            expect(data.subarray(2, 2 + userLength).toString()).toBe('user')
            expect(data.subarray(3 + userLength).toString()).toBe('pass')
            stage++
            socket.write(Buffer.from([1, 0]))
            return
          }
          socket.off('data', receive)
          remoteHost =
            data[3] === 3
              ? data.subarray(5, 5 + data[4]!).toString()
              : [...data.subarray(4, 8)].join('.')
          const upstream = connect(originPort, '127.0.0.1', () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
            upstream.pipe(socket)
            socket.pipe(upstream)
          })
          socket.on('close', () => upstream.destroy())
          upstream.on('error', () => socket.destroy())
        })
      })
      const port = await listen(proxy)
      const transport = createProxyTransport(config(port, scheme))
      cleanups.push(() => transport.close())
      const host = scheme === 'socks5h' ? 'remote.invalid' : 'localhost'
      expect(await (await transport.fetch(`http://${host}/`)).text()).toBe('socks-ok')
      expect(remoteHost).toBe(scheme === 'socks5h' ? 'remote.invalid' : '127.0.0.1')
    },
  )

  it('fails closed for unavailable proxies even when the origin is reachable', async () => {
    let direct = 0
    const origin = createServer((_req, res) => {
      direct++
      res.end('bad')
    })
    const port = await listen(origin)
    for (const scheme of ['http', 'https', 'socks5', 'socks5h'] as const) {
      const transport = createProxyTransport({ ...config(1, scheme), host: 'localhost' })
      try {
        await expect(transport.fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
      } finally {
        await transport.close()
      }
    }
    expect(direct).toBe(0)
  })

  it('closes a stalled SOCKS handshake promptly after an aborted request', async () => {
    const proxy = createTcpServer((socket) => {
      socket.on('data', () => undefined)
    })
    const port = await listen(proxy)
    const transport = createProxyTransport(config(port, 'socks5h'))
    const start = Date.now()
    try {
      await expect(
        transport.fetch('http://target.invalid', { signal: AbortSignal.timeout(25) }),
      ).rejects.toThrow()
      await transport.close()
      expect(Date.now() - start).toBeLessThan(1000)
    } finally {
      await transport.close()
    }
  }, 25_000)

  it.each(['http', 'https', 'socks5', 'socks5h'] as const)(
    'verifies destination TLS through %s, including the implicit HTTPS port',
    async (scheme) => {
      const cert = readFileSync(
        new URL('./fixtures/proxy-test.cert.pem', import.meta.url),
        'utf8',
      )
      const key = readFileSync(new URL('./fixtures/proxy-test.key.pem', import.meta.url))
      const roots = getCACertificates('default')
      setDefaultCACertificates([...roots, cert])
      cleanups.push(async () => setDefaultCACertificates(roots))
      const origin = createHttpsServer({ cert, key }, (_req, res) => res.end('tls-ok'))
      const originPort = await listen(origin)
      let requestedPort = 0
      const tunnel = (socket: import('node:stream').Duplex, reply: string | Buffer) => {
        const upstream = connect(originPort, '127.0.0.1', () => {
          socket.write(reply)
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
      }
      const proxy =
        scheme === 'http'
          ? createServer()
          : scheme === 'https'
            ? createHttpsServer({ cert, key })
            : createTcpServer((socket) => {
                let stage = 0
                socket.on('data', function receive(data) {
                  if (stage++ === 0) {
                    socket.write(Buffer.from([5, 2]))
                    return
                  }
                  if (stage === 2) {
                    socket.write(Buffer.from([1, 0]))
                    return
                  }
                  socket.off('data', receive)
                  requestedPort = data.readUInt16BE(data.length - 2)
                  tunnel(socket, Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 187]))
                })
              })
      if (scheme === 'http' || scheme === 'https') {
        proxy.on(
          'connect',
          (
            req: import('node:http').IncomingMessage,
            socket: import('node:stream').Duplex,
          ) => {
            requestedPort = Number(req.url?.split(':').at(-1))
            expect(req.headers['proxy-authorization']).toBe(
              `Basic ${Buffer.from('user:pass').toString('base64')}`,
            )
            tunnel(socket, 'HTTP/1.1 200 Connection Established\r\n\r\n')
          },
        )
      }
      const port = await listen(proxy)
      const transport = createProxyTransport({
        ...config(port, scheme),
        host: 'localhost',
      })
      cleanups.push(() => transport.close())
      expect(await (await transport.fetch('https://localhost/')).text()).toBe('tls-ok')
      expect(requestedPort).toBe(443)
      if (scheme !== 'socks5') {
        await expect(transport.fetch('https://wrong.invalid/')).rejects.toThrow()
      }
    },
  )
})
