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

/** Short, user-safe description stored on a failed run record. */
export function upstreamReasonText(reason: UpstreamReason): string {
  if (reason === 'rate-limit') return '请求过于频繁，被 Vinted 限流'
  if (reason === 'timeout') return 'Vinted 响应超时'
  if (reason === 'invalid-response') return 'Vinted 返回了无法解析的数据'
  if (reason === 'blocked') return 'Vinted 拒绝了本次采集（可能需要代理）'
  if (reason === 'upstream-refused') return 'Vinted 拒绝了本次请求'
  return 'Vinted 接口暂时不可用'
}

/** Maps an upstream reason onto the RPC vocabulary the page already handles. */
export function upstreamFailure(error: UpstreamError): PluginFailure {
  if (error.reason === 'rate-limit') {
    return rateLimited('Vinted 接口请求过于频繁，请稍候重试')
  }
  if (error.reason === 'timeout') {
    return timedOut('Vinted 接口响应超时，请重试')
  }
  if (error.reason === 'invalid-response') {
    return unavailable('Vinted 接口返回了无法解析的数据')
  }
  if (error.reason === 'blocked') {
    return unavailable('Vinted 拒绝了本次采集，可能需要配置代理')
  }
  if (error.reason === 'upstream-refused') {
    return unavailable(
      error.detail === null
        ? 'Vinted 接口拒绝了本次请求'
        : `Vinted 接口拒绝了本次请求：${error.detail}`,
    )
  }
  return unavailable('Vinted 接口暂时不可用')
}
