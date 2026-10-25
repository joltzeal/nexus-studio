/**
 * Stable, classifiable failures. The host maps these codes to user-facing
 * feedback; plugin messages are developer-facing and must never echo the raw
 * upstream payload.
 */
export type PluginErrorCode =
  | 'INVALID_REQUEST'
  | 'PERMISSION_DENIED'
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'AUTH_FAILED'
  | 'PROTOCOL_ERROR'

const retryableByCode: Record<PluginErrorCode, boolean> = {
  INVALID_REQUEST: false,
  PERMISSION_DENIED: false,
  NOT_CONFIGURED: true,
  UNAVAILABLE: true,
  RATE_LIMITED: true,
  TIMEOUT: true,
  CANCELLED: false,
  AUTH_FAILED: false,
  PROTOCOL_ERROR: false,
}

export class PluginFailure extends Error {
  readonly code: PluginErrorCode
  readonly retryable: boolean

  constructor(
    code: PluginErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PluginFailure'
    this.code = code
    this.retryable = options.retryable ?? retryableByCode[code]
  }
}

export function invalidRequest(message: string): PluginFailure {
  return new PluginFailure('INVALID_REQUEST', message)
}

export function unavailable(message: string, cause?: unknown): PluginFailure {
  return new PluginFailure('UNAVAILABLE', message, { cause })
}

export function rateLimited(message: string): PluginFailure {
  return new PluginFailure('RATE_LIMITED', message)
}

export function timedOut(message: string): PluginFailure {
  return new PluginFailure('TIMEOUT', message)
}

export function cancelled(message = '调用已取消'): PluginFailure {
  return new PluginFailure('CANCELLED', message)
}

export function protocolError(message: string): PluginFailure {
  return new PluginFailure('PROTOCOL_ERROR', message)
}

export function isPluginFailure(value: unknown): value is PluginFailure {
  return value instanceof PluginFailure
}

/**
 * Upstream failures keep their reason so a run record can distinguish a rate
 * limit from a blocked request or a malformed payload.
 */
export type UpstreamReason =
  | 'rate-limit'
  | 'timeout'
  | 'upstream-network'
  | 'unavailable'
  | 'invalid-response'
  | 'upstream-refused'
  | 'blocked'
  | 'redirect'
  | 'proxy-auth'
  | 'proxy-connect'
  | 'dns'
  | 'tls'

export type UpstreamPhase = 'session' | 'items' | 'user'

export class UpstreamError extends Error {
  readonly reason: UpstreamReason
  /** Upstream message, kept for diagnostics only; never shown verbatim. */
  readonly detail: string | null
  readonly status: number | null
  readonly phase: UpstreamPhase | null

  constructor(
    reason: UpstreamReason,
    detail: string | null = null,
    context: { status?: number; phase?: UpstreamPhase } = {},
  ) {
    super(reason)
    this.name = 'UpstreamError'
    this.reason = reason
    this.detail = detail
    this.status = context.status ?? null
    this.phase = context.phase ?? null
  }
}

/** Short, user-safe description stored on a failed run record. */
export function upstreamReasonText(reason: UpstreamReason): string {
  if (reason === 'rate-limit') return '请求过于频繁，被 Vinted 限流'
  if (reason === 'timeout') return 'Vinted 响应超时'
  if (reason === 'invalid-response') return 'Vinted 返回了无法解析的数据'
  if (reason === 'blocked') return 'Vinted 拒绝了本次采集，请检查采集代理是否能访问该站点'
  if (reason === 'upstream-refused') return 'Vinted 拒绝了本次请求'
  if (reason === 'redirect') return 'Vinted 返回了重定向，请确认监控站点'
  if (reason === 'proxy-auth') return '代理认证失败，请检查用户名和密码'
  if (reason === 'proxy-connect') return '代理连接失败，请检查代理地址、端口和协议'
  if (reason === 'dns') return '域名解析失败，请检查 DNS 或使用 SOCKS5H 代理'
  if (reason === 'tls') return 'TLS 连接或证书校验失败，请检查代理协议和证书'
  if (reason === 'unavailable') return 'Vinted 服务暂时不可用，请稍后重试'
  return '无法连接 Vinted，请检查采集代理与网络'
}

export function upstreamErrorText(error: UpstreamError): string {
  const phase = {
    session: '初始化会话',
    items: '获取商品',
    user: '获取卖家资料',
  }
  const context = [
    error.phase === null ? null : phase[error.phase],
    error.status === null ? null : `HTTP ${error.status}`,
  ].filter(Boolean)
  return `${upstreamReasonText(error.reason)}${context.length ? `（${context.join('，')}）` : ''}`
}

/** Maps an upstream reason onto the RPC vocabulary the page already handles. */
export function upstreamFailure(error: UpstreamError): PluginFailure {
  const message = upstreamErrorText(error)
  if (error.reason === 'rate-limit') {
    return rateLimited(message)
  }
  if (error.reason === 'timeout') {
    return timedOut(message)
  }
  return unavailable(message)
}
