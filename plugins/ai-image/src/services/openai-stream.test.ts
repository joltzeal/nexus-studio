import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UpstreamError, upstreamFailure } from '../domain/errors.js'
import { requestImages, requestVision, type ImageRequest } from './openai.js'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8i8AAAAASUVORK5CYII='
const PNG = new Uint8Array(Buffer.from(PNG_B64, 'base64'))
const REQUEST: ImageRequest = {
  baseUrl: 'https://provider.example.test/v1',
  apiKey: 'private-test-key',
  model: 'gpt-image-2.5-flare',
  prompt: 'private product details',
  size: 'auto',
  count: 1,
  inputs: [],
  timeoutMs: 900_000,
}
const fetchMock = vi.fn<typeof fetch>()
const encoder = new TextEncoder()

function event(payload: unknown, name?: string): string {
  return `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(payload)}\n\n`
}

function completed(type = 'image_generation.completed'): string {
  return event({ type, b64_json: PNG_B64, revised_prompt: '保留商品磨损' })
}

function streamResponse(
  text: string,
  chunkSize = 17,
  close = true,
): { response: Response; cancelled: () => boolean } {
  const bytes = encoder.encode(text)
  let offset = 0
  let wasCancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        if (close) controller.close()
        return
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize))
      offset += chunkSize
    },
    cancel() {
      wasCancelled = true
    },
  })
  return {
    response: new Response(body, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }),
    cancelled: () => wasCancelled,
  }
}

