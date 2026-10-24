import { describe, expect, it } from 'vitest'

import type {
  ItemRecord,
  ItemSummary,
  MonitorRecord,
  RunRecord,
} from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { VintedClient } from '../services/vinted.js'
import { createMemoryStore } from '../store/private-store.js'
import { VintedMonitor } from './vinted-monitor.js'

const body = {
  name: 'Search',
  searchUrl: 'https://www.vinted.fr/catalog?search_text=coat',
  intervalMinutes: 10,
  maxPages: 2,
  perPage: 2,
  enabled: true,
}

export function ctx(method: string, payload: unknown): DispatchContext {
  return {
    requestId: method,
    capability: 'monitor.collector',
    method,
    payload,
    deadlineAt: Date.now() + 60_000,
    assertAlive: () => undefined,
  }
}

function listing(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Coat ${id}`,
    price: { amount: '12', currency_code: 'EUR' },
    user: { id: 42, login: 'alice' },
    favourite_count: id,
    photos: [
      { url: 'https://images1.vinted.net/a.jpg' },
      { url: 'https://images1.vinted.net/b.jpg' },
    ],
    ...extra,
  }
}

function setup(
  options: {
    failFinish?: boolean
    beforeRequest?: (url: string, init?: RequestInit) => Promise<void>
  } = {},
) {
  const store = createMemoryStore()
  let clock = new Date('2026-10-25T00:00:00.000Z')
  let ids = 0
  let rows = [listing(1), listing(2)]
  let failUser = false
  let truncated = false
  let failPage = false
  let userRequests = 0
  const client = new VintedClient({
    fetchImpl: (async (url: string, init?: RequestInit) => {
      await options.beforeRequest?.(url, init)
      if (url.includes('/users/')) {
        userRequests += 1
        return failUser
          ? new Response('', { status: 429 })
          : Response.json({
              user: {
                id: 42,
                login: 'alice',
                real_name: 'Alice',
                feedback_count: 10,
                verification: {
                  email: { valid: true, available: false, verified_at: 1700000000 },
                },
              },
            })
      }
      const page = Number(new URL(url).searchParams.get('page'))
      if (failPage && page === 2) return new Response('', { status: 503 })
      return Response.json({
        items: page === 1 ? rows : truncated ? [listing(100 + page)] : [],
        pagination: { current_page: page, total_pages: truncated || failPage ? 3 : 1 },
      })
    }) as typeof fetch,
  })
  let failFinish = options.failFinish ?? false
  const backing = {
    kind: store.kind,
    durable: store.durable,
    read: () => store.read(),
    mutate: <T>(apply: Parameters<typeof store.mutate<T>>[0]) =>
      store.mutate(async (doc) => {
        const result = await apply(doc)
        if (failFinish && doc.runs.some((r) => r.status === 'success')) {
          failFinish = false
          throw new Error('disk error with secret proxy:password')
        }
        return result
      }),
  }
  const plugin = new VintedMonitor({
    store: backing,
    client,
    now: () => clock,
    idFactory: () => `id-${++ids}`,
    pause: async () => undefined,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  const call = <T = Record<string, unknown>>(method: string, payload: unknown = {}) =>
    plugin.call(ctx(`vinted.${method}`, payload)) as Promise<T>
  const save = async (extra = {}) =>
    (await call<{ item: MonitorRecord }>('monitors.save', { ...body, ...extra })).item
  const run = async (monitor: MonitorRecord) => {
    clock = new Date(clock.getTime() + 60_000)
    const { run } = await call<{ run: RunRecord }>('monitors.run', {
      monitorId: monitor.id,
    })
    for (let i = 0; i < 500; i++) {
      const { item } = await call<{ item: RunRecord }>('runs.get', { runId: run.id })
      if (item.status !== 'running') {
        await new Promise((resolve) => setTimeout(resolve, 0))
        return item
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('run did not settle')
  }
  const list = (extra = {}) =>
    call<{ items: ItemSummary[]; total: number; totalPages: number }>('items.list', {
      page: 0,
      pageSize: 100,
      ...extra,
    })
  return {
    store,
    plugin,
    call,
    save,
    run,
    list,
    setRows(value: typeof rows) {
      rows = value
    },
    setFailUser(value: boolean) {
      failUser = value
    },
    setTruncated(value: boolean) {
      truncated = value
    },
    setFailPage(value: boolean) {
      failPage = value
    },
    get userRequests() {
      return userRequests
    },
  }
}

describe('reference item semantics', () => {
  it('lists compact summaries while get, star and availability retain complete item and seller snapshots', async () => {
    const f = setup()
    const rawOnlyItem = `item-raw-only:${'x'.repeat(16_384)}`
    const rawOnlySeller = `seller-raw-only:${'y'.repeat(16_384)}`
    const monitor = await f.save({ perPage: 96 })
    f.setRows(
      Array.from({ length: 96 }, (_, index) => listing(index + 1, { rawOnlyItem })),
    )
    await f.run(monitor)
    f.setRows(
      Array.from({ length: 4 }, (_, index) => listing(index + 97, { rawOnlyItem })),
    )
    await f.run(monitor)
    await f.store.mutate((doc) => {
      const seller = doc.sellers[0]
      if (!seller?.detail) throw new Error('Missing archived seller')
      seller.detail.rawOnlySeller = rawOnlySeller
    })

    const page = await f.list({ pageSize: 100 })
    expect(page.total).toBe(100)
    expect(page.items).toHaveLength(100)
    for (const item of page.items) {
      expect(Object.keys(item)).not.toContain('detail')
      expect(Object.keys(item)).not.toContain('images')
      expect(item.sellerProfile).toMatchObject({ login: 'alice', name: 'Alice' })
      expect(Object.keys(item.sellerProfile ?? {})).not.toContain('detail')
    }
    const serialized = JSON.stringify(page)
    expect(serialized).not.toContain('raw-only:')
    expect(Buffer.byteLength(serialized)).toBeLessThan(1024 * 1024)

    for (const [method, input, fields] of [
      ['items.get', {}, {}],
      ['items.star', { starred: true }, { starred: true }],
      [
        'items.availability',
        { status: 'available', note: 'Checked' },
        { availabilityStatus: 'available' },
      ],
    ] as const) {
      const { item } = await f.call<{ item: ItemRecord }>(method, {
        itemId: 'vinted.fr:1',
        ...input,
      })
      expect(item).toMatchObject({
        ...fields,
        detail: { id: 1, rawOnlyItem },
        images: ['https://images1.vinted.net/a.jpg', 'https://images1.vinted.net/b.jpg'],
        sellerProfile: { detail: { id: 42, rawOnlySeller } },
      })
    }
  })

  it('preserves an explicit proxy on legacy edits and switches to inheritance only for explicit null', async () => {
    const f = setup()
    const { item: proxy } = await f.call<{ item: { id: string } }>('proxies.save', {
      name: 'Private',
      scheme: 'http',
      host: 'localhost',
      port: 3128,
      username: '',
      enabled: true,
    })
    const monitor = await f.save({ proxyId: proxy.id })
    const edited = await f.save({ id: monitor.id, name: 'Legacy edit' })
    expect(edited).toMatchObject({ name: 'Legacy edit', proxyId: proxy.id })
    expect(
      (await f.store.read()).monitors.find((m) => m.id === monitor.id)?.proxyId,
    ).toBe(proxy.id)

    const inherited = await f.save({ id: monitor.id, proxyId: null })
    expect(inherited.proxyId).toBeNull()
    expect((await f.save({ id: monitor.id })).proxyId).toBeNull()
    expect((await f.save()).proxyId).toBeNull()
  })

  it('validates retained proxy references when legacy edits omit proxyId', async () => {
    const f = setup()
    const { item: proxy } = await f.call<{ item: { id: string } }>('proxies.save', {
      name: 'Paused proxy',
      scheme: 'http',
      host: 'localhost',
      port: 3128,
      username: '',
      enabled: false,
    })
    const monitor = await f.save({ proxyId: proxy.id, enabled: false })
    expect(await f.save({ id: monitor.id, enabled: false })).toMatchObject({
      enabled: false,
      proxyId: proxy.id,
    })
    await expect(f.save({ id: monitor.id, enabled: true })).rejects.toThrow(/代理/)
    await f.store.mutate((doc) => {
      doc.proxies = []
    })
    await expect(f.save({ id: monitor.id, enabled: false })).rejects.toThrow(/代理/)
    expect((await f.store.read()).monitors[0]?.proxyId).toBe(proxy.id)
  })

  it('allows disabled monitors to retain a disabled existing proxy but rejects missing references and activation', async () => {
    const f = setup()
    const { item } = await f.call<{ item: { id: string } }>('proxies.save', {
      name: 'Paused proxy',
      scheme: 'http',
      host: 'localhost',
      port: 3128,
      username: '',
      enabled: false,
    })
    const paused = await f.save({ proxyId: item.id, enabled: false })
    expect(paused).toMatchObject({ enabled: false, proxyId: item.id })
    await expect(
      f.save({ id: paused.id, proxyId: item.id, enabled: true }),
    ).rejects.toThrow(/代理/)
    await expect(f.save({ proxyId: 'deleted', enabled: false })).rejects.toThrow(/代理/)
    await expect(f.call('monitors.run', { monitorId: paused.id })).rejects.toThrow()
    expect((await f.store.read()).runs).toHaveLength(0)
  })
  it('shares canonical identities across monitors and keeps the first snapshot while refreshing valid favourites', async () => {
    const f = setup()
    const first = await f.save()
    await f.run(first)
    const second = await f.save({ name: 'Other' })
    f.setRows([
      listing(1, { title: 'Changed', price: '999', favourite_count: '0', photos: [] }),
    ])
    await f.run(second)
    const { items, total } = await f.list()
    expect(total).toBe(2)
    const { item } = await f.call<{ item: ItemRecord }>('items.get', {
      itemId: 'vinted.fr:1',
    })
    expect(items.find((i) => i.externalId === '1')?.id).toBe(item.id)
    expect(item).toMatchObject({
      id: 'vinted.fr:1',
      domain: 'vinted.fr',
      title: 'Coat 1',
      price: '12',
      favouriteCount: 0,
      monitorId: first.id,
      monitorIds: [first.id, second.id],
      images: ['https://images1.vinted.net/a.jpg', 'https://images1.vinted.net/b.jpg'],
      seller: 'alice',
      userId: '42',
      sellerProfile: {
        name: 'Alice',
        feedbackCount: 10,
        verification: { email: { valid: true } },
      },
      detail: { title: 'Coat 1', favourite_count: 1 },
    })
    expect(f.userRequests).toBe(1)
    f.setRows([listing(1, { favourite_count: -1 })])
    await f.run(first)
    expect((await f.list()).items.find((i) => i.externalId === '1')?.favouriteCount).toBe(
      0,
    )
    expect(await f.call('monitors.list')).toMatchObject({
      itemCounts: { [first.id]: 2, [second.id]: 1 },
    })
  })

  it('stores profile failures, retries missing profiles and counts each seller once', async () => {
    const f = setup()
    f.setFailUser(true)
    const m = await f.save()
    expect(await f.run(m)).toMatchObject({
      status: 'partial',
      userFailed: 1,
      inserted: 2,
    })
    expect((await f.list()).items[0]?.sellerProfile).toMatchObject({
      collectedAt: null,
      error: expect.any(String),
    })
    f.setFailUser(false)
    expect(await f.run(m)).toMatchObject({ status: 'success', userFailed: 0 })
    expect((await f.list()).items[0]?.sellerProfile).toMatchObject({
      name: 'Alice',
      error: null,
    })
    expect(f.userRequests).toBe(2)
  })

  it('requires comparable complete scans before queuing missing items, and never infers sold', async () => {
    const f = setup()
    const m = await f.save()
    await f.run(m)
    f.setRows([listing(2)])
    f.setTruncated(true)
    expect(await f.run(m)).toMatchObject({ status: 'partial', truncated: true })
    expect(
      (await f.list()).items.find((i) => i.externalId === '1')?.availabilityStatus,
    ).toBe('unknown')
    f.setTruncated(false)
    f.setFailPage(true)
    await f.run(m)
    expect(
      (await f.list()).items.find((i) => i.externalId === '1')?.availabilityStatus,
    ).toBe('unknown')
    f.setFailPage(false)
    await f.run(m)
    expect((await f.list()).items.find((i) => i.externalId === '1')).toMatchObject({
      availabilityStatus: 'pending',
      missingMonitorId: m.id,
      missingSince: expect.any(String),
    })
    await f.call('items.availability', {
      itemId: 'vinted.fr:1',
      status: 'sold',
      note: ' Checked ',
    })
    f.setRows([listing(1)])
    await f.run(m)
    expect((await f.list()).items.find((i) => i.externalId === '1')).toMatchObject({
      availabilityStatus: 'sold',
      statusNote: 'Checked',
    })
    await f.call('items.availability', {
      itemId: 'vinted.fr:1',
      status: 'pending',
      note: '',
    })
    await f.run(m)
    expect((await f.list()).items.find((i) => i.externalId === '1')).toMatchObject({
      availabilityStatus: 'available',
      missingSince: null,
    })
  })

  it('persists a deletion exclusion through later runs and monitor deletion', async () => {
    const f = setup()
    const a = await f.save()
    const b = await f.save({ name: 'B' })
    await f.run(a)
    await f.run(b)
    await f.call('items.remove', { itemId: 'vinted.fr:1' })
    expect(await f.run(a)).toMatchObject({ skipped: 1, updated: 1, inserted: 0 })
    await f.call('monitors.remove', { monitorId: a.id })
    expect((await f.list()).items).toHaveLength(1)
    await f.call('monitors.remove', { monitorId: b.id })
    expect((await f.list()).total).toBe(1)
    const c = await f.save()
    await f.run(c)
    expect((await f.list()).items.map((i) => i.externalId)).toEqual(['2'])
  })

  it('applies SQL-like favourite filters, null-last ordering, star/review and full totals before pagination', async () => {
    const f = setup()
    f.setRows([
      listing(1, { favourite_count: null }),
      listing(2, { favourite_count: 0 }),
      listing(3, { favourite_count: 5 }),
    ])
    await f.run(await f.save())
    await f.call('items.star', { itemId: 'vinted.fr:2', starred: true })
    expect(
      (await f.list({ order: 'favourite_asc' })).items.map((i) => i.externalId),
    ).toEqual(['2', '3', '1'])
    expect(
      (await f.list({ order: 'favourite_desc' })).items.map((i) => i.externalId),
    ).toEqual(['3', '2', '1'])
    for (const [op, value, wanted] of [
      ['eq', 0, ['2']],
      ['ne', 0, ['3']],
      ['gt', 0, ['3']],
      ['ge', 5, ['3']],
      ['lt', 5, ['2']],
      ['le', 0, ['2']],
    ] as const) {
      expect(
        (await f.list({ favouriteCountOp: op, favouriteCount: value })).items.map(
          (i) => i.externalId,
        ),
      ).toEqual(wanted)
    }
    expect(
      (await f.list({ favouriteCountOp: 'isNull' })).items.map((i) => i.externalId),
    ).toEqual(['1'])
    expect((await f.list({ favouriteCountOp: 'notNull' })).total).toBe(2)
    expect(
      (
        await f.list({
          favouriteCountOp: 'between',
          favouriteCountStart: 1,
          favouriteCountEnd: 5,
        })
      ).total,
    ).toBe(1)
    expect((await f.list({ starred: true, externalId: '2' })).total).toBe(1)
    expect(await f.list({ page: 1, pageSize: 2 })).toMatchObject({
      total: 3,
      totalPages: 2,
      items: [expect.any(Object)],
    })
    await expect(
      f.list({
        favouriteCountOp: 'between',
        favouriteCountStart: 5,
        favouriteCountEnd: 1,
      }),
    ).rejects.toThrow()
    expect(await f.call('runs.list', { page: 1, pageSize: 1 })).toMatchObject({
      total: 1,
      totalPages: 1,
      items: [],
    })
    expect(await f.call('monitors.list', { page: 1, pageSize: 1 })).toMatchObject({
      total: 1,
      totalPages: 1,
      items: [],
    })
  })

  it('deduplicates seller monitors and inherits cadence and proxy from provenance', async () => {
    const f = setup()
    const { item: proxy } = await f.call<{ item: { id: string } }>('proxies.save', {
      name: 'Private',
      scheme: 'socks5h',
      host: '127.0.0.1',
      port: 1080,
      username: 'u',
      password: 'secret',
      enabled: true,
    })
    const m = await f.save({ proxyId: proxy.id })
    await f.run(m)
    const results = await Promise.all(
      [1, 2].map((id) =>
        f.call<{ monitor: MonitorRecord; created: boolean }>('items.monitorSeller', {
          itemId: `vinted.fr:${id}`,
        }),
      ),
    )
    expect(results.map((r) => r.created)).toEqual([true, false])
    expect(results[0]?.monitor).toMatchObject({
      searchUrl: 'https://vinted.fr/member/42',
      proxyId: proxy.id,
      intervalMinutes: 10,
      maxPages: 20,
      perPage: 96,
    })
    expect(results[1]?.monitor.id).toBe(results[0]?.monitor.id)
  })

  it('preserves omitted passwords, clears explicit empties, hides credentials, and fails closed for disabled defaults', async () => {
    const f = setup()
    const input = {
      name: 'P',
      scheme: 'http',
      host: 'localhost',
      port: 3128,
      username: 'u',
      password: 'plain',
      enabled: true,
    }
    const saved = await f.call<{ item: { id: string } }>('proxies.save', input)
    const id = saved.item.id
    const without = {
      name: input.name,
      scheme: input.scheme,
      host: input.host,
      port: input.port,
      username: input.username,
      enabled: input.enabled,
    }
    await f.call('proxies.save', { ...without, id })
    expect(JSON.stringify(await f.call('proxies.list'))).not.toContain('plain')
    expect((await f.store.read()).proxies[0]?.password).toBe('plain')
    await f.call('proxies.default', { proxyId: id })
    const m = await f.save()
    await f.call('proxies.save', { ...without, id, password: '', enabled: false })
    expect((await f.store.read()).proxies[0]?.password).toBe('')
    await expect(f.call('monitors.run', { monitorId: m.id })).rejects.toThrow()
    expect((await f.store.read()).runs).toHaveLength(0)
    await expect(f.call('proxies.remove', { proxyId: id })).rejects.toThrow()
    await f.call('proxies.default', { proxyId: null })
    expect(await f.call('proxies.remove', { proxyId: id })).toEqual({ removed: true })
  })

  it('keeps different storefront IDs separate and reports zero totals with legacy run limits', async () => {
    const f = setup()
    expect(await f.list()).toMatchObject({ items: [], total: 0, totalPages: 0 })
    expect(await f.call('runs.list', { page: 0, pageSize: 10 })).toMatchObject({
      total: 0,
      totalPages: 0,
    })
    expect(await f.call('monitors.list', { page: 0, pageSize: 10 })).toMatchObject({
      total: 0,
      totalPages: 0,
    })
    await f.run(await f.save())
    await f.run(
      await f.save({ searchUrl: 'https://www.vinted.de/catalog?search_text=coat' }),
    )
    expect((await f.list({ externalId: '1' })).items.map((i) => i.id).sort()).toEqual([
      'vinted.de:1',
      'vinted.fr:1',
    ])
    expect(await f.call('runs.list', { limit: 1 })).toMatchObject({
      total: 2,
      items: [expect.any(Object)],
    })
  })

  it('serializes simultaneous manual and scheduler admission and releases after final storage failure', async () => {
    const f = setup({ failFinish: true })
    const a = await f.save()
    const b = await f.save({ name: 'Second' })
    const results = await Promise.allSettled([
      f.call('monitors.run', { monitorId: a.id }),
      f.call('monitors.run', { monitorId: a.id }),
      f.call('monitors.run', { monitorId: b.id }),
      f.plugin.tick(),
    ])
    expect(results.slice(0, 3).filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (let i = 0; i < 100 && f.plugin.status().activeRuns !== 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    expect(f.plugin.status().activeRuns).toBe(0)
    expect((await f.store.read()).runs).toHaveLength(1)
    expect((await f.store.read()).runs[0]).toMatchObject({
      status: 'failed',
      error: expect.not.stringContaining('secret'),
    })
    expect(await f.run(a)).toMatchObject({ status: 'success' })
  })

  it('holds the same proxy dispatcher through pages and seller fetches while config changes', async () => {
    const dispatchers: unknown[] = []
    let release: (() => void) | undefined
    let waiting: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      waiting = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = setup({
      beforeRequest: async (_url, init) => {
        dispatchers.push(
          (init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher,
        )
        if (dispatchers.length === 1) {
          waiting?.()
          await gate
        }
      },
    })
    const input = {
      name: 'Private',
      scheme: 'http',
      host: 'localhost',
      port: 1234,
      username: 'user',
      password: 'secret',
      enabled: true,
    }
    const { item } = await f.call<{ item: { id: string } }>('proxies.save', input)
    await f.call('proxies.default', { proxyId: item.id })
    const m = await f.save()
    f.setTruncated(true)
    const pending = f.run(m)
    await entered
    await f.call('proxies.save', {
      ...input,
      id: item.id,
      enabled: false,
      password: 'changed',
    })
    release?.()
    expect(await pending).toMatchObject({ userFailed: 0 })
    expect(dispatchers.length).toBe(3)
    expect(dispatchers[0]).toBeDefined()
    expect(dispatchers.every((d) => d === dispatchers[0])).toBe(true)
    await expect(f.call('monitors.run', { monitorId: m.id })).rejects.toThrow(/代理/)
  })

  it('does not mark missing on malformed entries or seller errors or when the scan definition changes', async () => {
    const f = setup()
    const m = await f.save()
    await f.run(m)
    f.setRows([listing(2), listing(3, { title: '' })])
    expect(await f.run(m)).toMatchObject({ status: 'partial', failed: 1 })
    expect((await f.list({ externalId: '1' })).items[0]?.availabilityStatus).toBe(
      'unknown',
    )
    f.setFailUser(true)
    f.setRows([listing(2), listing(3, { user: { id: 99, login: 'b' } })])
    expect(await f.run(m)).toMatchObject({ userFailed: 1 })
    expect((await f.list({ externalId: '1' })).items[0]?.availabilityStatus).toBe(
      'unknown',
    )
    await f.call('monitors.save', {
      ...body,
      id: m.id,
      searchUrl: 'https://vinted.fr/catalog?search_text=changed',
    })
    f.setRows([])
    expect(await f.run(m)).toMatchObject({ status: 'success' })
    expect((await f.list({ externalId: '1' })).items[0]?.availabilityStatus).toBe(
      'unknown',
    )
  })

  it('protects deletion against an in-flight collection response', async () => {
    let release: (() => void) | undefined
    let block = false
    let entered: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const f = setup({
      beforeRequest: async () => {
        if (block) {
          entered?.()
          await gate
        }
      },
    })
    const m = await f.save()
    await f.run(m)
    block = true
    const pending = f.run(m)
    await started
    await f.call('items.remove', { itemId: 'vinted.fr:1' })
    release?.()
    expect(await pending).toMatchObject({ skipped: 1 })
    expect((await f.list({ externalId: '1' })).total).toBe(0)
    await expect(f.call('items.get', { itemId: 'vinted.fr:1' })).rejects.toThrow()
  })

  it('retains an archived image proxy reference after its source monitor is deleted', async () => {
    const f = setup()
    const input = {
      name: 'P',
      scheme: 'http',
      host: 'localhost',
      port: 3128,
      username: '',
      enabled: true,
    }
    const { item } = await f.call<{ item: { id: string } }>('proxies.save', input)
    const m = await f.save({ proxyId: item.id })
    await f.run(m)
    await f.call('monitors.remove', { monitorId: m.id })
    await f.call('proxies.save', { ...input, id: item.id, enabled: false })
    await expect(
      f.call('image.open', {
        itemId: 'vinted.fr:1',
        url: 'https://images1.vinted.net/a.jpg',
      }),
    ).rejects.toThrow(/不存在或已停用/)
  })
})
