/** Bound streamed bytes and the entire body wait, including stalled upstreams. */
export async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (response.body === null) throw new Error('Empty response')
  const reader = response.body.getReader()
  let done = false
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new RangeError('Response too large')
    const chunks: Buffer[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) {
        done = true
        break
      }
      size += part.value.byteLength
      if (size > maxBytes) throw new RangeError('Response too large')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener('abort', abort)
    if (!done) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
