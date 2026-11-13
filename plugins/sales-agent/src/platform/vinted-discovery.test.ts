import { describe, expect, it } from 'vitest'
import type { AgentProductSnapshot } from '@nexus/plugin-sdk/agent'
import { VintedTools } from './vinted.js'

const origin = 'https://www.vinted.fr'
const wardrobePath = '/api/v2/wardrobe/7/items?page=1&per_page=12&order=newest_first'
const baseline = {
  url: `${origin}/items/new`,
  listingIds: ['122'],
  observedAt: '2026-11-13T07:59:58.000Z',
  intentStartedAt: '2026-11-13T07:59:59.000Z',
}
const product: AgentProductSnapshot = {
  id: '20000000-0000-4000-8000-000000000001',
  revision: 1,
  name: 'Shirt',
  title: 'Blue shirt',
  description: 'A used blue shirt with a mark on the sleeve.',
  price: 12.5,
  currency: 'EUR',
  category: '',
  condition: 'Good',
  brand: '',
  size: '',
  tags: [],
  images: [],
}
const item = {
  id: 123,
  title: product.title,
  description: product.description,
  user_id: 7,
  price: { amount: '12.50', currency_code: 'EUR' },
  created_at: '2026-11-13T08:00:00Z',
  url: `${origin}/items/123-blue-shirt`,
}

function setup(
  items: unknown[],
  details: Record<string, unknown> = { '123': item },
  url = `${origin}/`,
) {
  const requests: Array<{ operation: string; input: unknown; timeoutMs?: number }> = []
  const tools = new VintedTools(
    async (request) => {
      requests.push(request)
      if (request.operation === 'snapshot')
        return { url, title: '', text: '', controls: [] }
      const { path, method } = request.input as { path: string; method: string }
      if (method !== 'GET') throw new Error('unexpected write')
      const body =
        path === wardrobePath
          ? { items, pagination: { current_page: 1, per_page: 12 } }
          : { item: details[path.replace('/api/v2/items/', '')] }
      return { url: `${origin}${path}`, status: 200, text: JSON.stringify(body) }
    },
    origin,
    '7',
  )
  return { tools, requests }
}

