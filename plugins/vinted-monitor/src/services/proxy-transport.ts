import { lookup } from 'node:dns/promises'
import { connect as connectTcp, isIP, type Socket } from 'node:net'
import { once } from 'node:events'
import { connect as connectTls } from 'node:tls'
import { SocksClient } from 'socks'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'

import { validateProxy } from '../domain/proxies.js'
import type { ProxyRecord } from '../domain/types.js'

export interface ProxyTransport {
  fetch: typeof fetch
  close(): Promise<void>
}

/** Each operation owns its dispatcher. The host/global dispatcher is never changed. */
export function createProxyTransport(
  selected: Readonly<ProxyRecord> | null,
  inheritedFetch: typeof fetch = fetch,
  overrideFetch?: typeof fetch,
): ProxyTransport {
  if (selected === null) return { fetch: inheritedFetch, close: async () => undefined }
  const proxy = validateProxy({ ...selected })
  let dispatcher: Dispatcher
  let closed = false
  const connecting = new Set<() => void>()
  if (proxy.scheme === 'http' || proxy.scheme === 'https') {
    const host = isIP(proxy.host) === 6 ? `[${proxy.host}]` : proxy.host
    dispatcher = new ProxyAgent({
      uri: `${proxy.scheme}://${host}:${proxy.port}`,
      ...(proxy.username || proxy.password
        ? {
            token: `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`,
          }
        : {}),
      connectTimeout: 20_000,
      proxyTls: { rejectUnauthorized: true },
      requestTls: { rejectUnauthorized: true },
    })
  } else {
    dispatcher = new Agent({
      connect: (options, callback) => {
        let socket: Socket | undefined
        let settled = false
        const finish = (error: Error | null, ready?: Socket) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          connecting.delete(cancel)
          if (error) {
            socket?.destroy()
            callback(error, null)
          } else if (ready) callback(null, ready)
        }
        const cancel = () => finish(new Error('Proxy connection closed'))
        const timer = setTimeout(
          () => finish(new Error('Proxy connection timeout')),
          20_000,
        )
        connecting.add(cancel)
        if (closed) {
          cancel()
          return
        }
        void (async () => {
          const hostname = options.hostname.replace(/^\[|\]$/g, '')
          const host =
            proxy.scheme === 'socks5' && !isIP(hostname)
              ? (await lookup(hostname, { family: 4 })).address
              : hostname
          if (settled) return
          const port = options.port
            ? Number(options.port)
            : options.protocol === 'https:'
              ? 443
              : 80
          socket = connectTcp({ host: proxy.host, port: proxy.port })
          socket.once('error', (cause) =>
            finish(new Error('Proxy connection failed', { cause })),
          )
          await once(socket, 'connect')
          if (settled) return
          const connected = await SocksClient.createConnection({
            command: 'connect',
            proxy: {
              host: proxy.host,
              port: proxy.port,
              type: 5,
              userId: proxy.username,
              password: proxy.password,
            },
            destination: { host, port },
            timeout: 20_000,
            existing_socket: socket,
          })
          if (settled) {
            connected.socket.destroy()
            return
          }
          if (options.protocol !== 'https:') {
            finish(null, connected.socket)
            return
          }
          const tls = connectTls({
            socket: connected.socket,
            host: hostname,
            ...(isIP(hostname) ? {} : { servername: hostname }),
            rejectUnauthorized: true,
          })
          socket = tls
          tls.once('secureConnect', () => finish(null, tls))
          tls.once('error', (cause) => finish(new Error('Proxy TLS failed', { cause })))
        })().catch((cause: unknown) =>
          finish(new Error('Proxy connection failed', { cause })),
        )
      },
    })
  }
  // An explicit dispatcher also bypasses environment NO_PROXY and host preload defaults.
  const request = overrideFetch ?? (undiciFetch as unknown as typeof fetch)
  return {
    fetch: (input, init) =>
      request(input, { ...init, dispatcher } as unknown as RequestInit),
    close: async () => {
      closed = true
      for (const cancel of connecting) cancel()
      await dispatcher.destroy()
    },
  }
}
