import {
  cancelled,
  isPluginFailure,
  PluginFailure,
  type PluginErrorCode,
} from '../domain/errors.js'

const messages: Record<PluginErrorCode, string> = {
  INVALID_REQUEST: '邮箱请求无效，请重新读取',
  PERMISSION_DENIED: '所选邮箱通道缺少权限，请更新授权',
  NOT_CONFIGURED: '邮箱服务配置无效，请检查设置',
  UNAVAILABLE: '邮箱服务暂时不可用，请稍后重试',
  RATE_LIMITED: '邮箱服务请求受限，请稍后重试',
  TIMEOUT: '邮箱请求超时，请稍后重试',
  CANCELLED: '邮箱操作已取消',
  AUTH_FAILED: '邮箱授权已失效，请更新凭据',
  PROTOCOL_ERROR: '邮箱服务返回的数据无效，请稍后重试',
}

export function safeMailFailure(error: unknown): PluginFailure {
  const code = isPluginFailure(error)
    ? error.code
    : error instanceof Error && error.name === 'TimeoutError'
      ? 'TIMEOUT'
      : 'UNAVAILABLE'
  const retry = isPluginFailure(error) ? error.retryAfterMs : undefined
  return new PluginFailure(
    code,
    messages[code],
    retry !== undefined && Number.isFinite(retry)
      ? Math.max(1000, Math.min(3_600_000, retry))
      : undefined,
  )
}

/** Release callers even if a provider ignores the cancellation signal. */
export async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const failure = () =>
    signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
      ? new PluginFailure('TIMEOUT', messages.TIMEOUT)
      : cancelled()
  let onAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(failure())
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    const result = await Promise.race([work, aborted])
    if (signal.aborted) throw failure()
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
