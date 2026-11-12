export const PLUGIN_ERROR_CODES = [
  'INVALID_REQUEST',
  'PERMISSION_DENIED',
  'NOT_CONFIGURED',
  'UNAVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
  'CANCELLED',
  'AUTH_FAILED',
  'PROTOCOL_ERROR',
] as const
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

export function requiresAuthorization(
  code: PluginErrorCode | null,
): code is 'AUTH_FAILED' | 'PERMISSION_DENIED' {
  return code === 'AUTH_FAILED' || code === 'PERMISSION_DENIED'
}

export class PluginFailure extends Error {
  readonly retryable: boolean

  constructor(
    readonly code: PluginErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'PluginFailure'
    this.retryable = ['UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT'].includes(code)
  }
}

export const invalidRequest = (message: string) =>
  new PluginFailure('INVALID_REQUEST', message)
export const unavailable = (message: string) => new PluginFailure('UNAVAILABLE', message)
export const cancelled = (message = '操作已取消') =>
  new PluginFailure('CANCELLED', message)
export const timedOut = (message: string) => new PluginFailure('TIMEOUT', message)
export const protocolError = (message: string) =>
  new PluginFailure('PROTOCOL_ERROR', message)
export const isPluginFailure = (error: unknown): error is PluginFailure =>
  error instanceof PluginFailure
