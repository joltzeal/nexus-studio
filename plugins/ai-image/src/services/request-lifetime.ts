import { UpstreamError } from '../domain/errors.js'

export function isRequestTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  let cause: unknown = error
  for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') return true
    if (
      'code' in cause &&
      typeof cause.code === 'string' &&
      /^UND_ERR_(?:HEADERS|BODY|CONNECT)_TIMEOUT$/.test(cause.code)
    ) {
      return true
    }
    cause = cause.cause
  }
  return false
}

/** The same deadline covers headers, streamed bodies and returned image downloads. */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request deadline exceeded', 'TimeoutError')),
    timeoutMs,
  )
  timer.unref?.()
  try {
    return await waitForResponse(controller.signal, () => operation(controller.signal))
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    throw new UpstreamError(
      isRequestTimeout(error, controller.signal) ? 'timeout' : 'network',
    )
  } finally {
    clearTimeout(timer)
    // Also closes an upstream stream that keeps sending heartbeats after its final image.
    controller.abort()
  }
}

/** Readers and test transports may not reject immediately when their signal aborts. */
export async function waitForResponse<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
