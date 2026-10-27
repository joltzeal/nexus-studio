import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UpstreamError, upstreamFailure } from '../domain/errors.js'
import { checkProvider, requestImages, type ImageRequest } from './openai.js'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8i8AAAAASUVORK5CYII='
const PNG = new Uint8Array(Buffer.from(PNG_B64, 'base64'))
const REQUEST_ID = '202610271426484395702948268d9d6jGhrLe3l'
const NO_CHANNEL =
  'No available channel for model gpt-image-2.5-flare under group default (distributor)'
const REQUEST: ImageRequest = {
  baseUrl: 'https://provider.example.test/v1',
  apiKey: 'test-private-key+with/symbols',
  model: 'gpt-image-2.5-flare',
  prompt: 'Private product description "with quotes"\nand a second line',
  size: 'auto',
  count: 1,
  inputs: [],
  timeoutMs: 1000,
}
const fetchMock = vi.fn<typeof fetch>()

function json(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

async function failureOf(
  promise: Promise<unknown> = requestImages(REQUEST),
): Promise<UpstreamError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(UpstreamError)
  if (!(error instanceof UpstreamError)) throw new Error('Expected upstream failure')
  return error
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockRejectedValue(new Error('Unexpected external request'))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bounded upstream diagnostics', () => {
  it.each([400, 503, 424])(
    'explains an unavailable key-group/model channel on HTTP %s without retrying',
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        json({ error: { message: `${NO_CHANNEL} (request id: ${REQUEST_ID})` } }, status),
      )

      const error = await failureOf()
      expect(error).toMatchObject({
        reason: 'channel-unavailable',
        status,
        requestId: REQUEST_ID,
      })
      expect(error.detail).toContain(NO_CHANNEL)
      const failure = upstreamFailure(error)
      expect(failure).toMatchObject({ code: 'UNAVAILABLE', retryable: false })
      expect(failure.message).toMatch(/API Key.*分组/)
      expect(failure.message).toMatch(/模型.*通道/)
      expect(failure.message).toContain(`HTTP ${status}`)
      expect(failure.message).toContain(REQUEST_ID)
      expect(failure.message).not.toMatch(/激活|浏览器/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://provider.example.test/v1/images/generations',
      )
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        model: REQUEST.model,
        prompt: REQUEST.prompt,
        n: 1,
      })
    },
  )

  it.each([
    [401, 'auth', 'AUTH_FAILED'],
    [403, 'auth', 'AUTH_FAILED'],
    [404, 'not-found', 'NOT_CONFIGURED'],
    [429, 'rate-limit', 'RATE_LIMITED'],
    [400, 'bad-request', 'INVALID_REQUEST'],
    [415, 'bad-request', 'INVALID_REQUEST'],
    [422, 'bad-request', 'INVALID_REQUEST'],
    [502, 'refused', 'UNAVAILABLE'],
  ])('retains status and safe detail for HTTP %s', async (status, reason, code) => {
    fetchMock.mockResolvedValueOnce(
      json({ error: 'Provider diagnostic' }, Number(status), {
        'x-request-id': REQUEST_ID,
      }),
    )
    const error = await failureOf()
    expect(error).toMatchObject({ reason, status, requestId: REQUEST_ID })
    const failure = upstreamFailure(error)
    expect(failure.code).toBe(code)
    expect(failure.message).toContain(`HTTP ${status}`)
    expect(failure.message).toContain('Provider diagnostic')
    expect(failure.message).toContain(REQUEST_ID)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('redacts reflected credentials, signed URLs and request payloads before truncation', async () => {
    const secrets = [
      REQUEST.apiKey,
      JSON.stringify(REQUEST.prompt).slice(1, -1),
      encodeURIComponent(REQUEST.apiKey),
      'other-secret-token',
      'private-signature',
      'hidden-request-field',
    ]
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            message: [
              NO_CHANNEL,
              ...secrets.slice(0, 3),
              'Authorization: Bearer other-secret-token',
              'https://cdn.example.test/image?sig=private-signature',
              'prompt: hidden-request-field',
            ].join('; '),
            request_id: REQUEST_ID,
          },
          request: { apiKey: REQUEST.apiKey, prompt: REQUEST.prompt },
        },
        503,
      ),
    )
    const error = await failureOf()
    expect(error.detail).toContain(NO_CHANNEL)
    expect(error.detail?.length).toBeLessThanOrEqual(220)
    const diagnostics = JSON.stringify(error) + upstreamFailure(error).message
    for (const secret of secrets) expect(diagnostics).not.toContain(secret)
    expect(diagnostics).not.toContain(REQUEST.prompt)
    expect(upstreamFailure(error).message).toContain(REQUEST_ID)
  })

  it('retains a body request ID beyond the bounded detail', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            message: `${NO_CHANNEL} ${'detail '.repeat(200)} (request id: ${REQUEST_ID})`,
          },
        },
        503,
      ),
    )
    const error = await failureOf()
    expect(error).toMatchObject({ reason: 'channel-unavailable', requestId: REQUEST_ID })
    expect(error.detail?.length).toBeLessThanOrEqual(220)
    expect(upstreamFailure(error).message.length).toBeLessThanOrEqual(600)
    expect(upstreamFailure(error).message).toContain(REQUEST_ID)
  })

  it.each([
    ['Authorization: Bearer private-other-token', 'private-other-token'],
    ['api_key = "private-other-token"', 'private-other-token'],
    ['password: private-other-token', 'private-other-token'],
    ['https://cdn.example.test/image?sig=private-other-token', 'private-other-token'],
    [`data:image/png;base64,${PNG_B64}`, PNG_B64],
    ['input: {"privateData":"private-response-payload"}', 'private-response-payload'],
    ['<html><body>private-response-payload</body></html>', 'private-response-payload'],
  ])(
    'redacts sensitive content within a short error message: %s',
    async (text, secret) => {
      fetchMock.mockResolvedValueOnce(
        json(
          { error: { message: `${NO_CHANNEL}; ${text}` }, request_id: REQUEST_ID },
          503,
        ),
      )
      const error = await failureOf()
      expect(error).toMatchObject({
        reason: 'channel-unavailable',
        requestId: REQUEST_ID,
      })
      expect(error.detail).toContain(NO_CHANNEL)
      expect(JSON.stringify(error) + upstreamFailure(error).message).not.toContain(secret)
    },
  )

  it('redacts a reflected prompt before overlapping credential values', async () => {
    const prompt = `private-product-facts containing ${REQUEST.apiKey}`
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: `Rejected ${prompt}` } }, 400),
    )
    const error = await failureOf(requestImages({ ...REQUEST, prompt }))
    expect(JSON.stringify(error) + upstreamFailure(error).message).not.toContain(
      'private-product-facts',
    )
    expect(error.detail).not.toContain(REQUEST.apiKey)
  })

  it('does not mistake quoted request content for a provider channel failure', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: `Invalid prompt: ${NO_CHANNEL}` } }, 400),
    )
    const error = await failureOf(requestImages({ ...REQUEST, prompt: NO_CHANNEL }))
    expect(error.reason).toBe('bad-request')
    expect(upstreamFailure(error).code).toBe('INVALID_REQUEST')
  })

  it('recognizes plain-text gateway errors and a request-id header', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(NO_CHANNEL, { status: 503, headers: { 'request-id': REQUEST_ID } }),
    )
    expect(await failureOf()).toMatchObject({
      reason: 'channel-unavailable',
      status: 503,
      requestId: REQUEST_ID,
    })
  })

  it.each([
    `<html><body>private-response-payload ${REQUEST.apiKey}</body></html>`,
    `{"error": "private-response-payload", "api_key": "${REQUEST.apiKey}"`,
    JSON.stringify({ request: { prompt: 'private-response-payload' } }),
  ])('does not expose HTML, invalid JSON or unrelated payload fields', async (body) => {
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 502, headers: { 'x-request-id': REQUEST_ID } }),
    )
    const error = await failureOf()
    const diagnostic = JSON.stringify(error) + upstreamFailure(error).message
    expect(diagnostic).not.toContain('private-response-payload')
    expect(diagnostic).not.toContain(REQUEST.apiKey)
    expect(upstreamFailure(error).message).toContain('HTTP 502')
    expect(upstreamFailure(error).message).toContain(REQUEST_ID)
  })

  it('bounds diagnostic body consumption and cancels an oversized error stream', async () => {
    let chunksRead = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1
        if (chunksRead > 100) {
          controller.close()
          return
        }
        controller.enqueue(new TextEncoder().encode('x'.repeat(8192)))
      },
      cancel() {
        cancelled = true
      },
    })
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { status: 503, headers: { 'x-request-id': REQUEST_ID } }),
    )
    const error = await failureOf()
    expect(chunksRead).toBeLessThan(10)
    expect(cancelled).toBe(true)
    expect(upstreamFailure(error).message).toContain('HTTP 503')
    expect(upstreamFailure(error).message).toContain(REQUEST_ID)
    expect(upstreamFailure(error).message.length).toBeLessThanOrEqual(600)
  })
})

