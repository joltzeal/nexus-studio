import { invalidRequest, unavailable } from '../domain/errors.js'
import {
  OrderWatchSettingsSchema,
  type OrderWatchSettings,
} from '../domain/order-watch.js'

function beforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

export async function sendBark(
  settings: OrderWatchSettings['bark'],
  notification: { title: string; body: string; url?: string },
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  const parsed = OrderWatchSettingsSchema.safeParse({
    intervalMinutes: 30,
    bark: { ...settings, enabled: true },
  })
  if (!parsed.success) throw invalidRequest('请先保存有效的 Bark 服务地址和设备 Key')
  const deadline = new AbortController()
  const signal = AbortSignal.any([
    deadline.signal,
    ...(options.signal ? [options.signal] : []),
  ])
  signal.throwIfAborted()
  const timer = setTimeout(() => deadline.abort(), 15_000)
  timer.unref()
  try {
    const pending = (options.fetchImpl ?? globalThis.fetch)(
      `${parsed.data.bark.baseUrl}/push`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        signal,
        body: JSON.stringify({
          device_key: parsed.data.bark.deviceKey,
          ...notification,
          group: 'Vinted 订单监控',
        }),
      },
    )
    const response = await beforeAbort(
      pending.then((response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => {})
        return response
      }),
      signal,
    )
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error('Bark refused delivery')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing acknowledgment')
    const chunks: Uint8Array[] = []
    let length = 0
    const abort = () => {
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        signal.throwIfAborted()
        const chunk = await beforeAbort(reader.read(), signal)
        signal.throwIfAborted()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > 16 * 1024) throw new Error('Acknowledgment too large')
        chunks.push(chunk.value)
      }
    } finally {
      signal.removeEventListener('abort', abort)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (
      typeof value !== 'object' ||
      value === null ||
      !('code' in value) ||
      value.code !== 200
    ) {
      throw new Error('Unrecognized acknowledgment')
    }
  } catch {
    if (options.signal?.aborted) options.signal.throwIfAborted()
    throw unavailable('Bark 推送失败，请检查服务地址、设备 Key 或网络后重试')
  } finally {
    clearTimeout(timer)
  }
}
