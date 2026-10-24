import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSharedSupplyPlugin } from '../index.js'
import { SharedSupplyImages } from './images.js'
import type { DispatchContext } from '../rpc/protocol.js'

const url = 'https://product.aliyizhan.com/person/photo.jpg'
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

function harness(fetchImpl: typeof fetch) {
  const input = new PassThrough()
  const output = new PassThrough()
  const diagnostics = new PassThrough()
  const lines: string[] = []
  output.setEncoding('utf8')
  output.on('data', (line: string) => lines.push(line))
  const instance = createSharedSupplyPlugin({ input, output, diagnostics, fetchImpl })
  instance.server.start()
  input.write('{"type":"handshake","protocolVersion":1}\n')
  let sequence = 0
  cleanups.push(() => instance.server.stop())
  return {
    lines,
    async call(method: string, payload: unknown = {}) {
      const requestId = `image-${++sequence}`
      input.write(
        `${JSON.stringify({
          protocolVersion: 1,
          requestId,
          capability: 'supply.catalog',
          method,
          deadlineMs: 40_000,
          payload,
        })}\n`,
      )
      let response:
        | {
            ok: boolean
            result: Record<string, unknown>
            error?: { code: string; message: string }
          }
        | undefined
      await vi.waitFor(() => {
        response = lines
          .map((line) => JSON.parse(line))
          .find((item) => item.requestId === requestId)
        expect(response).toBeDefined()
      })
      return response!
    },
  }
}

function jpeg(size = 32): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  bytes.set([0xff, 0xd8, 0xff, 0xe0])
  return bytes
}

describe('image transport over the real plugin RPC server', () => {
  it.each([
    ['image/png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])],
    ['image/gif', new TextEncoder().encode('GIF89a data')],
    ['image/webp', new TextEncoder().encode('RIFF0000WEBPdata')],
  ])('preserves supported raster content types: %s', async (mime, bytes) => {
    const host = harness(
      async () => new Response(bytes, { headers: { 'content-type': mime } }),
    )
    const opened = await host.call('supply.image.open', { url })
    expect(opened).toMatchObject({ ok: true, result: { mime, size: bytes.length } })
    const read = await host.call('supply.image.read', { id: opened.result.id, offset: 0 })
    expect(Buffer.from(String(read.result.data), 'base64')).toEqual(Buffer.from(bytes))
    await host.call('supply.image.close', { id: opened.result.id })
  })

  it('follows a relative HTTPS redirect only after validating its target', async () => {
    const requested: string[] = []
    const host = harness(async (input) => {
      requested.push(String(input))
      return requested.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: '/person/redirect.jpg' },
          })
        : new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } })
    })
    const opened = await host.call('supply.image.open', { url })
    expect(opened.ok).toBe(true)
    expect(requested).toEqual([url, 'https://product.aliyizhan.com/person/redirect.jpg'])
    await host.call('supply.image.close', { id: opened.result.id })
  })

  it('accepts the observed logo host/path and upgrades supplier HTTP logos before fetching', async () => {
    const requested: string[] = []
    const host = harness(async (input) => {
      requested.push(String(input))
      return new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } })
    })
    for (const candidate of [
      'http://product.aliyizhan.com/upload-file/logo.jpg',
      'https://thirdwx.qlogo.cn/mmopen/logo/0',
    ]) {
      const opened = await host.call('supply.image.open', { url: candidate })
      expect(opened.ok).toBe(true)
      await host.call('supply.image.close', { id: opened.result.id })
    }
    expect(requested).toEqual([
      'https://product.aliyizhan.com/upload-file/logo.jpg',
      'https://thirdwx.qlogo.cn/mmopen/logo/0',
    ])
  })

  it('uses plugin fetch and transfers an octet-stream photo larger than one host frame without loss', async () => {
    const bytes = jpeg(792_063)
    const requests: { url: string; init?: RequestInit }[] = []
    const host = harness(async (input, init) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) })
      return new Response(bytes, {
        headers: { 'content-type': 'application/octet-stream' },
      })
    })
    const opened = await host.call('supply.image.open', {
      url: url.replace('https:', 'http:'),
    })
    expect(opened.ok).toBe(true)
    expect(opened.result).toMatchObject({ size: 792_063, mime: 'image/jpeg' })
    const id = opened.result.id
    const parts: Buffer[] = []
    let offset = 0
    while (offset < bytes.length) {
      const reply = await host.call('supply.image.read', { id, offset })
      expect(reply.ok).toBe(true)
      expect(reply.result.offset).toBe(offset)
      const part = Buffer.from(String(reply.result.data), 'base64')
      expect(part.length).toBeGreaterThan(0)
      parts.push(part)
      offset += part.length
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from(bytes))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url,
      init: { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' },
    })
    expect(host.lines.every((line) => Buffer.byteLength(line) < 1024 * 1024)).toBe(true)
    expect((await host.call('supply.image.close', { id })).ok).toBe(true)
    expect((await host.call('supply.image.read', { id, offset: 0 })).ok).toBe(false)
  })

  it('reports a failed configured network route and permits a later explicit retry', async () => {
    let requests = 0
    const host = harness(async () => {
      requests += 1
      if (requests === 1) throw new TypeError('proxy unavailable: private diagnostic')
      return new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } })
    })
    const failed = await host.call('supply.image.open', { url })
    expect(failed).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(JSON.stringify(failed)).not.toContain('private diagnostic')
    expect(requests).toBe(1)
    const retry = await host.call('supply.image.open', { url })
    expect(retry.ok).toBe(true)
    await host.call('supply.image.close', { id: retry.result.id })
  })

  it.each([
    'https://evil.example/person/a.jpg',
    'https://product.aliyizhan.com.evil.example/person/a.jpg',
    'https://user:password@product.aliyizhan.com/person/a.jpg',
    'https://product.aliyizhan.com:8443/person/a.jpg',
    'https://product.aliyizhan.com/other/a.jpg',
    'file:///person/a.jpg',
  ])('rejects an untrusted image URL before a network request: %s', async (candidate) => {
    let requests = 0
    const host = harness(async () => {
      requests += 1
      throw new Error('must not fetch')
    })
    expect(await host.call('supply.image.open', { url: candidate })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    expect(requests).toBe(0)
  })

  it.each([
    ['text/html', jpeg()],
    ['image/svg+xml', new TextEncoder().encode('<svg/>')],
    ['image/jpeg', new TextEncoder().encode('<html>blocked</html>')],
    ['application/octet-stream', new TextEncoder().encode('not an image')],
    ['image/png', jpeg()],
  ])('refuses non-images and mismatched MIME: %s', async (mime, bytes) => {
    const host = harness(
      async () => new Response(bytes, { headers: { 'content-type': mime } }),
    )
    expect(await host.call('supply.image.open', { url })).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    })
  })

  it('cancels an oversized streaming body without buffering the whole response', async () => {
    let pulled = 0
    let cancelled = false
    const host = harness(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled += 1
              controller.enqueue(jpeg(1024 * 1024))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { 'content-type': 'image/jpeg' } },
        ),
    )
    expect(await host.call('supply.image.open', { url })).toMatchObject({ ok: false })
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThanOrEqual(11)
  })

  it('rejects an oversized declared length and cancels the body', async () => {
    let cancelled = false
    const host = harness(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          { headers: { 'content-type': 'image/jpeg', 'content-length': '9000000' } },
        ),
    )
    expect(await host.call('supply.image.open', { url })).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    })
    expect(cancelled).toBe(true)
  })

  it('preserves rate-limit errors rather than returning an empty image', async () => {
    const host = harness(async () => new Response(null, { status: 429 }))
    expect(await host.call('supply.image.open', { url })).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    })
  })

  it.each([
    'https://127.0.0.1/private',
    'https://evil.example/person/a.jpg',
    'http://product.aliyizhan.com/person/a.jpg',
  ])('does not follow an unsafe CDN redirect: %s', async (location) => {
    let requests = 0
    const host = harness(async () => {
      requests += 1
      return new Response(null, { status: 302, headers: { location } })
    })
    expect(await host.call('supply.image.open', { url })).toMatchObject({ ok: false })
    expect(requests).toBe(1)
  })
})

