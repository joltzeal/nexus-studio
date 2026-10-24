import { describe, expect, it } from 'vitest'

import type { ItemsPage } from '../domain/items.js'
import type { MonitorTarget } from '../domain/urls.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import { VintedClient } from '../services/vinted.js'
import { createMemoryStore, type PrivateStore } from '../store/private-store.js'
import { VintedMonitor } from './vinted-monitor.js'

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

interface Fixture {
  plugin: VintedMonitor
  store: PrivateStore
  /** Pages the fake client will serve, keyed by page number. */
  pages: Map<number, ItemsPage | Error>
  requests: string[]
  clock: { now: Date }
  /** A second capability over the same store, as after a process restart. */
  restart(): VintedMonitor
}

function item(id: string) {
  return {
    id,
    title: `商品 ${id}`,
    price: '10.0',
    currency: 'EUR',
    brand: 'Nike',
    size: 'M',
    condition: 'Good',
    url: `https://vinted.fr/items/${id}`,
    imageUrl: '',
    seller: 'someone',
    listedAt: '2024-01-01T00:00:00.000Z',
  }
}

function fixture(): Fixture {
  const store = createMemoryStore()
  const pages = new Map<number, ItemsPage | Error>()
  const requests: string[] = []
  const clock = { now: new Date('2024-05-01T10:00:00.000Z') }
  const client = {
    items: async (target: MonitorTarget, page: number, perPage: number) => {
      requests.push(`${target.url}#${String(page)}#${String(perPage)}`)
      const entry = pages.get(page)
      if (entry instanceof Error) throw entry
      if (entry === undefined) return { items: [], invalid: 0, hasMore: false }
      return entry
    },
  } as unknown as VintedClient
  let counter = 0
  const spawn = (): VintedMonitor =>
    new VintedMonitor({
      store,
      logger,
      client,
      now: () => clock.now,
      idFactory: () => `id-${String((counter += 1))}`,
      pause: async () => undefined,
    })
  return { plugin: spawn(), store, pages, requests, clock, restart: spawn }
}

function context(method: string, payload: unknown): DispatchContext {
  return {
    requestId: `req-${method}`,
    capability: 'monitor.collector',
    method,
    payload,
    deadlineAt: Date.now() + 60_000,
    assertAlive: () => undefined,
  }
}

const BODY = {
  name: 'Nike 女装',
  searchUrl: 'https://www.vinted.fr/catalog?search_text=nike&order=relevance',
  intervalMinutes: 10,
  maxPages: 3,
  perPage: 20,
  enabled: true,
}

async function createMonitor(fix: Fixture): Promise<string> {
  const result = (await fix.plugin.call(context('vinted.monitors.save', BODY))) as {
    item: { id: string }
  }
  return result.item.id
}

async function settle(fix: Fixture, runId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = (await fix.plugin.call(context('vinted.runs.get', { runId }))) as {
      item: Record<string, unknown>
    }
    if (result.item.status !== 'running') return result.item
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('采集没有在预期时间内结束')
}