describe('image response validation', () => {
  it.each([
    ['null payload', null],
    ['non-object payload', 'not an image'],
    ['missing data', {}],
    ['non-array data', { data: {} }],
    ['empty data', { data: [] }],
    ['null row', { data: [null] }],
    ['non-object row', { data: ['not an image'] }],
    ['missing image', { data: [{}] }],
    ['invalid base64 alphabet', { data: [{ b64_json: `${PNG_B64}!?` }] }],
    ['invalid base64 padding', { data: [{ b64_json: `${PNG_B64}=` }] }],
    ['empty base64', { data: [{ b64_json: ' \n ' }] }],
    [
      'base64 text',
      { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] },
    ],
    ['truncated PNG signature', { data: [{ b64_json: 'iVBORw==' }] }],
    ['invalid URL', { data: [{ url: 'not a URL' }] }],
    ['non-HTTP URL', { data: [{ url: 'data:text/html,private-response-payload' }] }],
  ])('rejects %s as a classified upstream failure', async (_name, payload) => {
    fetchMock.mockResolvedValueOnce(json(payload, 200, { 'x-request-id': REQUEST_ID }))
    const error = await failureOf()
    expect(error).toMatchObject({
      reason: 'invalid-response',
      status: 200,
      requestId: REQUEST_ID,
    })
    expect(upstreamFailure(error).message).toContain('HTTP 200')
    expect(upstreamFailure(error).message).toContain(REQUEST_ID)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('classifies non-JSON on the edit path: %s', async (edit) => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>private-response-payload</html>', {
        headers: { 'content-type': 'text/html', 'x-request-id': REQUEST_ID },
      }),
    )
    const error = await failureOf(
      requestImages({
        ...REQUEST,
        inputs: edit ? [{ mime: 'image/png', bytes: PNG, name: 'reference.png' }] : [],
      }),
    )
    expect(error).toMatchObject({
      reason: 'invalid-response',
      status: 200,
      requestId: REQUEST_ID,
    })
    expect(error.detail).toContain('JSON')
    expect(upstreamFailure(error).message).not.toContain('private-response-payload')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['image/png', 'text/html', 'application/octet-stream'])(
    'rejects downloaded HTML even with content-type %s',
    async (contentType) => {
      fetchMock
        .mockResolvedValueOnce(
          json({
            data: [{ url: 'https://cdn.example.test/image?sig=private-signature' }],
          }),
        )
        .mockResolvedValueOnce(
          new Response('<html>private-response-payload</html>', {
            headers: { 'content-type': contentType, 'x-request-id': REQUEST_ID },
          }),
        )
      const error = await failureOf()
      expect(error).toMatchObject({
        reason: 'invalid-response',
        status: 200,
        requestId: REQUEST_ID,
      })
      expect(upstreamFailure(error).message).not.toContain('private-response-payload')
      expect(upstreamFailure(error).message).not.toContain('private-signature')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1]?.[1]?.headers).toBeUndefined()
    },
  )

  it('redacts signed URL credentials reflected as a download request ID', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ data: [{ url: 'https://cdn.example.test/image?sig=private-signature' }] }),
      )
      .mockResolvedValueOnce(
        new Response('not an image', {
          headers: { 'x-request-id': 'private-signature' },
        }),
      )
    const error = await failureOf()
    expect(error.reason).toBe('invalid-response')
    expect(JSON.stringify(error) + upstreamFailure(error).message).not.toContain(
      'private-signature',
    )
  })

  it.each([
    ['unpadded PNG', PNG_B64.replace(/=+$/, ''), PNG, 'image/png'],
    ['whitespace-wrapped PNG', ` \n${PNG_B64}\r\n`, PNG, 'image/png'],
    [
      'JPEG signature',
      '/9j/4AAQ',
      new Uint8Array([255, 216, 255, 224, 0, 16]),
      'image/jpeg',
    ],
    [
      'URL-safe JPEG signature',
      '_9j_4AAQ',
      new Uint8Array([255, 216, 255, 224, 0, 16]),
      'image/jpeg',
    ],
    [
      'WebP signature',
      'UklGRgAAAABXRUJQ',
      new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
      'image/webp',
    ],
  ])('preserves supported base64 encoding: %s', async (_name, encoded, bytes, mime) => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ b64_json: encoded }] }))
    expect(await requestImages(REQUEST)).toEqual([{ bytes, mime, revisedPrompt: null }])
  })

  it('preserves valid base64 and signed image URLs with generic content types', async () => {
    const url = 'https://cdn.example.test/image?sig=private-signature'
    fetchMock
      .mockResolvedValueOnce(
        json({
          data: [
            { b64_json: PNG_B64, revised_prompt: 'A revised image prompt' },
            { url },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } }),
      )
    expect(await requestImages(REQUEST)).toEqual([
      { bytes: PNG, mime: 'image/png', revisedPrompt: 'A revised image prompt' },
      { bytes: PNG, mime: 'image/png', revisedPrompt: null },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(url)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toBeUndefined()
  })
})

it('reports /models as connectivity only even when the image model is listed', async () => {
  fetchMock.mockResolvedValueOnce(json({ data: [{ id: REQUEST.model }] }))
  const result = await checkProvider(REQUEST.baseUrl, REQUEST.apiKey, REQUEST.timeoutMs)
  expect(result).toMatchObject({ ok: true, modelCount: 1 })
  expect(result.message).toContain('连通性')
  expect(result.message).toMatch(/不.*生图.*可用/)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example.test/v1/models')
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET')
})
