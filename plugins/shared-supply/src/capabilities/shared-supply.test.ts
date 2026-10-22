import { describe, expect, it } from 'vitest'

import { SharedSupply, MAX_FAVORITES } from './shared-supply.js'
import { isPluginFailure } from '../domain/errors.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { Redactor, createLogger } from '../rpc/redact.js'
import type { SharedSupplyClient } from '../services/upstream.js'
import { createMemoryStore } from '../store/private-store.js'

const product = {
  id: 12,
  title: '帆布包',
  description: '大容量',
  price: '39',
  uid: 'M1',
  createdTime: 1_700_000_000,
  pics: { picList: ['https://product.aliyizhan.com/person/p.jpg'] },
}

// 16 bytes so it clears the schema's minimum base64 length, and starts with the JPEG magic.
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
  0x00, 0x01,
]).toString('base64')

function createPlugin(
  overrides: Partial<Record<keyof SharedSupplyClient, unknown>> = {},
) {
  const client = {
    stores: async () => [
      { id: '3', uid: 'M3', nickName: '三号铺', iconUrl: '', floor: '', houseNumber: '' },
    ],
    products: async () => [
      {
        id: '12',
        title: '帆布包',
        description: '大容量',
        price: '39',
        merchantId: 'M1',
        images: ['https://product.aliyizhan.com/person/p.jpg'],
        coverUrl: 'https://product.aliyizhan.com/person/p.jpg',
        publishedAt: '2023-11-14T22:13:20.000Z',
        raw: product,
      },
    ],
    search: async () => [],
    imageSearch: async () => [],
    ...overrides,
  } as unknown as SharedSupplyClient
  const redactor = new Redactor()
  let sequence = 0
  const plugin = new SharedSupply({
    client,
    store: createMemoryStore(),
    logger: createLogger(() => undefined, redactor),
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    idFactory: () => `f-${++sequence}`,
  })
  return { plugin }
}

