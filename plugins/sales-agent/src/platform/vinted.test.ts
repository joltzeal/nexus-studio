import { describe, expect, it } from 'vitest'
import type { AgentProductSnapshot } from '@nexus/plugin-sdk/agent'
import { VintedTools, type ListingConfirmationContext } from './vinted.js'

const origin = 'https://www.vinted.fr'
const listingContext = {
  url: `${origin}/items/new`,
  listingIds: ['122'],
  observedAt: '2026-11-13T07:59:58.000Z',
  intentStartedAt: '2026-11-13T07:59:59.000Z',
}
const messageContext = {
  conversationId: '123',
  messageIds: ['90'],
  observedAt: '2026-11-13T07:59:58.000Z',
  intentStartedAt: '2026-11-13T07:59:59.000Z',
}
const product: AgentProductSnapshot = {
  id: '20000000-0000-4000-8000-000000000001',
  revision: 1,
  name: 'Blue shirt',
  title: 'Blue cotton shirt',
  description: 'A used blue cotton shirt.',
  price: 12.5,
  currency: 'EUR',
  condition: 'Good',
  category: '',
  brand: '',
  size: '',
  tags: [],
  images: [
    {
      id: '20000000-0000-4000-8000-000000000002',
      artifactId: '20000000-0000-4000-8000-000000000003',
      name: 'shirt.png',
      mime: 'image/png',
      bytes: 68,
      sha256: 'b'.repeat(64),
    },
  ],
}
const page = {
  url: `${origin}/items/new`,
  title: 'Sell an item',
  text: 'Sell your item',
  controls: [
    { index: 0, role: 'textbox', name: 'Title', value: product.title },
    { index: 1, role: 'textbox', name: 'Description', value: product.description },
    { index: 2, role: 'textbox', name: 'Price (EUR)', value: '12.50' },
  ],
}
type Request = { operation: string; origin: string; input: unknown; timeoutMs?: number }

function json(path: string, body: unknown, status = 200) {
  return { url: `${origin}${path}`, status, text: JSON.stringify(body) }
}

function setup(handle: (request: Request) => unknown | Promise<unknown>) {
  const requests: Request[] = []
  const tools = new VintedTools(
    async (request) => {
      requests.push(request)
      return handle(request)
    },
    origin,
    '7',
  )
  return { tools, requests }
}

function current(
  user: unknown = { id: 7, login: 'fixture', status: 'active' },
  status = 200,
) {
  return json('/api/v2/users/current', { user, code: status === 200 ? 0 : 100 }, status)
}

