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

export function notConfigured(message: string): PluginFailure {
  return new PluginFailure('NOT_CONFIGURED', message)
}

export function unavailable(message: string, cause?: unknown): PluginFailure {
  return new PluginFailure('UNAVAILABLE', message, { cause })
}

export function authFailed(message: string): PluginFailure {
  return new PluginFailure('AUTH_FAILED', message)
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
 * Upstream failures keep their reason so the record can distinguish an expired
 * key from a rate limit or a model that does not exist.
 */
export type UpstreamReason =
  | 'auth'
  | 'channel-unavailable'
  | 'rate-limit'
  | 'timeout'
  | 'not-found'
  | 'bad-request'
  | 'network'
  | 'invalid-response'
  | 'refused'

export class UpstreamError extends Error {
  readonly reason: UpstreamReason
  /** The adapter redacts upstream content before retaining this bounded excerpt. */
  readonly detail: string | null
  readonly status: number | null
  readonly requestId: string | null

  constructor(
    reason: UpstreamReason,
    detail: string | null = null,
    diagnostics: { status?: number; requestId?: string | null } = {},
  ) {
    super(reason)
    this.name = 'UpstreamError'
    this.reason = reason
    this.detail = detail?.slice(0, 220) ?? null
    this.status = diagnostics.status ?? null
    this.requestId = diagnostics.requestId?.slice(0, 128) ?? null
  }
}

/** Maps an upstream reason onto the RPC vocabulary the page already handles. */
export function upstreamFailure(error: UpstreamError): PluginFailure {
  const diagnostics = [
    error.status === null ? null : `HTTP ${error.status}`,
    error.detail,
    error.requestId === null ? null : `request id: ${error.requestId}`,
  ].filter((value) => value !== null && value !== '')
  const message = (text: string) =>
    diagnostics.length === 0 ? text : `${text}（${diagnostics.join('；')}）`

  switch (error.reason) {
    case 'auth':
      return authFailed(message('API Key 无效或已过期，请在模型配置中重新填写'))
    case 'channel-unavailable':
      return new PluginFailure(
        'UNAVAILABLE',
        message(
          '服务商 API Key 所属分组下，该模型没有可用通道。请在服务商后台检查分组权限、模型名称和通道状态，或联系服务商',
        ),
        { retryable: false },
      )
    case 'rate-limit':
      return rateLimited(message('服务商限流，请稍后重试'))
    case 'timeout':
      return timedOut(message('服务商响应超时，请重试'))
    case 'not-found':
      return notConfigured(message('模型或接口地址不存在，请检查模型名与基础地址'))
    case 'bad-request':
      return invalidRequest(message('服务商拒绝了本次请求参数'))
    case 'invalid-response':
      return unavailable(message('服务商返回了无法解析的数据'))
    case 'refused':
      return unavailable(message('服务商拒绝了本次请求'))
    default:
      return unavailable(message('服务商暂时不可用'))
  }
}