function context(): DispatchContext {
  return {
    method: 'supply.image.open',
    requestId: 'test',
    capability: 'supply.catalog',
    deadlineAt: Date.now() + 40_000,
    payload: {},
    assertAlive: () => undefined,
  }
}

describe('bounded plugin image transfers', () => {
  it('expires abandoned snapshots and refuses reads from the expired transfer', async () => {
    vi.useFakeTimers()
    const images = new SharedSupplyImages({
      fetchImpl: async () =>
        new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } }),
    })
    const opened = await images.open(url, context())
    expect(images.read(opened.id, 0).data).not.toBe('')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(() => images.read(opened.id, 0)).toThrow('过期')
  })

  it('bounds snapshot bytes and admits a retry once a transfer closes', async () => {
    const images = new SharedSupplyImages({
      fetchImpl: async () =>
        new Response(jpeg(8 * 1024 * 1024), {
          headers: { 'content-type': 'image/jpeg' },
        }),
    })
    const ids: string[] = []
    try {
      for (let i = 0; i < 4; i += 1) ids.push((await images.open(url, context())).id)
      await expect(images.open(url, context())).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      })
      images.close(ids.shift()!)
      ids.push((await images.open(url, context())).id)
    } finally {
      for (const id of ids) images.close(id)
    }
  })

  it('reports an aborted image download as a timeout without another network attempt', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const images = new SharedSupplyImages({
      fetchImpl: async (_input, init) => {
        attempts += 1
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          })
        })
      },
    })
    // AbortSignal.timeout uses the native timer, so inject only this clock edge.
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const pending = images.open(url, context())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    controller.abort(new DOMException('timeout', 'TimeoutError'))
    await rejected
    expect(attempts).toBe(1)
  })
})