describe('Vinted account identity and evidence', () => {
  it('uses the authenticated current-user response and exposes bounded credential-free evidence', async () => {
    const { tools, requests } = setup(() =>
      current({
        id: 7,
        login: 'fixture',
        status: 'active',
        access_token: 'do-not-emit',
        email: 'private@example.test',
        password: 'do-not-emit-either',
      }),
    )
    const account = await tools.inspectAccount()
    expect(account).toMatchObject({
      identity: { id: '7', username: 'fixture' },
      status: 'active',
      source: 'official',
    })
    expect(JSON.stringify(account)).not.toContain('do-not-emit')
    expect(JSON.stringify(account)).not.toContain('private@example.test')
    expect(account).not.toHaveProperty('balance')
    expect(requests[0]).toEqual({
      operation: 'request',
      origin,
      input: { method: 'GET', path: '/api/v2/users/current' },
      timeoutMs: 30_000,
    })
    expect(
      requests.every((request) => ['request', 'snapshot'].includes(request.operation)),
    ).toBe(true)
  })

  it.each([{ id: 7 }, { login: 'fixture' }, { id: 8, login: 'other' }, null])(
    'requires an unambiguous matching authenticated identity: %j',
    async (user) => {
      const { tools, requests } = setup((request) =>
        request.operation === 'snapshot' ? page : current(user),
      )
      await expect(tools.inspectAccount()).rejects.toThrow(/review_required|identity/i)
      expect(
        requests.every((request) => ['request', 'snapshot'].includes(request.operation)),
      ).toBe(true)
    },
  )

  it('does not equate a Vinted hostname, public profile, or generic 403 with a blocked account', async () => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? { ...page, url: `${origin}/member/7-fixture`, text: '403 Forbidden. fixture' }
        : current(null, 403),
    )
    await expect(tools.inspectAccount()).rejects.toThrow(/review_required/i)
  })

  it('keeps a verified account status unknown when the page only reports forbidden', async () => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? { ...page, text: '403 Forbidden' }
        : current({ id: 7, login: 'fixture' }),
    )
    expect(await tools.inspectAccount()).toMatchObject({
      status: 'unknown',
      source: 'page',
    })
  })

  it('trusts an explicit official blocked status over optimistic page text', async () => {
    const { tools } = setup(() => current({ id: 7, login: 'fixture', status: 'blocked' }))
    expect(await tools.inspectAccount()).toMatchObject({
      status: 'blocked',
      source: 'official',
    })
  })

  it('rejects a current-user response redirected to a different endpoint or origin', async () => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? page
        : {
            ...current(),
            url: `${origin}/api/v2/users/7`,
          },
    )
    await expect(tools.inspectAccount()).rejects.toThrow(/review_required|identity/i)
  })
  it('does not use an authentication page as proof that an account is blocked', async () => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? { ...page, url: `${origin}/login`, text: 'Your account is blocked' }
        : current({ id: 7, login: 'fixture' }),
    )
    expect(await tools.inspectAccount()).toMatchObject({ status: 'unknown' })
  })

  it('keeps explicit page balance evidence separate and preserves decimal precision', async () => {
    const { tools, requests } = setup((request) =>
      request.operation === 'request'
        ? current()
        : {
            ...page,
            title: 'Vinted Balance',
            url: `${origin}/observed-wallet-page`,
            controls: [
              { index: 0, role: 'textbox', name: 'Currency', value: 'EUR' },
              { index: 1, role: 'textbox', name: 'Available balance', value: '-12.3456' },
              { index: 2, role: 'textbox', name: 'Pending balance', value: '' },
            ],
          },
    )
    expect(await tools.readBalance()).toMatchObject({
      balanceStatus: 'observed',
      balanceSource: 'page',
      balance: { currency: 'EUR', available: '-12.3456', pending: null },
    })
    expect(
      requests
        .filter((request) => request.operation === 'request')
        .map((request) => request.input),
    ).toEqual([{ method: 'GET', path: '/api/v2/users/current' }])
  })
})

