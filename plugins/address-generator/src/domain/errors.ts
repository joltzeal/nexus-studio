/**
 * Stable, classifiable failures. The host maps these codes to user-facing
 * feedback; plugin messages are developer-facing and must never contain the
 * stored map key or anything else the user typed into a settings field.
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

export function notConfigured(message: string): PluginFailure {
  return new PluginFailure('NOT_CONFIGURED', message)
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

export function authFailed(message: string): PluginFailure {
  return new PluginFailure('AUTH_FAILED', message)
}

export function protocolError(message: string): PluginFailure {
  return new PluginFailure('PROTOCOL_ERROR', message)
}

export function isPluginFailure(value: unknown): value is PluginFailure {
  return value instanceof PluginFailure
}

/**
 * Upstream lookup failures keep their reason so the page can explain what the
 * public address service actually did, instead of a generic "failed".
 */
export type UpstreamReason =
  'rate-limit' | 'timeout' | 'upstream-network' | 'unavailable' | 'invalid-response'

export interface UpstreamAttempt {
  endpoint: string
  reason: UpstreamReason
  status?: number
}

export class UpstreamError extends Error {
  readonly reason: UpstreamReason
  readonly attempts: UpstreamAttempt[]

  constructor(reason: UpstreamReason, attempts: UpstreamAttempt[] = []) {
    super(reason)
    this.name = 'UpstreamError'
    this.reason = reason
    this.attempts = attempts
  }
}

/** Maps an upstream reason onto the RPC vocabulary the page already handles. */
export function upstreamFailure(error: UpstreamError): PluginFailure {
  if (error.reason === 'rate-limit') {
    return rateLimited('公开地址服务请求过于频繁，请稍候重试')
  }
  if (error.reason === 'timeout') {
    return timedOut('公开地址查询超时，请重试或切换城市')
  }
  if (error.reason === 'invalid-response') {
    return unavailable('公开地址服务返回了无效数据')
  }
  return unavailable('公开地址服务暂时不可用')
}
