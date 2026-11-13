import { afterEach, describe, expect, it, vi } from 'vitest'
import { crc32, inflateSync } from 'node:zlib'
import { AgentSettingsSchema, type AgentProductSnapshot } from '@nexus/plugin-sdk/agent'
import { createAgentModels } from './models.js'
import { AgentFailure } from '../errors.js'

const product: AgentProductSnapshot = {
  id: '10000000-0000-4000-8000-000000000001',
  revision: 1,
  name: 'Blue shirt',
  title: 'Blue cotton shirt',
  description: 'A used blue cotton shirt with a small mark on the sleeve.',
  price: 12.5,
  currency: 'EUR',
  category: 'Shirts',
  condition: 'Good',
  brand: '',
  size: 'M',
  tags: [],
  images: [
    {
      id: '10000000-0000-4000-8000-000000000002',
      artifactId: '10000000-0000-4000-8000-000000000003',
      name: 'shirt.png',
      mime: 'image/png',
      bytes: 68,
      sha256: 'a'.repeat(64),
    },
  ],
}
const settings = AgentSettingsSchema.parse({
  decision: {
    protocol: 'typesafe',
    baseUrl: 'https://decision.test/v1',
    apiKey: 'synthetic-decision-secret',
    model: 'jev-selected',
  },
  generation: {
    baseUrl: 'https://generation.test/v1',
    apiKey: 'synthetic-generation-secret',
    model: 'vision-selected',
  },
  requestTimeoutMs: 5000,
  maxStepsPerItem: 30,
  maxCopyRewrites: 2,
  reviewThreshold: 0.8,
})
const image = {
  mime: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',
}
const review = {
  decision: 'pass',
  confidence: 0.86,
  reason: 'The photograph shows the supplied item clearly.',
}
const snapshot = {
  url: 'https://www.vinted.fr/items/new',
  title: 'Sell an item',
  text: 'Title Description Price Upload',
  controls: [
    { index: 0, role: 'textbox', name: 'Title', value: '' },
    { index: 1, role: 'textbox', name: 'Description', value: '' },
    { index: 2, role: 'textbox', name: 'Price', value: '' },
    { index: 3, role: 'combobox', name: 'Currency', value: 'EUR' },
  ],
}

function chat(value: unknown, extra: Record<string, unknown> = {}) {
  return Response.json({
    model: 'vision-selected',
    choices: [
      { finish_reason: 'stop', message: { content: JSON.stringify(value) }, ...extra },
    ],
  })
}

function decision(overrides: Record<string, unknown> = {}) {
  return Response.json({
    model: 'jev-1.14.0',
    answers: {
      review: {
        type: 'choice',
        choice: 'pass',
        confidence: 0.73,
        probabilities: { pass: 0.86, skip: 0.04, review: 0.1 },
      },
      english: { type: 'noul', noul: 0.97 },
      supported: { type: 'noul', noul: 0.94 },
      ...overrides,
    },
    usage: { input_tokens: 200, output_tokens: 20 },
  })
}

function accountDecision(overrides: Record<string, number> = {}) {
  const scores = {
    verified: 0.1,
    established: 0.1,
    needs_attention: 0.1,
    clothing_seller: 0.1,
    footwear_seller: 0.1,
    accessories_seller: 0.1,
    home_seller: 0.1,
    electronics_seller: 0.1,
    books_media_seller: 0.1,
    kids_items_seller: 0.1,
    beauty_seller: 0.1,
    sports_seller: 0.1,
    ...overrides,
  }
  return Response.json({
    model: 'jev-1.14.0',
    answers: Object.fromEntries(
      Object.entries(scores).map(([key, noul]) => [key, { type: 'noul', noul }]),
    ),
    usage: { input_tokens: 100, output_tokens: 12 },
  })
}

function setup(response: () => Response | Promise<Response>, config = settings) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} })
    return response()
  }
  return { models: createAgentModels(config, { fetchImpl }), requests }
}

afterEach(() => vi.useRealTimers())

