import { isIP, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { SocksClient } from 'socks'
import {
  Agent,
  ProxyAgent,
  fetch as proxyFetch,
  type Dispatcher,
  type Response,
} from 'undici'

export interface ProxyGeo {
  ip: string
  timezone: string | undefined
  locale: string | undefined
}

interface LookupOptions {
  requireTimezone?: boolean
  requireLocale?: boolean
  timeoutMs?: number
}

const providers = [
  'https://ipwho.is/?fields=ip,success,country_code,timezone.id',
  'https://api.ip.sb/geoip',
]

function dispatcherFor(proxy: string, timeoutMs: number): Dispatcher {
  const url = new URL(proxy)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return new ProxyAgent({ uri: proxy, connectTimeout: timeoutMs })
  }
  if (!['socks5:', 'socks5h:'].includes(url.protocol)) {
    throw new Error('PROFILE_GEO_PROXY_CONNECT_FAILED')
  }
  return new Agent({
    connect(options, callback) {
      let socket: Socket | undefined
      let finished = false
      const complete = (error: Error | null, connected: Socket | null = null) => {
        if (finished) {
          if (connected) connected.destroy()
          return
        }
        finished = true
        clearTimeout(timer)
        if (error) {
          socket?.destroy()
          callback(error, null)
        } else if (connected) {
          callback(null, connected)
        } else {
          callback(new Error('PROFILE_GEO_PROXY_CONNECT_FAILED'), null)
        }
      }
      const timer = setTimeout(
        () => complete(new Error('PROFILE_GEO_PROXY_CONNECT_FAILED')),
        timeoutMs,
      )
      void SocksClient.createConnection({
        command: 'connect',
        proxy: {
          host: url.hostname.replace(/^\[|\]$/g, ''),
          port: Number(url.port),
          type: 5,
          userId: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        },
        // Browser SOCKS connections resolve destinations through the proxy.
        destination: {
          host: options.hostname,
          port: Number(options.port) || (options.protocol === 'https:' ? 443 : 80),
        },
        timeout: timeoutMs,
      }).then(
        ({ socket: connected }) => {
          socket = connected
          if (finished) {
            socket.destroy()
            return
          }
          if (options.protocol !== 'https:') {
            complete(null, socket)
            return
          }
          const secured = connectTls({
            socket,
            servername: options.servername ?? options.hostname,
          })
          socket = secured
          secured.once('secureConnect', () => complete(null, secured))
          secured.once('error', (error) => complete(error))
        },
        (error: Error) => complete(error),
      )
    },
  })
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parseGeo(payload: unknown, options: LookupOptions): ProxyGeo {
  const data = object(payload)
  const ip = typeof data.ip === 'string' ? data.ip.trim() : ''
  if (
    data.success === false ||
    data.error ||
    !isIP(ip) ||
    /^127\./.test(ip) ||
    ['::', '::1', '0.0.0.0'].includes(ip)
  ) {
    throw new Error('PROFILE_GEO_ONLINE_UNAVAILABLE')
  }
  const zone =
    typeof data.timezone === 'string' ? data.timezone : object(data.timezone).id
  let timezone: string | undefined
  if (typeof zone === 'string' && zone.length <= 128) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone })
      timezone = zone
    } catch {
      // A malformed provider answer is eligible for the alternate provider.
    }
  }
  const country = data.country_code
  let locale: string | undefined
  if (typeof country === 'string' && /^[A-Z]{2}$/.test(country)) {
    const inferred = new Intl.Locale(`und-${country}`).maximize()
    if (inferred.region === country) locale = `${inferred.language}-${country}`
  }
  if (
    ((options.requireTimezone ?? true) && !timezone) ||
    ((options.requireLocale ?? true) && !locale)
  ) {
    throw new Error('PROFILE_GEO_ONLINE_UNAVAILABLE')
  }
  return { ip, timezone, locale }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('PROFILE_GEO_ONLINE_UNAVAILABLE')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 64 * 1024) throw new Error('PROFILE_GEO_ONLINE_UNAVAILABLE')
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function isProxyConnectionFailure(error: unknown): boolean {
  for (let depth = 0; error && depth < 4; depth++) {
    const value = object(error)
    if (
      ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(
        String(value.code),
      ) ||
      /407|socks5 proxy rejected|authentication failed/i.test(String(value.message ?? ''))
    ) {
      return true
    }
    error = value.cause
  }
  return false
}

export async function resolveOnlineProxyGeo(
  proxy: string,
  signal: AbortSignal,
  options: LookupOptions = {},
): Promise<ProxyGeo> {
  signal.throwIfAborted()
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5000, 10_000))
  const dispatcher = dispatcherFor(proxy, timeoutMs)
  let proxyFailures = 0
  try {
    for (const url of providers) {
      signal.throwIfAborted()
      const attempt = new AbortController()
      const timer = setTimeout(() => attempt.abort(), timeoutMs)
      let response: Response | undefined
      try {
        response = await proxyFetch(url, {
          dispatcher,
          redirect: 'error',
          headers: { Accept: 'application/json', 'User-Agent': 'Nexus/1.0' },
          signal: AbortSignal.any([signal, attempt.signal]),
        })
        return parseGeo(await readJson(response), options)
      } catch (error) {
        signal.throwIfAborted()
        if (isProxyConnectionFailure(error)) proxyFailures++
      } finally {
        clearTimeout(timer)
        await response?.body?.cancel().catch(() => {})
      }
    }
  } finally {
    await dispatcher.destroy()
  }
  throw new Error(
    proxyFailures === providers.length
      ? 'PROFILE_GEO_PROXY_CONNECT_FAILED'
      : 'PROFILE_GEO_ONLINE_UNAVAILABLE',
  )
}
