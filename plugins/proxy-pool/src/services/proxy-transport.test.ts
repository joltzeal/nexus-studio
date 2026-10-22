import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import {
  describeTransportError,
  httpGetViaProxy,
  TransportError,
  type ProxyTarget,
} from './proxy-transport.js'

const servers: Server[] = []
const openSockets = new Set<Socket>()

function track(server: Server): Server {
  server.on('connection', (socket: Socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  })
  return server
}

afterEach(async () => {
  // Pending tunnels would otherwise keep close() waiting.
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

async function listen(server: Server): Promise<number> {
  servers.push(track(server))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

interface SocksOptions {
  requireAuth?: boolean
  rejectAuth?: boolean
  body: string
}

/** Minimal SOCKS5 server: greeting, optional user/pass, CONNECT, canned reply. */
function socksServer(options: SocksOptions): Server {
  return createServer((socket: Socket) => {
    let stage: 'greeting' | 'auth' | 'connect' | 'request' = 'greeting'
    let buffer = Buffer.alloc(0)

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting') {
        const methods = buffer[1] ?? 0
        if (buffer.length < 2 + methods) return
        const offered = [...buffer.subarray(2, 2 + methods)]
        buffer = Buffer.alloc(0)
        if (options.requireAuth === true && offered.includes(0x02)) {
          socket.write(Buffer.from([0x05, 0x02]))
          stage = 'auth'
        } else {
          socket.write(Buffer.from([0x05, 0x00]))
          stage = 'connect'
        }
        return
      }
      if (stage === 'auth') {
        const userLength = buffer[1] ?? 0
        if (buffer.length < 2 + userLength) return
        const passwordLength = buffer[2 + userLength] ?? 0
        if (buffer.length < 3 + userLength + passwordLength) return
        buffer = Buffer.alloc(0)
        socket.write(Buffer.from([0x01, options.rejectAuth === true ? 0x01 : 0x00]))
        stage = 'connect'
        return
      }
      if (stage === 'connect') {
        const atyp = buffer[3]
        const length =
          atyp === 0x01
            ? 10
            : atyp === 0x03
              ? 7 + (buffer[4] ?? 0)
              : atyp === 0x04
                ? 22
                : 0
        if (length === 0 || buffer.length < length) return
        buffer = Buffer.alloc(0)
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        stage = 'request'
        return
      }
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(options.body)}\r\n\r\n${options.body}`,
      )
    })
  })
}

/** Minimal HTTP proxy that answers CONNECT with a fixed status. */
function connectServer(status: number, body: string): Server {
  return createServer((socket: Socket) => {
    let handshake = false
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      if (!handshake) {
        if (!buffer.includes('\r\n\r\n')) return
        handshake = true
        buffer = ''
        socket.write(
          `HTTP/1.1 ${status} ${status === 200 ? 'Connection established' : 'Proxy Authentication Required'}\r\n\r\n`,
        )
        if (status !== 200) socket.end()
        return
      }
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
    })
  })
}

const target: ProxyTarget = {
  scheme: 'socks5h',
  host: '127.0.0.1',
  port: 0,
  username: '',
  password: '',
}

describe('proxy transport', () => {
  it('tunnels a SOCKS5 request and returns the body', async () => {
    const port = await listen(socksServer({ body: '{"ip":"45.33.32.156"}' }))
    const response = await httpGetViaProxy(
      { ...target, port },
      new URL('http://api64.ipify.org/?format=json'),
      { timeoutMs: 2000 },
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ip: '45.33.32.156' })
  })

  it('authenticates with a username and password', async () => {
    const port = await listen(
      socksServer({ requireAuth: true, body: '{"ip":"1.1.1.1"}' }),
    )
    const response = await httpGetViaProxy(
      { ...target, port, username: 'user', password: 'p@ss' },
      new URL('http://api64.ipify.org/'),
      { timeoutMs: 2000 },
    )
    expect(response.status).toBe(200)
  })

  it('reports a rejected SOCKS5 login as an authentication failure', async () => {
    const port = await listen(
      socksServer({ requireAuth: true, rejectAuth: true, body: '{}' }),
    )
    const error = await httpGetViaProxy(
      { ...target, port, username: 'user', password: 'wrong' },
      new URL('http://api64.ipify.org/'),
      { timeoutMs: 2000 },
    ).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(TransportError)
    if (error instanceof TransportError) expect(error.kind).toBe('auth')
    expect(describeTransportError(error)).toBe('代理连接或认证失败，请检查协议和账号密码')
  })

  it('tunnels through an HTTP proxy', async () => {
    const port = await listen(connectServer(200, '{"ip":"1.1.1.1"}'))
    const response = await httpGetViaProxy(
      { scheme: 'http', host: '127.0.0.1', port, username: '', password: '' },
      new URL('http://api64.ipify.org/'),
      { timeoutMs: 2000 },
    )
    expect(response.status).toBe(200)
    expect(response.body).toContain('1.1.1.1')
  })

  it('treats an HTTP 407 during CONNECT as an authentication failure', async () => {
    const port = await listen(connectServer(407, ''))
    const error = await httpGetViaProxy(
      { scheme: 'http', host: '127.0.0.1', port, username: 'u', password: 'p' },
      new URL('http://api64.ipify.org/'),
      { timeoutMs: 2000 },
    ).catch((reason: unknown) => reason)
    if (error instanceof TransportError) expect(error.kind).toBe('auth')
    else throw error
  })

  it('gives up at the deadline instead of hanging', async () => {
    const port = await listen(createServer(() => undefined))
    const error = await httpGetViaProxy(
      { ...target, port },
      new URL('http://api64.ipify.org/'),
      { timeoutMs: 120 },
    ).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(TransportError)
    if (error instanceof TransportError) expect(error.kind).toBe('timeout')
    expect(describeTransportError(error)).toBe('代理请求超时')
  })

  it('classifies a refused connection', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const error = await httpGetViaProxy(
      { ...target, port },
      new URL('http://api64.ipify.org/'),
      { timeoutMs: 500 },
    ).catch((reason: unknown) => reason)
    expect(describeTransportError(error)).toBe('无法建立连接，请检查主机、端口和网络')
  })

  it('never echoes the proxy authority in a diagnostic message', () => {
    const error = new TransportError('connect', 'proxy.example:1080 refused')
    expect(describeTransportError(error)).not.toContain('proxy.example')
  })
})
