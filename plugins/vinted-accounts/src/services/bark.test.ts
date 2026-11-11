import { afterEach, describe, expect, it, vi } from 'vitest'

import { sendBark } from './bark.js'

const bark = {
  baseUrl: 'https://bark.example.test',
  deviceKey: 'synthetic-device-key',
  enabled: true,
}

afterEach(() => vi.useRealTimers())

describe('Bark notification delivery', () => {
  it('posts JSON to the selected service and requires successful delivery acknowledgment', async () => {
    let request: { url: string; init: RequestInit | undefined } | null = null
    await sendBark(
      bark,
      {
        title: 'Vinted 商品已售',
        body: 'seller\nCanvas',
        url: 'https://vinted.fr/items/1',
      },
      {
        fetchImpl: async (url, init) => {
          request = { url: String(url), init }
          return Response.json({ code: 200 })
        },
      },
    )
    expect(request).toMatchObject({
      url: 'https://bark.example.test/push',
      init: { method: 'POST', redirect: 'error' },
    })
    expect(JSON.parse(String(request!.init?.body))).toEqual({
      device_key: 'synthetic-device-key',
      title: 'Vinted 商品已售',
      body: 'seller\nCanvas',
      group: 'Vinted 订单监控',
      url: 'https://vinted.fr/items/1',
    })
  })

  it.each([
    () => Response.json({ code: 500, message: 'synthetic-device-key' }),
    () => new Response('<html>gateway</html>'),
    () => Response.json({ message: 'missing code' }),
    () => new Response('', { status: 302, headers: { location: 'https://other.test' } }),
    () => new Response('x'.repeat(17_000)),
  ])('does not mark errors or unrecognized replies as delivered', async (response) => {
    await expect(
      sendBark(
        bark,
        { title: 'test', body: 'test' },
        { fetchImpl: async () => response() },
      ),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.not.stringContaining('synthetic-device-key'),
    })
  })

  it('does not send invalid settings or a cancelled notification', async () => {
    let sent = false
    const fetchImpl: typeof fetch = async () => {
      sent = true
      return Response.json({ code: 200 })
    }
    await expect(
      sendBark(
        { ...bark, deviceKey: '' },
        { title: 'test', body: 'test' },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      sendBark(
        bark,
        { title: 'test', body: 'test' },
        { fetchImpl, signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow()
    expect(sent).toBe(false)
  })

  it('ends a stalled delivery at the deadline even when its transport ignores abort', async () => {
    vi.useFakeTimers()
    const sent = sendBark(
      bark,
      { title: 'test', body: 'test' },
      { fetchImpl: () => new Promise(() => {}) },
    )
    const rejected = expect(sent).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
  })

  it('cancels a stalled response body without waiting for its cancel hook', async () => {
    const controller = new AbortController()
    const response = new Response(
      new ReadableStream({
        pull: () => new Promise(() => {}),
        cancel: () => new Promise(() => {}),
      }),
    )
    const sent = sendBark(
      bark,
      { title: 'test', body: 'test' },
      { fetchImpl: async () => response, signal: controller.signal },
    )
    const rejected = expect(sent).rejects.toThrow()
    await Promise.resolve()
    controller.abort()
    await rejected
  })
})