describe('bounded Vinted browser tools', () => {
  it('navigates only to the fixed listing or specified conversation path', async () => {
    const { tools, requests } = setup((request) => ({
      url: (request.input as { url: string }).url,
    }))
    await tools.openListing()
    await tools.openConversation('123')
    expect(requests.map((request) => request.input)).toEqual([
      { url: `${origin}/items/new` },
      { url: `${origin}/inbox/123` },
    ])
    await expect(tools.openConversation('../settings')).rejects.toThrow()
    expect(requests).toHaveLength(2)
  })

  it('passes artifact references to the host without filesystem paths', async () => {
    const { tools, requests } = setup(() => ({ completed: true }))
    await tools.executePlan({ action: 'upload', target: { index: 4 } }, product)
    expect(requests[0]?.input).toEqual({
      target: { index: 4 },
      artifactIds: ['20000000-0000-4000-8000-000000000003'],
    })
    expect(JSON.stringify(requests)).not.toContain('files')
  })

  it('dispatches one explicit submit and propagates an unknown outcome without resubmitting', async () => {
    const { tools, requests } = setup((request) => {
      if (request.operation === 'snapshot') {
        return { ...page, controls: [{ index: 4, role: 'button', name: 'Upload' }] }
      }
      throw new Error('AUTOMATION_TIMEOUT credential=do-not-echo')
    })
    await expect(
      tools.executePlan(
        { action: 'submit', target: { role: 'button', name: 'Upload' } },
        product,
        '20000000-0000-4000-8000-000000000010',
      ),
    ).rejects.toThrow(/result_unknown/i)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.operation).toBe('submit')
    expect(requests[1]?.input).toEqual({
      target: { role: 'button', name: 'Upload' },
      operationId: '20000000-0000-4000-8000-000000000010',
    })
  })

  it('requires a persisted operation ID before invoking submit', async () => {
    const { tools, requests } = setup(() => ({ completed: true }))
    await expect(
      tools.executePlan({ action: 'submit', target: { index: 4 } }, product),
    ).rejects.toThrow(/operation|intent/i)
    expect(requests).toHaveLength(0)
  })

  it('reads form fields from observed controls instead of inventing selectors', async () => {
    const { tools, requests } = setup((request) =>
      request.operation === 'snapshot'
        ? page
        : { title: product.title, description: product.description, price: '12.50' },
    )
    expect(await tools.readListingForm()).toEqual({
      title: product.title,
      description: product.description,
      price: '12.50',
      currency: 'EUR',
    })
    expect(requests[1]?.input).toEqual({
      fields: { title: { index: 0 }, description: { index: 1 }, price: { index: 2 } },
    })
  })

  it.each([4096, 6000])(
    'reads an entire %i-character listing description',
    async (length) => {
      const description = 'A'.repeat(length)
      const { tools } = setup((request) =>
        request.operation === 'snapshot'
          ? page
          : { title: product.title, description, price: '12.50' },
      )
      const form = await tools.readListingForm()
      expect(form.description).toBe(description)
      expect(form.description).toHaveLength(length)
    },
  )

  it('requires review when the complete listing description exceeds the product limit', async () => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? page
        : { title: product.title, description: 'A'.repeat(6001), price: '12.50' },
    )
    await expect(tools.readListingForm()).rejects.toMatchObject({
      code: 'REVIEW_REQUIRED',
    })
  })

  it('rejects ambiguous form labels and oversized browser evidence', async () => {
    const { tools, requests } = setup(() => ({
      ...page,
      controls: [...page.controls, { index: 3, role: 'textbox', name: 'Title' }],
    }))
    await expect(tools.readListingForm()).rejects.toThrow(/review_required/i)
    expect(requests).toHaveLength(1)
    const oversized = setup(() => ({ ...page, text: 'x'.repeat(100_001) })).tools
    await expect(oversized.snapshot()).rejects.toThrow(/limit|large|review_required/i)
  })

  it('scrubs password and token controls from page snapshots', async () => {
    const { tools } = setup(() => ({
      ...page,
      controls: [
        {
          index: 0,
          role: 'textbox',
          name: 'Password',
          type: 'password',
          value: 'do-not-echo',
        },
      ],
      text: 'access_token=do-not-echo',
    }))
    expect(JSON.stringify(await tools.snapshot())).not.toContain('do-not-echo')
  })
  it('validates the raw page origin before removing credentials from evidence', async () => {
    const { tools } = setup(() => ({
      ...page,
      url: 'https://login:secret@www.vinted.fr/items/new',
    }))
    await expect(tools.snapshot()).rejects.toThrow(/review_required/i)
  })

  it('does not silently discard result-bearing page query parameters', async () => {
    const { tools } = setup(() => ({
      ...page,
      url: `${origin}/items/123?success=true&access_token=secret`,
    }))
    await expect(tools.snapshot()).rejects.toThrow(/review_required/i)
  })
})

