export type PluginErrorCode =
  | 'INVALID_REQUEST'
  | 'PERMISSION_DENIED'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROTOCOL_ERROR'

export class PluginFailure extends Error {
  readonly retryable: boolean

  constructor(
    readonly code: PluginErrorCode,
    message: string,
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
export const timedOut = (message = '操作超过截止时间') =>
  new PluginFailure('TIMEOUT', message)
export const isPluginFailure = (error: unknown): error is PluginFailure =>
  error instanceof PluginFailure