describe('model error classification', () => {
  it.each([
    { header: '90', expected: 90_000 },
    { header: '999999', expected: 300_000 },
    { header: 'garbage', expected: undefined },
  ])(
    'carries a bounded retry-after value to durable scheduling: $header',
    async ({ header, expected }) => {
      const { models } = setup(
        () => new Response('', { status: 429, headers: { 'retry-after': header } }),
      )
      await expect(models.reviewImage({ product, image })).rejects.toMatchObject({
        code: 'MODEL_HTTP',
        status: 429,
        retryAfterMs: expected,
      })
    },
  )

  it('consumes no network request when native model capacity or budget is denied', async () => {
    for (const reason of ['capacity', 'rate', 'budget'] as const) {
      let requests = 0
      let completions = 0
      const models = createAgentModels(settings, {
        fetchImpl: async () => {
          requests++
          return chat(review)
        },
        acquire: async ({ requestId }) => ({
          acquired: false,
          requestId,
          reason,
          retryAfterMs: 2000,
        }),
        complete: async () => {
          completions++
          return { recorded: true }
        },
      })
      await expect(models.reviewImage({ product, image })).rejects.toMatchObject({
        code:
          reason === 'budget'
            ? 'MODEL_BUDGET'
            : reason === 'rate'
              ? 'MODEL_RATE'
              : 'MODEL_CAPACITY',
        retryable: reason !== 'budget',
      })
      expect(requests).toBe(0)
      expect(completions).toBe(0)
    }
  })

  it('uses the same native request identity to account for a successful request and unknown usage', async () => {
    const requestId = '10000000-0000-4000-8000-000000000010'
    const permits: unknown[] = []
    const completions: unknown[] = []
    const models = createAgentModels(settings, {
      fetchImpl: async () => chat(review),
      acquire: async (input) => {
        permits.push(input)
        return { acquired: true, requestId: input.requestId }
      },
      complete: async (input) => {
        completions.push(input)
        return { recorded: true }
      },
    })
    expect(await models.reviewImage({ product, image, requestId })).toEqual(review)
    expect(permits).toEqual([{ requestId, kind: 'generation' }])
    expect(completions).toEqual([
      {
        requestId,
        outcome: 'succeeded',
        elapsedMs: expect.any(Number),
        inputTokens: null,
        outputTokens: null,
      },
    ])
  })

  it('accounts for TypeSafe usage and releases a failed or cancelled permit exactly once', async () => {
    const outcomes: unknown[] = []
    const models = createAgentModels(settings, {
      fetchImpl: async () => decision(),
      acquire: async ({ requestId }) => ({ acquired: true, requestId }),
      complete: async (result) => {
        outcomes.push(result)
        return { recorded: true }
      },
    })
    await models.reviewCopy({
      product,
      title: product.title,
      description: product.description,
    })
    expect(outcomes[0]).toMatchObject({
      outcome: 'succeeded',
      inputTokens: 200,
      outputTokens: 20,
    })
    for (const cancelled of [false, true]) {
      const controller = new AbortController()
      const failed = createAgentModels(settings, {
        fetchImpl: async () => {
          if (cancelled) controller.abort()
          throw new Error('transport')
        },
        acquire: async ({ requestId }) => ({ acquired: true, requestId }),
        complete: async (result) => {
          outcomes.push(result)
          return { recorded: true }
        },
      })
      await expect(
        failed.reviewImage({ product, image, signal: controller.signal }),
      ).rejects.toThrow()
    }
    expect(outcomes).toHaveLength(3)
    expect(outcomes[1]).toMatchObject({ outcome: 'failed' })
    expect(outcomes[2]).toMatchObject({ outcome: 'cancelled' })
  })
  it('distinguishes retryable transport errors from malformed model output', async () => {
    const network = setup(() => {
      throw new Error(settings.generation.apiKey)
    }).models
    const networkError = await network
      .reviewImage({ product, image })
      .catch((error: unknown) => error)
    expect(networkError).toBeInstanceOf(AgentFailure)
    expect(networkError).toMatchObject({ code: 'MODEL_NETWORK', retryable: true })
    const malformed = setup(() => chat({ decision: 'pass' })).models
    const outputError = await malformed
      .reviewImage({ product, image })
      .catch((error: unknown) => error)
    expect(outputError).toBeInstanceOf(AgentFailure)
    expect(outputError).toMatchObject({ code: 'MODEL_INVALID_OUTPUT', retryable: false })
  })

  it.each([
    { status: 401, retryable: false },
    { status: 429, retryable: true },
    { status: 503, retryable: true },
  ])(
    'reports an HTTP failure without echoing the response: %j',
    async ({ status, retryable }) => {
      const { models } = setup(() => new Response(settings.generation.apiKey, { status }))
      const error = await models
        .reviewImage({ product, image })
        .catch((value: unknown) => value)
      expect(error).toMatchObject({ code: 'MODEL_HTTP', status, retryable })
      expect(String(error)).not.toContain(settings.generation.apiKey)
    },
  )

  it('bounds the whole fetch deadline even if fetch never observes cancellation', async () => {
    vi.useFakeTimers()
    const { models } = setup(() => new Promise<Response>(() => {}))
    const assertion = expect(
      models.reviewImage({ product, image }),
    ).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(5001)
    await assertion
  })

  it('does not pass truncated or refused model completions', async () => {
    for (const extra of [
      { finish_reason: 'length' },
      { message: { content: JSON.stringify(review), refusal: 'No.' } },
    ]) {
      const { models } = setup(() => chat(review, extra))
      await expect(models.reviewImage({ product, image })).rejects.toMatchObject({
        code: 'MODEL_INVALID_OUTPUT',
      })
    }
  })

  it('never returns an echoed API key in a model explanation', async () => {
    const { models } = setup(() =>
      chat({ ...review, reason: `Review complete. ${settings.generation.apiKey}` }),
    )
    const result = await models.reviewImage({ product, image })
    expect(result.reason).not.toContain(settings.generation.apiKey)
  })
})

