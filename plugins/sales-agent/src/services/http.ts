import { AgentFailure } from '../errors.js'

export type AgentModelErrorCode =
  | 'MODEL_NETWORK'
  | 'MODEL_HTTP'
  | 'MODEL_INVALID_OUTPUT'
  | 'MODEL_LIMIT'
  | 'MODEL_TIMEOUT'
  | 'MODEL_CAPACITY'
  | 'MODEL_RATE'
  | 'MODEL_BUDGET'
  | 'MODEL_RECEIPT'
  | 'CANCELLED'
  | 'INVALID_REQUEST'

const messages: Record<AgentModelErrorCode, string> = {
  MODEL_NETWORK: 'Model network request failed.',
  MODEL_HTTP: 'Model service rejected the request.',
  MODEL_INVALID_OUTPUT: 'Invalid model output; manual review is required.',
  MODEL_LIMIT: 'Model response or context exceeds the byte limit.',
  MODEL_TIMEOUT: 'Model request deadline exceeded (timeout).',
  MODEL_CAPACITY: 'Waiting for an available model slot.',
  MODEL_RATE: 'Waiting for the model rate limit.',
  MODEL_BUDGET: 'The batch model budget is exhausted.',
  MODEL_RECEIPT: 'The native model permit or usage receipt could not be confirmed.',
  CANCELLED: 'Model request cancelled.',
  INVALID_REQUEST: 'Invalid model input or configuration.',
}

export class AgentModelError extends AgentFailure {
  constructor(
    override readonly code: AgentModelErrorCode,
    retryable = false,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(code, messages[code], retryable)
    this.name = 'AgentModelError'
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value || value.length > 100) return undefined
  const delay = /^\d+(?:\.\d+)?$/u.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now()
  return Number.isFinite(delay)
    ? Math.min(300_000, Math.max(0, Math.ceil(delay)))
    : undefined
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (
    length !== null &&
    (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  ) {
    void response.body?.cancel().catch(() => {})
    throw new AgentModelError('MODEL_LIMIT')
  }
  if (!response.body) throw new AgentModelError('MODEL_INVALID_OUTPUT')
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      if (signal.aborted) throw new AgentModelError('CANCELLED')
      const part = await reader.read()
      if (signal.aborted) throw new AgentModelError('CANCELLED')
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new AgentModelError('MODEL_LIMIT')
      chunks.push(part.value)
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
      )
    } catch {
      throw new AgentModelError('MODEL_INVALID_OUTPUT')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

export async function postModelJson(options: {
  url: string
  apiKey: string
  body: unknown
  timeoutMs: number
  fetchImpl: typeof fetch
  signal?: AbortSignal | undefined
}): Promise<unknown> {
  if (options.signal?.aborted) throw new AgentModelError('CANCELLED')
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(new AgentModelError(timedOut ? 'MODEL_TIMEOUT' : 'CANCELLED', timedOut))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  try {
    const operation = (async () => {
      const response = await options.fetchImpl(options.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(options.body),
        redirect: 'error',
        signal: controller.signal,
      })
      if (controller.signal.aborted)
        throw new AgentModelError(timedOut ? 'MODEL_TIMEOUT' : 'CANCELLED', timedOut)
      if (response.url && new URL(response.url).origin !== new URL(options.url).origin) {
        void response.body?.cancel().catch(() => {})
        throw new AgentModelError('MODEL_HTTP')
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new AgentModelError(
          'MODEL_HTTP',
          response.status === 429 || response.status >= 500,
          response.status,
          retryAfter(response),
        )
      }
      return readJson(response, controller.signal)
    })()
    return await Promise.race([operation, aborted])
  } catch (error) {
    if (controller.signal.aborted)
      throw new AgentModelError(timedOut ? 'MODEL_TIMEOUT' : 'CANCELLED', timedOut)
    if (error instanceof AgentModelError) throw error
    // Never forward a transport error, service body, URL, or abort reason.
    throw new AgentModelError('MODEL_NETWORK', true)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}
