import { lookup } from 'node:dns/promises'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

import type { Scheme } from '../domain/schemas.js'

export type TransportErrorKind =
  'timeout' | 'auth' | 'dns' | 'tls' | 'connect' | 'protocol'

export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TransportError'
  }
}

export interface ProxyTarget {
  scheme: Scheme
  host: string
  port: number
  username: string
  password: string
}

export interface HttpResponse {
  status: number
  body: string
}

const MAX_HEADER_BYTES = 16 * 1024
const MAX_BODY_BYTES = 64 * 1024

class BufferedSocket {
  private buffer = Buffer.alloc(0)
  private ended = false
  private failure: Error | null = null
  private waiters: Array<() => void> = []

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      if (this.buffer.length + chunk.length > MAX_HEADER_BYTES + MAX_BODY_BYTES) {
        socket.destroy()
        this.fail(new TransportError('protocol', '代理返回内容超出允许大小'))
        return
      }
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.flush()
    })
    socket.on('end', () => {
      this.ended = true
      this.flush()
    })
    socket.on('close', () => {
      this.ended = true
      this.flush()
    })
    socket.on('error', (error: Error) => this.fail(error))
  }

  /**
   * Detaches from the socket and returns unread bytes. A non-empty result means
   * the peer sent data the protocol did not expect.
   */
  dispose(): Buffer {
    this.socket.removeAllListeners('data')
    this.socket.removeAllListeners('end')
    this.socket.removeAllListeners('close')
    this.socket.removeAllListeners('error')
    const remaining = this.buffer
    this.buffer = Buffer.alloc(0)
    return remaining
  }

  private flush(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  private fail(error: Error): void {
    this.failure = error
    this.ended = true
    this.flush()
  }

  private async waitForData(): Promise<void> {
    if (this.failure !== null) throw this.failure
    if (this.ended) {
      throw new TransportError('protocol', '代理在返回完整响应前关闭了连接')
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  async readUntil(delimiter: Buffer, limit: number): Promise<Buffer> {
    for (;;) {
      const index = this.buffer.indexOf(delimiter)
      if (index !== -1) {
        const result = this.buffer.subarray(0, index)
        this.buffer = this.buffer.subarray(index + delimiter.length)
        return result
      }
      if (this.buffer.length > limit) {
        throw new TransportError('protocol', '代理响应头超出允许大小')
      }
      await this.waitForData()
    }
  }

  async readExactly(length: number): Promise<Buffer> {
    while (this.buffer.length < length) await this.waitForData()
    const result = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return result
  }

  async readToEnd(): Promise<Buffer> {
    while (!this.ended) {
      try {
        await this.waitForData()
      } catch (error) {
        if (this.buffer.length > 0 && this.failure !== null) break
        throw error
      }
    }
    const result = this.buffer
    this.buffer = Buffer.alloc(0)
    return result
  }

  get pending(): Buffer {
    return this.buffer
  }
}

function openSocket(
  target: { host: string; port: number; tls: boolean; servername?: string },
  timeoutMs: number,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = target.tls
      ? tlsConnect({
          host: target.host,
          port: target.port,
          ...(target.servername === undefined ? {} : { servername: target.servername }),
          timeout: timeoutMs,
        })
      : netConnect({ host: target.host, port: target.port, timeout: timeoutMs })
    const onError = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    const onTimeout = () => {
      socket.destroy()
      reject(new TransportError('timeout', '代理请求超时'))
    }
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    const ready = () => {
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
      socket.setTimeout(0)
      resolve(socket)
    }
    if (target.tls) socket.once('secureConnect', ready)
    else socket.once('connect', ready)
  })
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

async function socks5Handshake(
  socket: Socket,
  reader: BufferedSocket,
  target: ProxyTarget,
  destination: { host: string; port: number },
): Promise<void> {
  const hasCredentials = target.username !== '' || target.password !== ''
  const methods = hasCredentials ? [0x00, 0x02] : [0x00]
  socket.write(Buffer.from([0x05, methods.length, ...methods]))
  const greeting = await reader.readExactly(2)
  if (greeting[0] !== 0x05) {
    throw new TransportError('protocol', '代理返回了非 SOCKS5 响应')
  }
  const method = greeting[1]
  if (method === 0x02) {
    if (!hasCredentials) {
      throw new TransportError('auth', '代理要求账号密码')
    }
    const username = Buffer.from(target.username, 'utf8')
    const password = Buffer.from(target.password, 'utf8')
    if (username.length > 255 || password.length > 255) {
      throw new TransportError('auth', '代理账号或密码过长')
    }
    socket.write(
      Buffer.from([0x01, username.length, ...username, password.length, ...password]),
    )
    const auth = await reader.readExactly(2)
    if (auth[1] !== 0x00) {
      throw new TransportError('auth', '代理认证失败，请检查账号密码')
    }
  } else if (method !== 0x00) {
    throw new TransportError('auth', '代理不接受当前认证方式')
  }

  const address = Buffer.from(destination.host, 'utf8')
  if (isIP(destination.host) === 4) {
    const parts = destination.host.split('.').map(Number)
    socket.write(
      Buffer.from([
        0x05,
        0x01,
        0x00,
        0x01,
        ...parts,
        destination.port >> 8,
        destination.port & 0xff,
      ]),
    )
  } else if (isIP(destination.host) === 6) {
    throw new TransportError('protocol', '暂不支持通过 SOCKS5 连接 IPv6 目标')
  } else {
    if (address.length > 255) {
      throw new TransportError('protocol', '目标域名过长')
    }
    socket.write(
      Buffer.from([
        0x05,
        0x01,
        0x00,
        0x03,
        address.length,
        ...address,
        destination.port >> 8,
        destination.port & 0xff,
      ]),
    )
  }

  const reply = await reader.readExactly(4)
  if (reply[0] !== 0x05) {
    throw new TransportError('protocol', '代理返回了非 SOCKS5 响应')
  }
  const code = reply[1] ?? 0xff
  if (code !== 0x00) {
    throw new TransportError(
      code === 0x02 || code === 0x05 ? 'connect' : 'protocol',
      code === 0x02
        ? '代理拒绝了当前连接策略'
        : code === 0x05
          ? '代理无法连接目标地址'
          : `代理返回 SOCKS5 错误码 ${code}`,
    )
  }
  const atyp = reply[3]
  if (atyp === 0x01) await reader.readExactly(4 + 2)
  else if (atyp === 0x04) await reader.readExactly(16 + 2)
  else if (atyp === 0x03) {
    const length = (await reader.readExactly(1))[0] ?? 0
    await reader.readExactly(length + 2)
  } else {
    throw new TransportError('protocol', '代理返回了未知的 SOCKS5 地址类型')
  }
}

async function httpConnectTunnel(
  socket: Socket,
  reader: BufferedSocket,
  target: ProxyTarget,
  destination: { host: string; port: number },
): Promise<void> {
  const authority = `${destination.host}:${destination.port}`
  const headers = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    ...(target.username !== '' || target.password !== ''
      ? [`Proxy-Authorization: ${basicAuth(target.username, target.password)}`]
      : []),
    'Connection: keep-alive',
    '',
    '',
  ].join('\r\n')
  socket.write(headers)
  const head = await reader.readUntil(Buffer.from('\r\n\r\n'), MAX_HEADER_BYTES)
  const statusLine = head.toString('latin1').split('\r\n')[0] ?? ''
  const status = Number(statusLine.split(' ')[1])
  if (status === 407) {
    throw new TransportError('auth', '代理认证失败，请检查账号密码')
  }
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw new TransportError('connect', `代理拒绝建立隧道（HTTP ${status || 0}）`)
  }
  if (reader.pending.length > 0) {
    throw new TransportError('protocol', '代理在隧道建立前返回了多余数据')
  }
}

