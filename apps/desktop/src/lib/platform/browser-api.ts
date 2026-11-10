import { invoke } from '@tauri-apps/api/core'
import { BrowserErrorSchema } from '@nexus/contracts/browser'

export class BrowserApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'BrowserApiError'
  }
}

export function browserError(cause: unknown): BrowserApiError {
  let value = cause
  if (typeof cause === 'string') {
    try {
      value = JSON.parse(cause)
    } catch {
      value = cause
    }
  }
  const parsed = BrowserErrorSchema.safeParse(value)
  if (parsed.success) {
    const { code, message, retryable } = parsed.data
    return new BrowserApiError(code, message, retryable)
  }
  return new BrowserApiError(
    'unavailable',
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : '浏览器操作失败，请刷新后重试。',
    false,
  )
}

export async function invokeBrowser(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke<unknown>(command, args)
  } catch (cause) {
    throw browserError(cause)
  }
}

export async function readBrowser<T>(
  schema: {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false }
  },
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const result = schema.safeParse(await invokeBrowser(command, args))
  if (!result.success) {
    throw new BrowserApiError(
      'invalid_response',
      '浏览器返回的数据格式不符，请更新桌面应用后重试。',
      false,
    )
  }
  return result.data
}