describe('Vinted publication confirmation', () => {
  const item = {
    id: 123,
    title: product.title,
    description: product.description,
    user: { id: 7 },
    price: { amount: '12.50', currency_code: 'EUR' },
    created_at: '2026-11-13T08:00:00Z',
    url: `${origin}/items/123-blue-cotton-shirt`,
  }

  it('requires an actual listing route and an owned listing-detail readback', async () => {
    const { tools, requests } = setup((request) =>
      request.operation === 'snapshot'
        ? { ...page, url: `${origin}/items/123-blue-cotton-shirt` }
        : json('/api/v2/items/123', { item }),
    )
    expect(await tools.confirmListing(product, listingContext)).toEqual({
      listingId: '123',
      listingUrl: `${origin}/items/123-blue-cotton-shirt`,
      publishedAt: '2026-11-13T08:00:00.000Z',
    })
    expect(requests[1]?.input).toEqual({ method: 'GET', path: '/api/v2/items/123' })
  })

  it.each([
    `${origin}/items/new?success=true&id=123`,
    `${origin}/items/123/edit`,
    'https://evil.test/items/123',
  ])('does not accept a fake success URL: %s', async (url) => {
    const { tools } = setup(() => ({ ...page, url }))
    await expect(tools.confirmListing(product, listingContext)).rejects.toThrow(
      /result_unknown/i,
    )
  })

  it.each([
    { ...item, user: { id: 8 } },
    { ...item, user: undefined },
    { ...item, title: 'Another item' },
    { ...item, id: 124 },
    { ...item, user_id: 8 },
    { ...item, url: 'https://evil.test/items/123' },
    { ...item, created_at: undefined },
    { ...item, price: { amount: '9.99', currency_code: 'EUR' } },
    { ...item, price: { amount: '12.50', currency_code: 'GBP' } },
  ])('rejects mismatched or uncertain owned listing evidence: %j', async (detail) => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? { ...page, url: `${origin}/items/123` }
        : json('/api/v2/items/123', { item: detail }),
    )
    await expect(tools.confirmListing(product, listingContext)).rejects.toThrow(
      /result_unknown/i,
    )
  })

  it.each([
    undefined,
    {
      url: listingContext.url,
      observedAt: listingContext.observedAt,
      intentStartedAt: listingContext.intentStartedAt,
    },
    { ...listingContext, listingIds: ['122', '122'] },
    { ...listingContext, listingIds: ['0'] },
    {
      ...listingContext,
      listingIds: Array.from({ length: 201 }, (_, index) => String(index + 1)),
    },
    { ...listingContext, url: `${origin}/items/123` },
    { ...listingContext, intentStartedAt: '2026-11-13T08:00:01Z' },
    { ...listingContext, observedAt: '2026-11-13T08:00:01Z' },
  ])(
    'requires a new listing after the form baseline and intent: %j',
    async (baseline) => {
      const { tools } = setup((request) =>
        request.operation === 'snapshot'
          ? { ...page, url: `${origin}/items/123` }
          : json('/api/v2/items/123', { item }),
      )
      await expect(
        tools.confirmListing(product, baseline as ListingConfirmationContext | undefined),
      ).rejects.toThrow(/result_unknown/i)
    },
  )

  it('captures recent owned listing IDs while the new-item form stays open', async () => {
    const path = '/api/v2/wardrobe/7/items?page=1&per_page=12&order=newest_first'
    const { tools, requests } = setup((request) =>
      request.operation === 'snapshot'
        ? page
        : json(path, {
            items: [
              { id: 122, user_id: 7 },
              { id: 121, user: { id: 7 } },
            ],
            pagination: { current_page: 1, per_page: 12 },
          }),
    )
    expect(await tools.readListingBaseline()).toMatchObject({
      url: `${origin}/items/new`,
      listingIds: ['122', '121'],
    })
    expect(requests.map((request) => request.operation)).toEqual(['snapshot', 'request'])
    expect(requests[1]?.input).toEqual({ method: 'GET', path })
  })

  it.each([
    {},
    { items: [{ id: 122 }] },
    { items: [{ id: 122, user_id: 8 }] },
    {
      items: [
        { id: 122, user_id: 7 },
        { id: '122', user_id: 7 },
      ],
    },
    { items: [{ id: 'invalid', user_id: 7 }] },
    { items: Array.from({ length: 13 }, (_, index) => ({ id: index + 1, user_id: 7 })) },
    { items: [], pagination: { current_page: 1, per_page: 96 } },
  ])('requires a bounded and unambiguous owned-listing baseline: %j', async (body) => {
    const { tools, requests } = setup((request) =>
      request.operation === 'snapshot'
        ? page
        : json('/api/v2/wardrobe/7/items?page=1&per_page=12&order=newest_first', body),
    )
    await expect(tools.readListingBaseline()).rejects.toMatchObject({
      code: 'REVIEW_REQUIRED',
    })
    expect(
      requests.every((request) => ['snapshot', 'request'].includes(request.operation)),
    ).toBe(true)
  })

  it('requires review when the wardrobe request cannot establish the listing baseline', async () => {
    const { tools } = setup((request) => {
      if (request.operation === 'snapshot') return page
      throw new Error('403 secret=do-not-echo')
    })
    await expect(tools.readListingBaseline()).rejects.toMatchObject({
      code: 'REVIEW_REQUIRED',
    })
  })

  it('captures an observed empty wardrobe without inventing prior IDs', async () => {
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? page
        : json('/api/v2/wardrobe/7/items?page=1&per_page=12&order=newest_first', {
            items: [],
          }),
    )
    expect((await tools.readListingBaseline()).listingIds).toEqual([])
  })

  it('captures twelve recent IDs from full item objects within the existing wire budget', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => String(120 - index))
    const body = {
      items: ids.map((id) => ({
        id,
        user_id: 7,
        title: product.title,
        photo: { url: 'https://images.example.test/item', metadata: 'x'.repeat(4000) },
      })),
      pagination: { current_page: 1, per_page: 12, total_entries: 1000 },
    }
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(65_536)
    const { tools } = setup((request) =>
      request.operation === 'snapshot'
        ? page
        : json('/api/v2/wardrobe/7/items?page=1&per_page=12&order=newest_first', body),
    )
    expect((await tools.readListingBaseline()).listingIds).toEqual(ids)
  })

  it.each([
    {
      timestamp: Date.parse('2026-11-13T08:00:00Z') / 1000,
      publishedAt: '2026-11-13T08:00:00.000Z',
    },
    { timestamp: '2026-11-13T08:00:00Z', publishedAt: '2026-11-13T08:00:00.000Z' },
    { timestamp: '2026-11-13T09:00:00+01:00', publishedAt: '2026-11-13T08:00:00.000Z' },
    { timestamp: '2026-11-13T08:00:00.9Z', publishedAt: '2026-11-13T08:00:00.900Z' },
    { timestamp: '2026-11-13T08:00:00.98Z', publishedAt: '2026-11-13T08:00:00.980Z' },
    {
      timestamp: Date.parse('2026-11-13T08:00:00.900Z') / 1000,
      publishedAt: '2026-11-13T08:00:00.900Z',
    },
  ])(
    'confirms a new listing in the same observed timestamp interval: $timestamp',
    async ({ timestamp, publishedAt }) => {
      const { tools } = setup((request) =>
        request.operation === 'snapshot'
          ? { ...page, url: `${origin}/items/123` }
          : json('/api/v2/items/123', { item: { ...item, created_at: timestamp } }),
      )
      const context = { ...listingContext, intentStartedAt: '2026-11-13T08:00:00.987Z' }
      expect(await tools.confirmListing(product, context)).toMatchObject({
        listingId: '123',
        publishedAt,
      })
      await expect(
        tools.confirmListing(product, { ...context, listingIds: ['123'] }),
      ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
    },
  )

  it.each([
    Date.parse('2026-11-13T07:59:59Z') / 1000,
    '2026-11-13T07:59:59Z',
    '2026-11-13T08:00:00.900Z',
    Date.parse('2026-11-13T08:00:00.900Z'),
  ])(
    'rejects a listing timestamp earlier at its explicit precision: %j',
    async (timestamp) => {
      const { tools } = setup((request) =>
        request.operation === 'snapshot'
          ? { ...page, url: `${origin}/items/123` }
          : json('/api/v2/items/123', { item: { ...item, created_at: timestamp } }),
      )
      await expect(
        tools.confirmListing(product, {
          ...listingContext,
          intentStartedAt: '2026-11-13T08:00:00.987Z',
        }),
      ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
    },
  )
})