describe('lost-result owned listing discovery', () => {
  it('recovers one exact new owned listing after the result page is lost', async () => {
    const { tools, requests } = setup([
      { id: 123, user_id: 7 },
      { id: 122, user_id: 7 },
    ])
    expect(await tools.confirmListing(product, baseline)).toEqual({
      listingId: '123',
      listingUrl: `${origin}/items/123-blue-shirt`,
      publishedAt: '2026-11-13T08:00:00.000Z',
    })
    expect(requests.map((request) => request.input)).toEqual([
      { maxChars: 20_000 },
      { method: 'GET', path: wardrobePath },
      { method: 'GET', path: '/api/v2/items/123' },
    ])
  })

  it('does not select the first candidate when two exact new listings exist', async () => {
    const { tools } = setup(
      [
        { id: 123, user_id: 7 },
        { id: 124, user_id: 7 },
      ],
      { '123': item, '124': { ...item, id: 124, url: `${origin}/items/124` } },
    )
    await expect(tools.confirmListing(product, baseline)).rejects.toMatchObject({
      code: 'RESULT_UNKNOWN',
    })
  })

  it('does not treat an unreadable second candidate as evidence of uniqueness', async () => {
    const { tools } = setup(
      [
        { id: 123, user_id: 7 },
        { id: 124, user_id: 7 },
      ],
      {
        '123': item,
        '124': { ...item, id: 124, description: undefined, url: `${origin}/items/124` },
      },
    )
    await expect(tools.confirmListing(product, baseline)).rejects.toMatchObject({
      code: 'RESULT_UNKNOWN',
    })
  })

  it('requires exact description and price even when the result page survived', async () => {
    for (const detail of [
      { ...item, description: 'A blue shirt.' },
      { ...item, price: undefined },
    ]) {
      const { tools } = setup([], { '123': detail }, `${origin}/items/123`)
      await expect(tools.confirmListing(product, baseline)).rejects.toMatchObject({
        code: 'RESULT_UNKNOWN',
      })
    }
  })

  it.each([
    { ...item, user_id: 8 },
    { ...item, user_id: undefined },
    { ...item, user: { id: 8 } },
    { ...item, description: 'A used blue shirt.' },
    { ...item, description: undefined },
    { ...item, title: 'Red shirt' },
    { ...item, price: undefined },
    { ...item, price: { amount: '12.50', currency_code: 'GBP' } },
    { ...item, created_at: '2026-11-13T07:59:58Z' },
    { ...item, created_at: '2026-11-13T08:10:00Z' },
    { ...item, created_at: undefined },
    { ...item, url: 'https://other.test/items/123' },
  ])('leaves uncertain identity, time, or exact content unknown: %j', async (detail) => {
    const { tools } = setup([{ id: 123, user_id: 7 }], { '123': detail })
    await expect(tools.confirmListing(product, baseline)).rejects.toMatchObject({
      code: 'RESULT_UNKNOWN',
    })
  })

  it('checks all bounded candidates, excluding old and unrelated listings', async () => {
    const { tools, requests } = setup(
      [
        { id: 122, user_id: 7 },
        { id: 124, user_id: 7 },
        { id: 123, user_id: 7 },
      ],
      {
        '123': item,
        '124': { ...item, id: 124, title: 'Other item', url: `${origin}/items/124` },
      },
    )
    expect(await tools.confirmListing(product, baseline)).toMatchObject({
      listingId: '123',
    })
    expect(requests).toHaveLength(4)
    expect(
      requests.some((request) => JSON.stringify(request.input).includes('/items/122')),
    ).toBe(false)
  })

  it.each(
    [
      [],
      [{ id: 122, user_id: 7 }],
      [{ id: 123, user_id: 8 }],
      [
        { id: 123, user_id: 7 },
        { id: 123, user_id: 7 },
      ],
      Array.from({ length: 13 }, (_, i) => ({ id: i + 123, user_id: 7 })),
    ].map((items) => ({ items })),
  )(
    'fails closed for absent or invalid bounded candidate evidence: %j',
    async ({ items }) => {
      const { tools, requests } = setup(items)
      await expect(tools.confirmListing(product, baseline)).rejects.toMatchObject({
        code: 'RESULT_UNKNOWN',
      })
      expect(requests.length).toBeLessThanOrEqual(2)
    },
  )

  it('keeps twelve candidate detail reads within one RPC deadline', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 123, user_id: 7 }))
    const details = Object.fromEntries(
      items.map(({ id }) => [
        String(id),
        {
          ...item,
          id,
          title: id === 123 ? product.title : 'Other item',
          created_at: id === 134 ? '2026-11-13T07:59:58Z' : item.created_at,
          url: `${origin}/items/${id}`,
        },
      ]),
    )
    const { tools, requests } = setup(items, details)
    expect(await tools.confirmListing(product, baseline)).toMatchObject({
      listingId: '123',
    })
    expect(requests).toHaveLength(14)
    expect(
      requests.reduce((sum, request) => sum + (request.timeoutMs ?? 0), 0),
    ).toBeLessThan(120_000)
  })

  it('does not claim uniqueness beyond a full recent page without a pre-intent boundary', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 123, user_id: 7 }))
    const details = Object.fromEntries(
      items.map(({ id }) => [
        String(id),
        {
          ...item,
          id,
          title: id === 123 ? product.title : 'Other item',
          url: `${origin}/items/${id}`,
        },
      ]),
    )
    const { tools, requests } = setup(items, details)
    await expect(tools.confirmListing(product, baseline)).rejects.toMatchObject({
      code: 'RESULT_UNKNOWN',
    })
    expect(requests.length).toBeLessThanOrEqual(14)
  })
})