async function failureOf(promise: Promise<unknown>): Promise<UpstreamError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(UpstreamError)
  if (!(error instanceof UpstreamError)) throw new Error('Expected upstream error')
  return error
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockRejectedValue(new Error('Unexpected external request'))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('image streaming requests', () => {
  it.each([
    ['auto', 'gpt-image-2.5-flare', true],
    ['auto', 'gpt-image-1.5', true],
    ['auto', 'chatgpt-image-latest', true],
    ['auto', 'dall-e-3', false],
    ['auto', 'custom-image-model', false],
    ['stream', 'custom-image-model', true],
    ['json', 'gpt-image-2.5-flare', false],
  ] as const)('uses %s mode for %s', async (responseMode, model, streams) => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG_B64 }] }))
    expect(await requestImages({ ...REQUEST, responseMode, model })).toHaveLength(1)
    const init = fetchMock.mock.calls[0]?.[1]
    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(streams ? true : undefined)
    expect(body.model).toBe(model)
    expect(new Headers(init?.headers).get('accept')).toBe(
      streams ? 'text/event-stream, application/json' : 'application/json',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('opts recognized image models into streaming by default and accepts JSON from gateways', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG_B64 }] }))
    expect(await requestImages(REQUEST)).toEqual([
      { bytes: PNG, mime: 'image/png', revisedPrompt: null },
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).stream).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([false, 0, '', null])(
    'accepts a valid compatible JSON response with error=%s',
    async (error) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ error, data: [{ b64_json: PNG_B64 }] }),
      )
      expect(await requestImages(REQUEST)).toHaveLength(1)
    },
  )

  it('streams edits using the same multipart image[] field', async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse(completed('image_edit.completed')).response,
    )
    const outputs = await requestImages({
      ...REQUEST,
      responseMode: 'stream',
      inputs: [{ name: 'reference.png', mime: 'image/png', bytes: PNG }],
    })
    expect(outputs[0]?.bytes).toEqual(PNG)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${REQUEST.baseUrl}/images/edits`)
    expect(init?.body).toBeInstanceOf(FormData)
    const form = init?.body as FormData
    expect(form.get('stream')).toBe('true')
    expect(form.get('model')).toBe(REQUEST.model)
    expect(form.getAll('image[]')).toHaveLength(1)
    expect(form.get('image')).toBeNull()
  })

  it('does not retry a paid POST when the gateway rejects streaming', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { message: 'Unsupported parameter: stream' } },
        { status: 400 },
      ),
    )
    expect(
      await failureOf(requestImages({ ...REQUEST, responseMode: 'stream' })),
    ).toMatchObject({ reason: 'bad-request', status: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('bounded image event streams', () => {
  it.each([1, 7, 1024])(
    'handles UTF-8 boundaries, CRLF, heartbeats and partial images with %s-byte chunks',
    async (chunkSize) => {
      const text = [
        ': keep-alive\n\n',
        event({ type: 'image_generation.partial_image', b64_json: 'not-a-final-image' }),
        event({ status: 'processing' }, 'progress'),
        completed(),
        'data: [DONE]\n\n',
      ]
        .join('')
        .replaceAll('\n', '\r\n')
      fetchMock.mockResolvedValueOnce(streamResponse(text, chunkSize).response)
      expect(await requestImages(REQUEST)).toEqual([
        { bytes: PNG, mime: 'image/png', revisedPrompt: '保留商品磨损' },
      ])
    },
  )

  it('recognizes named completion events and multiline data', async () => {
    const text =
      'event: image_generation.completed\n' +
      'data: {\n' +
      `data: "b64_json":"${PNG_B64}"\n` +
      'data: }\n\n'
    fetchMock.mockResolvedValueOnce(streamResponse(text).response)
    expect((await requestImages(REQUEST))[0]?.bytes).toEqual(PNG)
  })

  it('accepts a compatible gateway final data array and downloads signed URLs without the API Key', async () => {
    const url = 'https://cdn.example.test/generated?signature=private-signature'
    fetchMock
      .mockResolvedValueOnce(streamResponse(event({ data: [{ url }] })).response)
      .mockResolvedValueOnce(new Response(PNG))
    expect((await requestImages(REQUEST))[0]?.bytes).toEqual(PNG)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(url)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toBeUndefined()
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(
      fetchMock.mock.calls[0]?.[1]?.signal,
    )
  })

  it('waits for every requested final image and closes a lingering stream once complete', async () => {
    const { response, cancelled } = streamResponse(
      completed() + ': keep-alive\n\n' + completed(),
      23,
      false,
    )
    fetchMock.mockResolvedValueOnce(response)
    expect(await requestImages({ ...REQUEST, count: 2 })).toHaveLength(2)
    expect(cancelled()).toBe(true)
  })

  it.each([
    [': heartbeat\n\n', 'no final image'],
    [
      event({ type: 'image_generation.partial_image', b64_json: PNG_B64 }),
      'partial only',
    ],
    ['data: [DONE]\n\n', 'done without image'],
    [`data: {"b64_json":"${PNG_B64}"}\n\n`, 'untyped partial image'],
    ['data: not-json\n\n', 'invalid JSON'],
    [completed().trimEnd(), 'truncated SSE frame'],
  ])('rejects an incomplete stream: %s (%s)', async (text) => {
    fetchMock.mockResolvedValueOnce(streamResponse(text).response)
    expect(await failureOf(requestImages(REQUEST))).toMatchObject({
      reason: 'invalid-response',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not mark a truncated multi-image request successful', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(completed()).response)
    expect(await failureOf(requestImages({ ...REQUEST, count: 2 }))).toMatchObject({
      reason: 'invalid-response',
    })
  })

  it('does not count a replayed final event as the next requested image', async () => {
    const first =
      'id: first-image\n' +
      event({
        type: 'image_generation.completed',
        b64_json: PNG_B64,
        revised_prompt: 'first',
      })
    const second =
      'id: second-image\n' +
      event({
        type: 'image_generation.completed',
        b64_json: PNG_B64,
        revised_prompt: 'second',
      })
    fetchMock.mockResolvedValueOnce(streamResponse(first + first + second).response)
    const result = await requestImages({ ...REQUEST, count: 2 })
    expect(result.map((output) => output.revisedPrompt)).toEqual(['first', 'second'])
  })

  it('does not report a compatible array as successful before a following error', async () => {
    const text =
      event({ data: [{ b64_json: PNG_B64 }] }) +
      event({ error: { message: 'Image task failed after buffering' } }, 'error')
    fetchMock.mockResolvedValueOnce(streamResponse(text, 65536).response)
    expect(await failureOf(requestImages(REQUEST))).toMatchObject({ reason: 'refused' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts a completed compatible array with DONE and closes lingering heartbeats', async () => {
    const text = event({ data: [{ b64_json: PNG_B64 }] }) + 'data: [DONE]\n\n'
    const { response, cancelled } = streamResponse(text, 31, false)
    fetchMock.mockResolvedValueOnce(response)
    expect(await requestImages(REQUEST)).toHaveLength(1)
    expect(cancelled()).toBe(true)
  })

  it('redacts stream errors while retaining the provider request ID', async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse(
        event(
          {
            error: {
              message: `No available channel for model custom; ${REQUEST.apiKey}; prompt: ${REQUEST.prompt}`,
              request_id: 'req-stream-test',
            },
          },
          'error',
        ),
      ).response,
    )
    const error = await failureOf(requestImages(REQUEST))
    expect(error).toMatchObject({
      reason: 'channel-unavailable',
      status: 200,
      requestId: 'req-stream-test',
    })
    expect(JSON.stringify(error) + upstreamFailure(error).message).not.toContain(
      REQUEST.apiKey,
    )
    expect(JSON.stringify(error)).not.toContain(REQUEST.prompt)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retains a top-level stream error and does not echo unrelated event data', async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse(
        event({
          type: 'error',
          message: 'Rate limit exceeded',
          status: 429,
          request_id: 'req-rate-limit',
          input: REQUEST.prompt,
        }),
      ).response,
    )
    const error = await failureOf(requestImages(REQUEST))
    expect(error).toMatchObject({ reason: 'rate-limit', requestId: 'req-rate-limit' })
    expect(JSON.stringify(error)).not.toContain(REQUEST.prompt)
  })

  it('cancels an oversized response before consuming its body', async () => {
    const { response, cancelled } = streamResponse('', 1, false)
    response.headers.set('content-length', String(300 * 1024 * 1024))
    fetchMock.mockResolvedValueOnce(response)
    expect(await failureOf(requestImages(REQUEST))).toMatchObject({
      reason: 'invalid-response',
    })
    expect(cancelled()).toBe(true)
  })

  it('bounds an unterminated SSE event and cancels the reader', async () => {
    const chunk = encoder.encode('x'.repeat(1024 * 1024))
    let sent = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1
        if (sent === 1) controller.enqueue(encoder.encode('data: '))
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    fetchMock.mockResolvedValueOnce(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    )
    const error = await failureOf(requestImages(REQUEST))
    expect(error).toMatchObject({ reason: 'invalid-response' })
    expect(error.detail).toContain('大小限制')
    expect(cancelled).toBe(true)
    expect(sent).toBeLessThan(70)
  })

  it('classifies a disconnected stream without using a partial image or retrying', async () => {
    let sent = false
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent)
              return controller.error(new TypeError('private upstream body failure'))
            sent = true
            controller.enqueue(
              encoder.encode(
                event({
                  type: 'image_generation.partial_image',
                  b64_json: PNG_B64,
                }),
              ),
            )
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const error = await failureOf(requestImages(REQUEST))
    expect(error.reason).toBe('network')
    expect(JSON.stringify(error)).not.toContain('private upstream')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('one deadline for request and image consumption', () => {
  it('allows a response after the former three-minute deadline', async () => {
    vi.useFakeTimers()
    let complete!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const promise = requestImages(REQUEST)
    await vi.advanceTimersByTimeAsync(181_000)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    complete(Response.json({ data: [{ b64_json: PNG_B64 }] }))
    expect(await promise).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['text/event-stream', 'application/json', 'text/html'])(
    'aborts a stalled %s body at the configured deadline',
    async (contentType) => {
      vi.useFakeTimers()
      const { response, cancelled } = streamResponse('', 1, false)
      response.headers.set('content-type', contentType)
      fetchMock.mockResolvedValueOnce(response)
      const result = failureOf(requestImages({ ...REQUEST, timeoutMs: 10_000 }))
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await result).toMatchObject({ reason: 'timeout' })
      expect(cancelled()).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('shares the remaining budget with image downloads and classifies body timeout correctly', async () => {
    vi.useFakeTimers()
    const { response, cancelled } = streamResponse('', 1, false)
    const imageUrl = 'https://cdn.example.test/image?sig=private-signature'
    fetchMock
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 8000))
        return Response.json({ data: [{ url: imageUrl }] })
      })
      .mockResolvedValueOnce(response)
    const result = failureOf(requestImages({ ...REQUEST, timeoutMs: 10_000 }))
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await result).toMatchObject({ reason: 'timeout' })
    expect(cancelled()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops even if heartbeats continue, instead of extending the total deadline', async () => {
    vi.useFakeTimers()
    let interval: ReturnType<typeof setInterval>
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        interval = setInterval(
          () => controller.enqueue(encoder.encode(': ping\n\n')),
          100,
        )
      },
      cancel() {
        cancelled = true
        clearInterval(interval)
      },
    })
    fetchMock.mockResolvedValueOnce(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    )
    const result = failureOf(requestImages({ ...REQUEST, timeoutMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1001)
    expect(await result).toMatchObject({ reason: 'timeout' })
    expect(cancelled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'])(
    'classifies transport %s without leaking the raw error',
    async (code) => {
      fetchMock.mockRejectedValueOnce(
        new TypeError('fetch failed with private diagnostic', {
          cause: Object.assign(new Error('private nested diagnostic'), { code }),
        }),
      )
      const error = await failureOf(requestImages(REQUEST))
      expect(error.reason).toBe('timeout')
      expect(JSON.stringify(error)).not.toContain('private')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('classifies a timed-out recognition body as timeout before image generation', async () => {
    vi.useFakeTimers()
    const { response, cancelled } = streamResponse('', 1, false)
    response.headers.set('content-type', 'application/json')
    fetchMock.mockResolvedValueOnce(response)
    const result = failureOf(
      requestVision({
        baseUrl: REQUEST.baseUrl,
        apiKey: REQUEST.apiKey,
        model: 'vision-model',
        image: { mime: 'image/png', bytes: PNG },
        timeoutMs: 300_000,
      }),
    )
    await vi.advanceTimersByTimeAsync(300_001)
    expect(await result).toMatchObject({ reason: 'timeout' })
    expect(cancelled()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts while reading an HTTP error body and releases its resources', async () => {
    vi.useFakeTimers()
    let cancelled = false
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
        { status: 503 },
      ),
    )
    const result = failureOf(requestImages({ ...REQUEST, timeoutMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1001)
    expect(await result).toMatchObject({ reason: 'timeout' })
    expect(cancelled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains HTTP error diagnostics when its body disconnects without timing out', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError('private body diagnostic'))
          },
        }),
        { status: 401, headers: { 'x-request-id': 'req-auth-disconnect' } },
      ),
    )
    const error = await failureOf(requestImages(REQUEST))
    expect(error).toMatchObject({
      reason: 'auth',
      status: 401,
      requestId: 'req-auth-disconnect',
    })
    expect(upstreamFailure(error).code).toBe('AUTH_FAILED')
    expect(JSON.stringify(error)).not.toContain('private body')
  })
})