function context(method: string, payload: unknown = {}): DispatchContext {
  return {
    requestId: 'request-1',
    capability: 'supply.catalog',
    method,
    payload,
    deadlineAt: Date.now() + 5_000,
    assertAlive: () => undefined,
  }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (isPluginFailure(error)) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

describe('SharedSupply', () => {
  it('serves the ten categories it can actually request', async () => {
    const { plugin } = createPlugin()
    const result = (await plugin.call(context('supply.catalog'))) as {
      categories: { id: string; name: string }[]
    }
    expect(result.categories).toHaveLength(10)
    expect(result.categories[0]).toEqual({ id: '1', name: '母婴' })
  })

  it('reports paging using the upstream page size', async () => {
    const { plugin } = createPlugin()
    const result = (await plugin.call(
      context('supply.stores', { typeId: '1', page: 0 }),
    )) as {
      items: unknown[]
      pageSize: number
      hasMore: boolean
    }
    expect(result.pageSize).toBe(80)
    expect(result.hasMore).toBe(false)
    expect(result.items).toHaveLength(1)
  })

  it('rejects a category and a merchant id it cannot send upstream', async () => {
    const { plugin } = createPlugin()
    expect(
      (await failure(plugin.call(context('supply.stores', { typeId: '999', page: 0 }))))
        .code,
    ).toBe('INVALID_REQUEST')
    expect(
      (
        await failure(
          plugin.call(context('supply.products', { merchantId: 'a/b', page: 0 })),
        )
      ).code,
    ).toBe('INVALID_REQUEST')
    expect(
      (await failure(plugin.call(context('supply.search', { keyword: '   ', page: 0 }))))
        .code,
    ).toBe('INVALID_REQUEST')
  })

  it('only accepts JPEG bytes for image search', async () => {
    const { plugin } = createPlugin()
    // A real JPEG magic number is forwarded as-is; the client decides what to send.
    const accepted = (await plugin.call(
      context('supply.imageSearch', { data: jpeg, mime: 'image/jpeg' }),
    )) as { items: unknown[] }
    expect(accepted.items).toEqual([])

    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]).toString('base64')
    const result = await failure(
      plugin.call(context('supply.imageSearch', { data: png, mime: 'image/jpeg' })),
    )
    expect(result.code).toBe('INVALID_REQUEST')
    expect(result.message).toContain('JPEG')
  })

  it('saves a favourite once and refreshes it on a second save', async () => {
    const { plugin } = createPlugin()
    const first = (await plugin.call(context('supply.favorites.add', { product }))) as {
      item: { favoriteId: string; savedAt: string }
      alreadySaved: boolean
      total: number
    }
    expect(first.alreadySaved).toBe(false)
    expect(first.total).toBe(1)

    const second = (await plugin.call(
      context('supply.favorites.add', { product: { ...product, price: '45' } }),
    )) as {
      item: { favoriteId: string; price: string }
      alreadySaved: boolean
      total: number
    }
    expect(second.alreadySaved).toBe(true)
    expect(second.total).toBe(1)
    expect(second.item.favoriteId).toBe(first.item.favoriteId)
    expect(second.item.price).toBe('45')
  })

  it('lists favourites newest first and removes idempotently', async () => {
    const { plugin } = createPlugin()
    await plugin.call(context('supply.favorites.add', { product }))
    await plugin.call(
      context('supply.favorites.add', {
        product: { ...product, id: 13, title: '第二个' },
      }),
    )
    const listed = (await plugin.call(context('supply.favorites.list'))) as {
      items: { title: string }[]
      total: number
    }
    expect(listed.items.map((item) => item.title)).toEqual(['第二个', '帆布包'])

    const first = (await plugin.call(context('supply.favorites.list'))) as {
      items: { favoriteId: string }[]
    }
    const id = first.items[0]?.favoriteId ?? ''
    const removed = (await plugin.call(
      context('supply.favorites.remove', { favoriteId: id }),
    )) as { removed: boolean; total: number }
    expect(removed).toMatchObject({ removed: true, total: 1 })
    const again = (await plugin.call(
      context('supply.favorites.remove', { favoriteId: id }),
    )) as { removed: boolean }
    expect(again.removed).toBe(false)
  })

  it('refuses a product without an id or title', async () => {
    const { plugin } = createPlugin()
    expect(
      (
        await failure(
          plugin.call(context('supply.favorites.add', { product: { title: '无 id' } })),
        )
      ).code,
    ).toBe('INVALID_REQUEST')
    expect(
      (
        await failure(
          plugin.call(context('supply.favorites.add', { product: { id: '1' } })),
        )
      ).code,
    ).toBe('INVALID_REQUEST')
  })

  it(`stops at ${MAX_FAVORITES} favourites instead of growing forever`, async () => {
    const { plugin } = createPlugin()
    for (let index = 0; index < MAX_FAVORITES; index += 1) {
      await plugin.call(
        context('supply.favorites.add', {
          product: { ...product, id: `p-${index}` },
        }),
      )
    }
    const full = await failure(
      plugin.call(
        context('supply.favorites.add', { product: { ...product, id: 'overflow' } }),
      ),
    )
    expect(full.code).toBe('INVALID_REQUEST')
    expect(full.message).toContain(String(MAX_FAVORITES))
  })

  it('exports favourites as CSV with the count', async () => {
    const { plugin } = createPlugin()
    await plugin.call(context('supply.favorites.add', { product }))
    const result = (await plugin.call(context('supply.favorites.csv'))) as {
      text: string
      count: number
    }
    expect(result.count).toBe(1)
    expect(result.text).toContain('帆布包')
  })

  it('turns an upstream failure into the shared error vocabulary', async () => {
    const { plugin } = createPlugin({
      search: async () => {
        const { UpstreamError } = await import('../domain/errors.js')
        throw new UpstreamError('rate-limit')
      },
    })
    const result = await failure(
      plugin.call(context('supply.search', { keyword: '包', page: 0 })),
    )
    expect(result.code).toBe('RATE_LIMITED')
  })

  it('rejects an unknown method', async () => {
    const { plugin } = createPlugin()
    expect((await failure(plugin.call(context('supply.nope')))).code).toBe(
      'INVALID_REQUEST',
    )
  })
})
