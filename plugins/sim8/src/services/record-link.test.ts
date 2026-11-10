import { describe, expect, it, vi } from 'vitest'
import { readRecordLink } from './record-link.js'

describe('bounded number-link reads', () => {
  it('decodes multibyte characters across stream chunks', async () => {
    const bytes = new TextEncoder().encode('{"msg":"没有短信","expire":"2026-11-03"}')
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
    const fetchImpl = vi.fn<typeof fetch>(async () => response)
    const read = await readRecordLink('https://sms.example.test/number', fetchImpl)
    expect(JSON.parse(read.body)).toEqual({ msg: '没有短信', expire: '2026-11-03' })
  })

  it('cancels oversized responses instead of reading them indefinitely', async () => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024 + 1))
        },
        cancel,
      }),
    )
    await expect(
      readRecordLink(
        'https://sms.example.test/number',
        vi.fn(async () => response),
      ),
    ).rejects.toThrow('响应过大')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reports HTTP and stream failures without leaking the private link', async () => {
    const url = 'https://sms.example.test/read?token=synthetic'
    await expect(
      readRecordLink(
        url,
        vi.fn(async () => new Response('', { status: 403 })),
      ),
    ).rejects.toThrow('HTTP 403')
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(url))
        },
      }),
    )
    await expect(
      readRecordLink(
        url,
        vi.fn(async () => response),
      ),
    ).rejects.toThrow('接码链接请求失败')
  })

  it('rejects unsupported URL protocols before making requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(readRecordLink('file:///tmp/test', fetchImpl)).rejects.toThrow('HTTP')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
