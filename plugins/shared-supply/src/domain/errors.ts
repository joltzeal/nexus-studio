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
 * Upstream failures keep their reason so the page can distinguish a supplier
 * outage from a rate limit or a malformed response.
 */
export type UpstreamReason =
  | 'rate-limit'
  | 'timeout'
  | 'upstream-network'
  | 'unavailable'
  | 'invalid-response'
  | 'upstream-refused'

export class UpstreamError extends Error {
  readonly reason: UpstreamReason
  /** Upstream message, kept for diagnostics only; never shown verbatim. */
  readonly detail: string | null

  constructor(reason: UpstreamReason, detail: string | null = null) {
    super(reason)
    this.name = 'UpstreamError'
    this.reason = reason
    this.detail = detail
  }
}

/** Maps an upstream reason onto the RPC vocabulary the page already handles. */
export function upstreamFailure(error: UpstreamError): PluginFailure {
  if (error.reason === 'rate-limit') {
    return rateLimited('共享货源接口请求过于频繁，请稍候重试')
  }
  if (error.reason === 'timeout') {
    return timedOut('共享货源接口响应超时，请重试')
  }
  if (error.reason === 'invalid-response') {
    return unavailable('共享货源接口返回了无法解析的数据')
  }
  if (error.reason === 'upstream-refused') {
    return unavailable(
      error.detail === null
        ? '共享货源接口拒绝了本次请求'
        : `共享货源接口拒绝了本次请求：${error.detail}`,
    )
  }
  return unavailable('共享货源接口暂时不可用')
}