describe('vinted monitor capability', () => {
  it('stores the canonical url and detects the monitor kind', async () => {
    const fix = fixture()
    const saved = (await fix.plugin.call(context('vinted.monitors.save', BODY))) as {
      item: { id: string; searchUrl: string; kind: string; host: string }
    }
    expect(saved.item.searchUrl).toBe(
      'https://vinted.fr/catalog?search_text=nike&order=newest_first',
    )
    expect(saved.item.kind).toBe('catalog')
    expect(saved.item.host).toBe('vinted.fr')

    const list = (await fix.plugin.call(context('vinted.monitors.list', {}))) as {
      items: { id: string }[]
      total: number
    }
    expect(list.total).toBe(1)
    expect(list.items[0]?.id).toBe(saved.item.id)
  })

  it('rejects a url that has no collection endpoint', async () => {
    const fix = fixture()
    await expect(
      fix.plugin.call(
        context('vinted.monitors.save', { ...BODY, searchUrl: 'https://vinted.fr/' }),
      ),
    ).rejects.toThrow(/catalog/)
  })

  it('collects, dedupes across pages and records the run', async () => {
    const fix = fixture()
    fix.pages.set(1, { items: [item('1'), item('2')], invalid: 0, hasMore: true })
    fix.pages.set(2, { items: [item('2'), item('3')], invalid: 1, hasMore: true })
    fix.pages.set(3, { items: [item('4')], invalid: 0, hasMore: false })
    const monitorId = await createMonitor(fix)

    const started = (await fix.plugin.call(
      context('vinted.monitors.run', { monitorId }),
    )) as { run: { id: string; status: string } }
    expect(started.run.status).toBe('running')

    const run = await settle(fix, started.run.id)
    expect(run).toMatchObject({
      status: 'partial',
      discovered: 4,
      inserted: 4,
      updated: 0,
      skipped: 2,
      truncated: false,
      pages: 3,
      error: expect.any(String),
    })
    expect(fix.requests).toHaveLength(3)

    const items = (await fix.plugin.call(
      context('vinted.items.list', { monitorId, page: 0, pageSize: 10 }),
    )) as { total: number; items: { id: string }[] }
    expect(items.total).toBe(4)
    expect(items.items.map((entry) => entry.id).sort()).toEqual([
      'vinted.fr:1',
      'vinted.fr:2',
      'vinted.fr:3',
      'vinted.fr:4',
    ])
  })

  it('updates instead of duplicating on a second run', async () => {
    const fix = fixture()
    fix.pages.set(1, { items: [item('1')], invalid: 0, hasMore: false })
    const monitorId = await createMonitor(fix)

    const first = (await fix.plugin.call(
      context('vinted.monitors.run', { monitorId }),
    )) as { run: { id: string } }
    await settle(fix, first.run.id)

    fix.clock.now = new Date('2024-05-01T10:30:00.000Z')
    const second = (await fix.plugin.call(
      context('vinted.monitors.run', { monitorId }),
    )) as { run: { id: string } }
    const run = await settle(fix, second.run.id)
    expect(run).toMatchObject({ inserted: 0, updated: 1, discovered: 1 })

    const items = (await fix.plugin.call(
      context('vinted.items.list', { monitorId, page: 0, pageSize: 10 }),
    )) as { total: number; items: { firstSeenAt: string; lastSeenAt: string }[] }
    expect(items.total).toBe(1)
    expect(items.items[0]?.firstSeenAt).toBe('2024-05-01T10:00:00.000Z')
    expect(items.items[0]?.lastSeenAt).toBe('2024-05-01T10:30:00.000Z')
  })

  it('keeps what it collected when a later page fails', async () => {
    const fix = fixture()
    fix.pages.set(1, { items: [item('1')], invalid: 0, hasMore: true })
    fix.pages.set(2, new Error('boom'))
    const monitorId = await createMonitor(fix)

    const started = (await fix.plugin.call(
      context('vinted.monitors.run', { monitorId }),
    )) as { run: { id: string } }
    const run = await settle(fix, started.run.id)
    expect(run.status).toBe('partial')
    expect(run.discovered).toBe(1)
    expect(run.failed).toBe(1)
    expect(String(run.error)).toContain('采集')
  })

  it('reports a failure when the first page cannot be read', async () => {
    const fix = fixture()
    fix.pages.set(1, new Error('boom'))
    const monitorId = await createMonitor(fix)

    const started = (await fix.plugin.call(
      context('vinted.monitors.run', { monitorId }),
    )) as { run: { id: string } }
    const run = await settle(fix, started.run.id)
    expect(run.status).toBe('failed')
    expect(run.pages).toBe(0)
  })

  it('marks the run truncated when the page limit is reached', async () => {
    const fix = fixture()
    for (const page of [1, 2, 3]) {
      fix.pages.set(page, {
        items: [item(String(page))],
        invalid: 0,
        hasMore: true,
      })
    }
    const monitorId = await createMonitor(fix)
    const started = (await fix.plugin.call(
      context('vinted.monitors.run', { monitorId }),
    )) as { run: { id: string } }
    const run = await settle(fix, started.run.id)
    expect(run.truncated).toBe(true)
    expect(run.pages).toBe(3)
  })

  it('refuses to run the same monitor twice at once', async () => {
    const fix = fixture()
    fix.pages.set(1, { items: [], invalid: 0, hasMore: false })
    const monitorId = await createMonitor(fix)
    const started = (await fix.plugin.call(
      context('vinted.monitors.run', { monitorId }),
    )) as { run: { id: string } }
    await expect(
      fix.plugin.call(context('vinted.monitors.run', { monitorId })),
    ).rejects.toThrow(/正在采集中/)
    await settle(fix, started.run.id)
  })

  it('deletes the monitor while retaining archived items and run history', async () => {
    const fix = fixture()
    fix.pages.set(1, { items: [item('1')], invalid: 0, hasMore: false })
    const monitorId = await createMonitor(fix)
    const started = (await fix.plugin.call(
      context('vinted.monitors.run', { monitorId }),
    )) as { run: { id: string } }
    await settle(fix, started.run.id)

    await fix.plugin.call(context('vinted.monitors.remove', { monitorId }))
    const document = await fix.store.read()
    expect(document.monitors).toHaveLength(0)
    expect(document.items).toHaveLength(1)
    expect(document.items[0]?.monitorIds).toEqual([])
    expect(document.runs).toHaveLength(1)
  })

  it('marks a run left running by a previous process as interrupted', async () => {
    const fix = fixture()
    const monitorId = await createMonitor(fix)
    await fix.store.mutate((document) => {
      document.runs.unshift({
        id: 'stale',
        monitorId,
        monitorName: 'Nike 女装',
        status: 'running',
        startedAt: '2024-04-30T00:00:00.000Z',
        finishedAt: null,
        discovered: 3,
        inserted: 3,
        updated: 0,
        userFailed: 0,
        skipped: 0,
        failed: 0,
        truncated: false,
        pages: 1,
        error: null,
      })
    })

    // A fresh capability over the same store is what a restarted process sees.
    const restarted = fix.restart()
    const run = (await restarted.call(
      context('vinted.runs.get', { runId: 'stale' }),
    )) as { item: { status: string; error: string | null; finishedAt: string | null } }
    expect(run.item.status).toBe('interrupted')
    expect(run.item.error).toContain('中断')
    expect(run.item.finishedAt).toBe('2024-05-01T10:00:00.000Z')
  })

  it('only schedules monitors whose interval has elapsed', async () => {
    const fix = fixture()
    fix.pages.set(1, { items: [item('1')], invalid: 0, hasMore: false })
    const monitorId = await createMonitor(fix)

    await fix.plugin.tick()
    let document = await fix.store.read()
    expect(document.runs).toHaveLength(1)
    expect(document.runs[0]?.status).toBe('running')
    // Let the first walk finish before the next tick.
    await settle(fix, document.runs[0]?.id ?? '')

    // Five minutes later the ten-minute interval has not elapsed.
    fix.clock.now = new Date('2024-05-01T10:05:00.000Z')
    await fix.plugin.tick()
    document = await fix.store.read()
    expect(document.runs).toHaveLength(1)

    // Ten minutes later it is due again.
    fix.clock.now = new Date('2024-05-01T10:10:00.000Z')
    await fix.plugin.tick()
    document = await fix.store.read()
    expect(document.runs).toHaveLength(2)
    expect(document.monitors[0]?.id).toBe(monitorId)
    await settle(fix, document.runs[0]?.id ?? '')
  })

  it('skips disabled monitors when scheduling', async () => {
    const fix = fixture()
    const monitorId = await createMonitor(fix)
    await fix.plugin.call(
      context('vinted.monitors.save', {
        ...BODY,
        id: monitorId,
        enabled: false,
      }),
    )
    await fix.plugin.tick()
    const document = await fix.store.read()
    expect(document.runs).toHaveLength(0)
  })

  it('inspects a url without saving it', async () => {
    const fix = fixture()
    const result = (await fix.plugin.call(
      context('vinted.url.inspect', { url: 'https://www.vinted.de/member/99-x' }),
    )) as { kind: string; userId: string; url: string }
    expect(result).toEqual({
      kind: 'member',
      host: 'vinted.de',
      userId: '99',
      url: 'https://vinted.de/member/99',
    })
    const document = await fix.store.read()
    expect(document.monitors).toHaveLength(0)
  })

  it('filters items by keyword and pages them', async () => {
    const fix = fixture()
    fix.pages.set(1, {
      items: [item('1'), { ...item('2'), title: 'Adidas 短裤' }],
      invalid: 0,
      hasMore: false,
    })
    const monitorId = await createMonitor(fix)
    const started = (await fix.plugin.call(
      context('vinted.monitors.run', { monitorId }),
    )) as { run: { id: string } }
    await settle(fix, started.run.id)

    const filtered = (await fix.plugin.call(
      context('vinted.items.list', {
        monitorId,
        keyword: 'adidas',
        page: 0,
        pageSize: 10,
      }),
    )) as { total: number; items: { id: string }[] }
    expect(filtered.total).toBe(1)
    expect(filtered.items[0]?.id).toBe('vinted.fr:2')

    const paged = (await fix.plugin.call(
      context('vinted.items.list', { monitorId, page: 1, pageSize: 1 }),
    )) as { total: number; items: unknown[] }
    expect(paged.total).toBe(2)
    expect(paged.items).toHaveLength(1)
  })
})
