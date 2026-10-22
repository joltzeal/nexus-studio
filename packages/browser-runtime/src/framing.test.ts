import { describe, expect, it } from 'vitest'
import { frameLines, MAX_LINE_BYTES } from './index.js'
import type { LineFrame } from './index.js'

async function* chunks(...input: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* input
}

async function collect(
  input: AsyncIterable<Uint8Array>,
  limit?: number,
): Promise<LineFrame[]> {
  const frames: LineFrame[] = []
  for await (const frame of frameLines(input, limit)) frames.push(frame)
  return frames
}

function text(frames: LineFrame[]): string[] {
  return frames.map((frame) =>
    frame.kind === 'line' ? frame.bytes.toString('utf8') : '<oversized>',
  )
}

describe('bounded byte framing', () => {
  it('handles split UTF-8 bytes, CRLF, multiple lines, and an unterminated final line', async () => {
    const bytes = Buffer.from('我的工作室\r\nsecond\nlast')
    const frames = await collect(
      chunks(bytes.subarray(0, 1), bytes.subarray(1, 7), bytes.subarray(7)),
    )
    expect(text(frames)).toEqual(['我的工作室', 'second', 'last'])
  })

  it('keeps emitted buffers independent from later input', async () => {
    expect(text(await collect(chunks(Buffer.from('first\nother\n'))))).toEqual([
      'first',
      'other',
    ])
  })

  it('accepts the exact limit and rejects one byte over it', async () => {
    expect(text(await collect(chunks(Buffer.from('1234\n12345\nok\n')), 4))).toEqual([
      '1234',
      '<oversized>',
      'ok',
    ])
  })

  it('counts UTF-8 bytes instead of characters', async () => {
    expect(text(await collect(chunks(Buffer.from('我我\nok\n')), 5))).toEqual([
      '<oversized>',
      'ok',
    ])
  })

  it('emits an error before newline and drops an oversized line across chunks', async () => {
    const frames = frameLines(
      chunks(
        Buffer.alloc(MAX_LINE_BYTES, 97),
        Buffer.from('x'),
        Buffer.alloc(1024 * 1024, 98),
        Buffer.from('\nok\n'),
      ),
    )
    expect(await frames.next()).toEqual({ done: false, value: { kind: 'oversized' } })
    const next = await frames.next()
    expect(next.value).toMatchObject({ kind: 'line' })
    if (next.value?.kind === 'line') expect(next.value.bytes.toString()).toBe('ok')
    expect((await frames.next()).done).toBe(true)
  })

  it('ends gracefully while dropping an oversized unterminated line', async () => {
    expect(text(await collect(chunks(Buffer.alloc(MAX_LINE_BYTES + 1, 97))))).toEqual([
      '<oversized>',
    ])
  })

  it('does not synthesize a line on empty input or after a trailing newline', async () => {
    expect(await collect(chunks())).toEqual([])
    expect(text(await collect(chunks(Buffer.from('\n'))))).toEqual([''])
  })

  it.each([0, -1, 0.5, MAX_LINE_BYTES + 1, Number.POSITIVE_INFINITY])(
    'rejects a line limit outside the bounded range: %s',
    async (limit) => {
      await expect(collect(chunks(), limit)).rejects.toThrow(RangeError)
    },
  )
})
