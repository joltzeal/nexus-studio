import { AgentNotificationSchema } from '@nexus/plugin-sdk/agent'
import { AgentFailure } from '../errors.js'

function beforeAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('notification aborted'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    pending
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', abort)
      })
      .catch(() => {})
  })
}

async function acknowledgment(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.ok || !response.body) throw new Error('notification refused')
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const part = await beforeAbort(reader.read(), signal)
      if (part.done) break
      length += part.value.byteLength
      if (length > 16 * 1024) throw new Error('notification acknowledgment too large')
      chunks.push(part.value)
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
    if (
      !result ||
      typeof result !== 'object' ||
      !('code' in result) ||
      result.code !== 200
    )
      throw new Error('notification not acknowledged')
  } finally {
    signal.removeEventListener('abort', abort)
    abort()
    reader.releaseLock()
  }
}

export async function sendAgentNotification(
  input: unknown,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ delivered: true; notificationId: string }> {
  const parsed = AgentNotificationSchema.safeParse(input)
  if (!parsed.success)
    throw new AgentFailure('INVALID_REQUEST', '批次通知参数或 Bark 配置无效。')
  const value = parsed.data
  if (
    !value.settings.enabled ||
    (value.kind === 'completed' && !value.settings.onCompleted) ||
    (value.kind === 'attention' && !value.settings.onAttention)
  )
    throw new AgentFailure('INVALID_REQUEST', '当前批次通知未启用。')
  if (options.signal?.aborted) throw new AgentFailure('CANCELLED', '批次通知已取消。')
  const deadline = new AbortController()
  const signal = AbortSignal.any([
    deadline.signal,
    ...(options.signal ? [options.signal] : []),
  ])
  const timer = setTimeout(() => deadline.abort(), 15_000)
  try {
    const pending = (options.fetchImpl ?? globalThis.fetch)(
      `${value.settings.baseUrl.replace(/\/+$/u, '')}/push`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          device_key: value.settings.deviceKey,
          title: value.title,
          body: value.body,
          group: 'Raccoon 销售任务',
          url: `nexus://agent/${value.batchId}`,
        }),
        signal,
      },
    )
    // Late responses after timeout must release their body without causing a retry here.
    void pending
      .then((response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => {})
      })
      .catch(() => {})
    const response = await beforeAbort(pending, signal)
    try {
      await acknowledgment(response, signal)
    } finally {
      void response.body?.cancel().catch(() => {})
    }
    return { delivered: true, notificationId: value.notificationId }
  } catch {
    if (options.signal?.aborted) throw new AgentFailure('CANCELLED', '批次通知已取消。')
    throw new AgentFailure(
      'NOTIFICATION_FAILED',
      '批次通知发送失败，请检查 Bark 配置或网络。',
      true,
    )
  } finally {
    clearTimeout(timer)
  }
}