describe('sales Agent model adapters', () => {
  it.each([
    {
      tags: Array.from({ length: 9 }, () => 'verified'),
      summary: 'The account is verified.',
    },
    {
      tags: ['established_selling_history'],
      summary: 'The account has received reviews.',
    },
    { tags: ['verified'], summary: 'The account has received reviews. '.repeat(6) },
    { tags: ['verified'], summary: 'The account\nis verified.' },
    { tags: ['verified\uD800'], summary: 'The account is verified.' },
  ])(
    'rejects classification output outside the account observation contract: %j',
    async (output) => {
      const { models } = setup(() => chat(output), {
        ...settings,
        decision: { ...settings.decision, protocol: 'openai' },
      })
      await expect(
        models.classifyAccount({ identity: { id: '7' }, evidence: {} }),
      ).rejects.toMatchObject({ code: 'MODEL_INVALID_OUTPUT' })
    },
  )

  it('keeps a fully tagged Jev summary within the account observation contract', async () => {
    const { models } = setup(() =>
      accountDecision({
        verified: 0.93,
        established: 0.94,
        needs_attention: 0.96,
      }),
    )
    const result = await models.classifyAccount({ identity: { id: '7' }, evidence: {} })
    expect(result.tags).toHaveLength(3)
    expect(result.summary.length).toBeLessThanOrEqual(160)
  })

  it('sends actual image content to the generation endpoint without enabling experimental Jev images', async () => {
    const { models, requests } = setup(() => chat(review))
    expect(await models.reviewImage({ product, image })).toEqual(review)
    expect(requests[0]?.url).toBe('https://generation.test/v1/chat/completions')
    const body = JSON.parse(String(requests[0]?.init.body))
    expect(body.model).toBe('vision-selected')
    expect(body.messages[1].content).toContainEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${image.data}` },
    })
    expect(body.messages[0].content).toMatch(/not proof/i)
    expect(requests[0]?.init.headers).not.toHaveProperty('TypeSafe-Danger-Zone-Images')
  })

  it.each(['Upload', 'List item', 'Hochladen'])(
    'routes a model click on the final %s control through the journaled submit phase',
    async (name) => {
      const { models } = setup(() => chat({ action: 'click', target: { index: 4 } }))
      const plan = await models.plan({
        goal: 'Prepare the assigned listing',
        product,
        snapshot: {
          ...snapshot,
          controls: [
            ...snapshot.controls,
            { index: 4, role: 'button', name, type: 'button' },
          ],
        },
      })
      expect(plan).toEqual({ action: 'submit', target: { index: 4 } })
    },
  )

  it('routes a final send click in the assigned conversation through the submit phase', async () => {
    const { models } = setup(() => chat({ action: 'click', target: { index: 0 } }))
    expect(
      await models.plan({
        goal: 'Prepare the assigned message',
        message: { conversationId: '123', text: 'Thank you for your interest.' },
        snapshot: {
          ...snapshot,
          url: 'https://www.vinted.fr/inbox/123',
          controls: [{ index: 0, role: 'button', name: 'Send message', type: 'button' }],
        },
      }),
    ).toEqual({ action: 'submit', target: { index: 0 } })
  })

  it('keeps a photo-picker control as preparation rather than a final submit', async () => {
    const { models } = setup(() => chat({ action: 'upload', target: { index: 4 } }))
    expect(
      await models.plan({
        goal: 'Prepare the assigned listing',
        product,
        snapshot: {
          ...snapshot,
          controls: [{ index: 4, role: 'button', name: 'Add photos', type: 'button' }],
        },
      }),
    ).toEqual({ action: 'upload', target: { index: 4 } })
  })

  it('uses Jev typed choices and actual probabilities to review English copy', async () => {
    const { models, requests } = setup(() => decision())
    const result = await models.reviewCopy({
      product,
      title: product.title,
      description: product.description,
    })
    expect(result.decision).toBe('pass')
    expect(result.confidence).toBe(0.86)
    expect(requests[0]?.url).toBe('https://decision.test/v1/systemone')
    const body = JSON.parse(String(requests[0]?.init.body))
    expect(body.questions.review.type).toBe('choice')
    expect(body.questions.english.type).toBe('noul')
    expect(body.questions.supported.type).toBe('noul')
    expect(body).not.toHaveProperty('messages')
  })

  it('does not pass unsupported or non-English copy despite a pass choice', async () => {
    const { models } = setup(() => decision({ english: { type: 'noul', noul: 0.18 } }))
    expect(
      await models.reviewCopy({
        product,
        title: product.title,
        description: product.description,
      }),
    ).toMatchObject({ decision: 'review', confidence: 0.18 })
  })

  it.each([
    { review: { type: 'choice', choice: 'pass', confidence: 0.99 } },
    {
      review: {
        type: 'choice',
        choice: 'pass',
        confidence: 0.99,
        probabilities: { pass: 0.8, skip: 0.8, review: 0.2 },
      },
    },
    {
      review: {
        type: 'choice',
        choice: 'pass',
        confidence: 0.99,
        probabilities: { pass: 0.1, skip: 0.8, review: 0.1 },
      },
    },
  ])(
    'rejects malformed Jev distributions instead of fabricating confidence: %j',
    async (answers) => {
      const { models } = setup(() => decision(answers))
      await expect(
        models.reviewCopy({
          product,
          title: product.title,
          description: product.description,
        }),
      ).rejects.toThrow(/invalid.*output/i)
    },
  )

  it('supports OpenAI decision JSON using the configured decision endpoint', async () => {
    const { models, requests } = setup(() => chat(review), {
      ...settings,
      decision: { ...settings.decision, protocol: 'openai' },
    })
    expect(
      await models.reviewCopy({
        product,
        title: product.title,
        description: product.description,
      }),
    ).toEqual(review)
    expect(requests[0]?.url).toBe('https://decision.test/v1/chat/completions')
  })

  it.each([
    { ...review, confidence: '0.9' },
    { ...review, confidence: 1.2 },
    { ...review, rawJavascript: 'alert(1)' },
    { decision: 'pass', reason: 'Fine.' },
    { ...review, reason: '照片合格' },
  ])('rejects malformed review output: %j', async (output) => {
    const { models } = setup(() => chat(output))
    await expect(models.reviewImage({ product, image })).rejects.toThrow()
  })

  it('rejects invalid image encodings and mismatched MIME bytes before making a request', async () => {
    const { models, requests } = setup(() => chat(review))
    for (const bad of [
      { mime: 'image/png', data: 'not base64' },
      { mime: 'image/jpeg', data: image.data },
      { mime: 'image/png', data: Buffer.from('not an image').toString('base64') },
    ])
      await expect(models.reviewImage({ product, image: bad })).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })

  it('rewrites only through the generation model and leaves retry orchestration to main', async () => {
    const copy = { title: 'Used blue cotton shirt', description: product.description }
    const { models, requests } = setup(() => chat(copy))
    expect(
      await models.rewriteCopy({
        product,
        title: product.title,
        description: product.description,
        reason: 'Use a casual tone.',
      }),
    ).toEqual(copy)
    expect(requests.map((request) => request.url)).toEqual([
      'https://generation.test/v1/chat/completions',
    ])
    const prompt = String(requests[0]?.init.body)
    expect(prompt).toContain('English')
    expect(prompt).toContain('price')
    expect(prompt).toContain('invent')
  })

  it.each([
    { title: '蓝色衬衫', description: 'A used shirt.' },
    { title: 'Blue shirt', description: '这是一件二手衬衫。' },
    {
      title: 'Chemise bleue',
      description: 'Cette chemise est en bon état avec une petite marque.',
    },
    { title: '', description: 'A used shirt.' },
    { title: 'Blue shirt', description: 'A used shirt.', price: 5 },
  ])(
    'rejects non-English or extra generated fields without retrying: %j',
    async (output) => {
      const { models, requests } = setup(() => chat(output))
      await expect(
        models.rewriteCopy({
          product,
          title: product.title,
          description: product.description,
          reason: 'Improve readability.',
        }),
      ).rejects.toThrow()
      expect(requests).toHaveLength(1)
    },
  )

  it('accepts only a bounded action on an observed control using supplied product facts', async () => {
    const { models } = setup(() =>
      chat({ action: 'fill', target: { index: 0 }, value: product.title }),
    )
    expect(await models.plan({ goal: 'Fill the listing.', snapshot, product })).toEqual({
      action: 'fill',
      target: { index: 0 },
      value: product.title,
    })
  })

  it.each([
    { action: 'navigate', url: 'https://evil.test/' },
    { action: 'evaluate', script: 'document.cookie' },
    { action: 'fill', target: { index: 99 }, value: product.title },
    { action: 'fill', target: { css: 'input' }, value: product.title },
    { action: 'fill', target: { index: 2 }, value: '3.00' },
    { action: 'select', target: { index: 3 }, value: 'USD' },
    { action: 'fill', target: { index: 1 }, value: 'Brand new silk shirt, never worn.' },
  ])(
    'rejects invented facts, changed price/currency, and unbounded planner actions: %j',
    async (output) => {
      const { models } = setup(() => chat(output))
      await expect(
        models.plan({ goal: 'Fill the listing.', snapshot, product }),
      ).rejects.toThrow()
    },
  )

  it('uses Jev only for typed account tags and never generates an account rating', async () => {
    const { models, requests } = setup(() => accountDecision({ verified: 0.93 }))
    const result = await models.classifyAccount({
      identity: { id: '7', username: 'fixture' },
      evidence: { email_verified: true, access_token: 'credential-must-not-travel' },
    })
    expect(result.tags).toEqual(['verified'])
    expect(result).not.toHaveProperty('rating')
    expect(String(requests[0]?.init.body)).not.toContain('credential-must-not-travel')
    expect(JSON.parse(String(requests[0]?.init.body)).state.evidence.email_verified).toBe(
      true,
    )
  })

  it('uses typed seller-category judgments and copies an explicit nested observed rating without generating one', async () => {
    const { models, requests } = setup(() =>
      accountDecision({
        clothing_seller: 0.94,
        footwear_seller: 0.9,
      }),
    )
    const result = await models.classifyAccount({
      identity: { id: '7' },
      evidence: {
        account: { officialStatus: 'active' },
        profile: {
          evidenceStatus: 'observed',
          evidence: {
            rating: 4.8,
            items: [{ title: 'Used cotton shirt', category: 'Shirts' }],
          },
        },
      },
    })
    expect(result.tags).toEqual(['clothing_seller', 'footwear_seller'])
    expect(result.rating).toBe(4.8)
    const request = JSON.parse(String(requests[0]?.init.body))
    expect(request.questions.clothing_seller.type).toBe('noul')
    expect(request.questions.footwear_seller.type).toBe('noul')
  })

  it('limits supported Jev tags to the strongest eight and a bounded English summary', async () => {
    const { models } = setup(() =>
      accountDecision({
        verified: 0.91,
        established: 0.92,
        needs_attention: 0.93,
        clothing_seller: 0.94,
        footwear_seller: 0.95,
        accessories_seller: 0.96,
        home_seller: 0.97,
        electronics_seller: 0.98,
        books_media_seller: 0.99,
      }),
    )
    const result = await models.classifyAccount({ identity: { id: '7' }, evidence: {} })
    expect(result.tags).toHaveLength(8)
    expect(result.tags).not.toContain('verified')
    expect(result.tags.every((tag) => tag.length <= 24)).toBe(true)
    expect(result.summary.length).toBeLessThanOrEqual(160)
  })

  it('does not invent a star rating from reputation or from sampled feedback', async () => {
    const { models } = setup(() => accountDecision({ established: 0.9 }))
    const result = await models.classifyAccount({
      identity: { id: '7' },
      evidence: {
        profile: {
          evidence: {
            profile: { feedbackReputation: 0.96 },
            feedback: [{ rating: 5 }],
          },
        },
      },
    })
    expect(result).not.toHaveProperty('rating')
  })

  it('validates an OpenAI rating against the explicit observed source in the workflow evidence wrapper', async () => {
    const output = {
      tags: ['clothing_seller'],
      summary: 'Observed listings include used clothing.',
      rating: 4.8,
    }
    const { models } = setup(() => chat(output), {
      ...settings,
      decision: { ...settings.decision, protocol: 'openai' },
    })
    const evidence = { profile: { evidence: { rating: 4.8 } } }
    expect(await models.classifyAccount({ identity: { id: '7' }, evidence })).toEqual(
      output,
    )
    await expect(
      models.classifyAccount({
        identity: { id: '7' },
        evidence: { profile: { evidence: { rating: 4.7 } } },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_INVALID_OUTPUT' })
  })

  it('does not accept a connectivity test on a malformed model reply', async () => {
    const { models } = setup(() => chat({ ok: 'yes' }))
    await expect(models.test('generation')).rejects.toThrow()
  })

  it('tests the selected Jev model with factual structured judgement', async () => {
    const { models, requests } = setup(() => decision())
    expect(await models.test('decision')).toMatchObject({
      ok: true,
      kind: 'decision',
      model: 'jev-1.14.0',
      checks: { judgement: true },
    })
    const body = JSON.parse(String(requests[0]!.init.body))
    expect(body.questions.review.type).toBe('choice')
    expect(body.state.product.description).toContain('mark')
  })

  it('actually sends a valid image and requires English structured copy in the generation test', async () => {
    const output = {
      title: 'Red square',
      description: 'A red square on a white background.',
    }
    const { models, requests } = setup(() => chat(output))
    expect(await models.test('generation')).toMatchObject({
      ok: true,
      kind: 'generation',
      checks: { vision: true, english: true },
    })
    const body = JSON.parse(String(requests[0]!.init.body))
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: expect.any(String) },
      {
        type: 'image_url',
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/u) },
      },
    ])
    const png = Buffer.from(
      body.messages[1].content[1].image_url.url.split(',')[1],
      'base64',
    )
    let offset = 8
    let pixels: Buffer | undefined
    while (offset < png.length) {
      const size = png.readUInt32BE(offset)
      const chunk = png.subarray(offset + 4, offset + 8 + size)
      expect(png.readUInt32BE(offset + 8 + size)).toBe(crc32(chunk))
      if (chunk.toString('ascii', 0, 4) === 'IDAT')
        pixels = inflateSync(chunk.subarray(4))
      offset += size + 12
    }
    expect(pixels?.byteLength).toBeGreaterThan(100)
    const bad = setup(() =>
      chat({ title: 'Cette chemise', description: 'Cette chemise avec une marque.' }),
    ).models
    await expect(bad.test('generation')).rejects.toMatchObject({
      code: 'MODEL_INVALID_OUTPUT',
    })
    const wrongVisual = setup(() =>
      chat({ title: 'Blue circle', description: 'A blue circle on a white background.' }),
    ).models
    await expect(wrongVisual.test('generation')).rejects.toMatchObject({
      code: 'MODEL_INVALID_OUTPUT',
    })
  })

  it('scrubs keys from transport errors, HTTP failures, and abort reasons', async () => {
    for (const response of [
      () => {
        throw new Error(`${settings.decision.apiKey} ${settings.generation.apiKey}`)
      },
      () => new Response(settings.generation.apiKey, { status: 401 }),
    ]) {
      const { models } = setup(response)
      const error = await models
        .reviewImage({ product, image })
        .catch((value: unknown) => value)
      expect(String(error)).not.toContain(settings.generation.apiKey)
      expect(String(error)).not.toContain(settings.decision.apiKey)
    }
    const controller = new AbortController()
    controller.abort(new Error(settings.generation.apiKey))
    const { models, requests } = setup(() => chat(review))
    await expect(
      models.reviewImage({ product, image, signal: controller.signal }),
    ).rejects.toThrow(/cancel/i)
    expect(requests).toHaveLength(0)
  })

  it('honors cancellation even when the injected fetch ignores its signal', async () => {
    const controller = new AbortController()
    const { models } = setup(() => new Promise<Response>(() => {}))
    const result = models.reviewImage({ product, image, signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toThrow(/cancel/i)
  })

  it('keeps the deadline across a stalled response body and cancels its reader', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const { models } = setup(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"choices":['))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    const result = models.reviewImage({ product, image })
    const assertion = expect(result).rejects.toThrow(/timeout|deadline/i)
    await vi.advanceTimersByTimeAsync(5001)
    await assertion
    expect(cancelled).toBe(true)
  })

  it('bounds streamed bytes even without a content-length header', async () => {
    const { models } = setup(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(256 * 1024 + 1))
              controller.close()
            },
          }),
        ),
    )
    await expect(models.reviewImage({ product, image })).rejects.toThrow(/large|limit/i)
  })
})
