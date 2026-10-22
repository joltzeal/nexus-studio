export const MAX_LINE_BYTES = 64 * 1024

export type LineFrame = { kind: 'line'; bytes: Buffer } | { kind: 'oversized' }

// The limit counts bytes before LF, including CR when CRLF is used.
export async function* frameLines(
  input: AsyncIterable<Uint8Array>,
  maxLineBytes = MAX_LINE_BYTES,
): AsyncGenerator<LineFrame> {
  if (
    !Number.isSafeInteger(maxLineBytes) ||
    maxLineBytes < 1 ||
    maxLineBytes > MAX_LINE_BYTES
  ) {
    throw new RangeError(`Line limit must be between 1 and ${MAX_LINE_BYTES} bytes`)
  }

  const pending = Buffer.allocUnsafe(maxLineBytes)
  let length = 0
  let dropping = false

  for await (const chunk of input) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset)
      const end = newline === -1 ? bytes.length : newline
      const segmentLength = end - offset

      if (!dropping) {
        if (length + segmentLength > maxLineBytes) {
          length = 0
          dropping = true
          yield { kind: 'oversized' }
        } else {
          bytes.copy(pending, length, offset, end)
          length += segmentLength
          if (newline !== -1) {
            const contentLength =
              length > 0 && pending[length - 1] === 13 ? length - 1 : length
            yield { kind: 'line', bytes: Buffer.from(pending.subarray(0, contentLength)) }
            length = 0
          }
        }
      }

      if (newline !== -1) dropping = false
      offset = newline === -1 ? bytes.length : newline + 1
    }
  }

  if (!dropping && length > 0) {
    const contentLength = pending[length - 1] === 13 ? length - 1 : length
    yield { kind: 'line', bytes: Buffer.from(pending.subarray(0, contentLength)) }
  }
}