describe('Vinted exact sent-message confirmation', () => {
  const text = 'Thank you for your message.'
  const message = { id: 91, author_id: 7, body: text, created_at: '2026-11-13T08:00:00Z' }

  it('matches a real own-author message in the requested conversation', async () => {
    const { tools } = setup(() =>
      json('/api/v2/conversations/123', {
        conversation: { id: 123, messages: [message] },
      }),
    )
    expect(await tools.confirmMessage('123', text, messageContext)).toMatchObject({
      messageId: '91',
    })
  })

  it.each([
    { conversation: { id: 123, messages: [{ ...message, author_id: 8 }] } },
    { conversation: { id: 124, messages: [message] } },
    { conversation: { id: 123, messages: [{ ...message, body: `Quote: ${text}` }] } },
    { conversation: { id: 123, messages: [{ ...message, author_id: undefined }] } },
    { conversation: { id: 123 }, text },
    { conversation: { id: 123, messages: [message, { ...message, id: 92 }] } },
  ])(
    'does not treat page text or another author as a confirmed send: %j',
    async (response) => {
      const { tools, requests } = setup(() => json('/api/v2/conversations/123', response))
      await expect(tools.confirmMessage('123', text, messageContext)).rejects.toThrow(
        /result_unknown/i,
      )
      expect(requests.every((request) => request.operation === 'request')).toBe(true)
    },
  )

  it.each([
    undefined,
    { ...messageContext, messageIds: ['91'] },
    { ...messageContext, intentStartedAt: '2026-11-13T08:00:01Z' },
    { ...messageContext, observedAt: '2026-11-13T08:00:01Z' },
  ])(
    'does not mistake an old identical own message for a new send: %j',
    async (baseline) => {
      const { tools } = setup(() =>
        json('/api/v2/conversations/123', {
          conversation: { id: 123, messages: [message] },
        }),
      )
      await expect(tools.confirmMessage('123', text, baseline)).rejects.toThrow(
        /result_unknown/i,
      )
    },
  )

  it('captures prior message IDs without returning message text or credentials', async () => {
    const { tools } = setup(() =>
      json('/api/v2/conversations/123', {
        conversation: {
          id: 123,
          messages: [{ ...message, access_token: 'do-not-echo' }],
        },
      }),
    )
    const baseline = await tools.readMessageBaseline('123')
    expect(baseline.messageIds).toEqual(['91'])
    expect(JSON.stringify(baseline)).not.toContain(text)
    expect(JSON.stringify(baseline)).not.toContain('do-not-echo')
  })

  it.each([
    Date.parse('2026-11-13T08:00:00Z') / 1000,
    '2026-11-13T08:00:00Z',
    '2026-11-13T08:00:00.9Z',
    '2026-11-13T08:00:00.98Z',
    Date.parse('2026-11-13T08:00:00.900Z') / 1000,
  ])(
    'confirms only a new own message within the API timestamp precision: %j',
    async (timestamp) => {
      const { tools } = setup(() =>
        json('/api/v2/conversations/123', {
          conversation: { id: 123, messages: [{ ...message, created_at: timestamp }] },
        }),
      )
      const context = { ...messageContext, intentStartedAt: '2026-11-13T08:00:00.987Z' }
      expect(await tools.confirmMessage('123', text, context)).toMatchObject({
        messageId: '91',
      })
      await expect(
        tools.confirmMessage('123', text, { ...context, messageIds: ['91'] }),
      ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
    },
  )

  it.each([
    Date.parse('2026-11-13T07:59:59Z') / 1000,
    '2026-11-13T07:59:59Z',
    '2026-11-13T08:00:00.900Z',
    Date.parse('2026-11-13T08:00:00.900Z'),
  ])(
    'rejects an older message at the timestamp precision actually observed: %j',
    async (timestamp) => {
      const { tools } = setup(() =>
        json('/api/v2/conversations/123', {
          conversation: { id: 123, messages: [{ ...message, created_at: timestamp }] },
        }),
      )
      await expect(
        tools.confirmMessage('123', text, {
          ...messageContext,
          intentStartedAt: '2026-11-13T08:00:00.987Z',
        }),
      ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
    },
  )
})