function decodeChunked(payload: Buffer): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  for (;;) {
    const lineEnd = payload.indexOf('\r\n', offset)
    if (lineEnd === -1) break
    const sizeText =
      payload.subarray(offset, lineEnd).toString('latin1').split(';')[0] ?? ''
    const size = Number.parseInt(sizeText.trim(), 16)
    if (!Number.isFinite(size)) {
      throw new TransportError('protocol', '代理返回了无效的分块响应')
    }
    if (size === 0) break
    const start = lineEnd + 2
    parts.push(payload.subarray(start, start + size))
    offset = start + size + 2
  }
  return Buffer.concat(parts)
}

function parseResponse(raw: Buffer): HttpResponse {
  const headerEnd = raw.indexOf('\r\n\r\n')
  if (headerEnd === -1) {
    throw new TransportError('protocol', '代理返回了不完整的 HTTP 响应')
  }
  const head = raw.subarray(0, headerEnd).toString('latin1').split('\r\n')
  const statusLine = head[0] ?? ''
  const status = Number(statusLine.split(' ')[1])
  if (!Number.isInteger(status)) {
    throw new TransportError('protocol', '代理返回了无效的 HTTP 状态行')
  }
  const headers = new Map<string, string>()
  for (const line of head.slice(1)) {
    const index = line.indexOf(':')
    if (index > 0) {
      headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim())
    }
  }
  const body = raw.subarray(headerEnd + 4)
  const encoding = headers.get('transfer-encoding')?.toLowerCase() ?? ''
  const decoded = encoding.includes('chunked') ? decodeChunked(body) : body
  return { status, body: decoded.toString('utf8') }
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  socket: () => Socket | null,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      socket()?.destroy()
      reject(new TransportError('timeout', '代理请求超时'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Minimal HTTP/1.1 GET over an HTTP(S) or SOCKS5 proxy. It exists because the
 * plugin must prove an exit IP without handing the host a live proxy session,
 * and because no runtime dependency is allowed to do it for us.
 */
export async function httpGetViaProxy(
  target: ProxyTarget,
  url: URL,
  options: { timeoutMs: number },
): Promise<HttpResponse> {
  const destination = {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  }
  const socks = target.scheme === 'socks5' || target.scheme === 'socks5h'
  // `socks5` resolves locally, `socks5h` delegates DNS to the proxy.
  const resolved =
    socks && target.scheme === 'socks5' && isIP(destination.host) === 0
      ? { ...destination, host: await resolveHost(destination.host) }
      : destination

  const holder: { socket: Socket | null } = { socket: null }
  const operation = (async () => {
    holder.socket = await openSocket(
      {
        host: target.host,
        port: target.port,
        tls: target.scheme === 'https',
        ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
      },
      options.timeoutMs,
    )
    const handshakeReader = new BufferedSocket(holder.socket)
    if (socks) {
      await socks5Handshake(holder.socket, handshakeReader, target, resolved)
    } else {
      await httpConnectTunnel(holder.socket, handshakeReader, target, resolved)
    }
    const leftover = handshakeReader.dispose()
    if (leftover.length > 0) {
      throw new TransportError('protocol', '代理在隧道建立后返回了多余数据')
    }
    if (url.protocol === 'https:') {
      holder.socket = await upgradeToTls(
        holder.socket,
        destination.host,
        options.timeoutMs,
      )
    }
    // Attach before writing so a fast response cannot be missed.
    const reader = new BufferedSocket(holder.socket)
    const path = `${url.pathname}${url.search}` || '/'
    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${destination.host}`,
      'Accept: application/json',
      'User-Agent: nexus-proxy-plugin/1.0',
      'Connection: close',
      '',
      '',
    ].join('\r\n')
    holder.socket.write(request)
    const raw = await reader.readToEnd()
    return parseResponse(raw)
  })()

  try {
    return await withDeadline(operation, options.timeoutMs, () => holder.socket)
  } finally {
    holder.socket?.destroy()
  }
}

async function resolveHost(host: string): Promise<string> {
  try {
    const result = await lookup(host, { family: 0 })
    return result.address
  } catch (error) {
    throw new TransportError('dns', '域名解析失败', { cause: error })
  }
}

function upgradeToTls(
  socket: Socket,
  host: string,
  timeoutMs: number,
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const secured = tlsConnect(
      {
        socket,
        ...(isIP(host) === 0 ? { servername: host } : {}),
        timeout: timeoutMs,
      },
      () => {
        secured.off('error', onError)
        secured.setTimeout(0)
        resolve(secured)
      },
    )
    const onError = (error: Error) => {
      secured.destroy()
      reject(error)
    }
    secured.once('error', onError)
  })
}

/** Maps transport failures to stable, credential-free messages. */
export function describeTransportError(error: unknown): string {
  if (error instanceof TransportError) {
    switch (error.kind) {
      case 'timeout':
        return '代理请求超时'
      case 'auth':
        return '代理连接或认证失败，请检查协议和账号密码'
      case 'dns':
        return '域名解析失败，请检查 DNS 或使用 SOCKS5H'
      case 'tls':
        return 'TLS 或证书校验失败，请检查 HTTPS 代理支持情况'
      case 'connect':
        return '无法建立连接，请检查主机、端口和网络'
      default:
        return '代理检测失败，请检查配置和网络'
    }
  }
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return '代理请求超时'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return '域名解析失败，请检查 DNS 或使用 SOCKS5H'
  }
  if (
    typeof code === 'string' &&
    (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code === 'EPROTO')
  ) {
    return 'TLS 或证书校验失败，请检查 HTTPS 代理支持情况'
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return '无法建立连接，请检查主机、端口和网络'
  }
  // Never interpolate the raw error: it can contain the proxy authority.
  return '代理检测失败，请检查配置和网络'
}
