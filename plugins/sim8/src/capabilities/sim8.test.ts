import { describe, expect, it } from 'vitest'

import { PluginFailure } from '../domain/errors.js'
import type { RenewReport, SmsRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { Redactor, type Logger } from '../rpc/redact.js'
import { createMemoryStore, type PrivateStore } from '../store/private-store.js'
import { createMemoryVault, type SecretVault } from '../store/secret-vault.js'
import { SIM8_METHODS, Sim8Provider } from './sim8.js'

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

interface Call {
  url: string
  init: RequestInit
  body: Record<string, unknown> | null
}

type Handler = (call: Call) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Fixture {
  provider: Sim8Provider
  store: PrivateStore
  vault: SecretVault
  calls: Call[]
  clock: { now: Date }
}

/**
 * Every API call is routed by path, so a test states only the answer it cares
 * about and the assertion can inspect the request that produced it.
 */
async function fixture(
  handler: Handler,
  options: { token?: string | null } = {},
): Promise<Fixture> {
  const store = createMemoryStore()
  const vault = createMemoryVault(new Redactor())
  const clock = { now: new Date('2026-10-24T00:00:00.000Z') }
  const calls: Call[] = []
  const token = options.token === undefined ? 'tok' : options.token
  if (token !== null) {
    const stored = await vault.put('api-token', token)
    await store.mutate((draft) => {
      draft.config.tokenRef = stored.ref
    })
  }
  let sequence = 0
  const provider = new Sim8Provider({
    store,
    vault,
    logger,
    now: () => clock.now,
    requestIdFactory: () => {
      sequence += 1
      return `req-${String(sequence)}`
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const raw = init?.body
      const body =
        typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null
      const call: Call = { url, init: init ?? {}, body }
      calls.push(call)
      return await handler(call)
    }) as unknown as typeof fetch,
  })
  return { provider, store, vault, calls, clock }
}

function context(method: string, payload: unknown = {}): DispatchContext {
  return {
    requestId: `req-${method}`,
    capability: 'verification.provider',
    method,
    payload,
    deadlineAt: Date.now() + 5_000,
    assertAlive: () => undefined,
  }
}

async function call<T>(
  provider: Sim8Provider,
  method: string,
  payload: unknown = {},
): Promise<T> {
  return (await provider.call(context(method, payload))) as T
}

async function failureOf(run: () => Promise<unknown>): Promise<PluginFailure> {
  try {
    await run()
  } catch (error) {
    if (error instanceof PluginFailure) return error
    throw error
  }
  throw new Error('调用没有失败')
}

const PURCHASE = {
  code: 1,
  msg: 'ok',
  data: {
    ordernum: 'ORD-1',
    api_count: 2,
    list: [
      {
        tel: '+14155550100',
        token: 't1',
        end_time: '2026-11-01 12:00:00',
        api: 'https://api.cc/api/record?token=t1',
      },
      {
        tel: '+14155550101',
        token: 't2',
        end_time: '2026-11-01 12:00:00',
        api: 'https://api.cc/api/record?token=t2',
      },
    ],
  },
}

describe('configuration', () => {
  it('reports an empty configuration before a token is saved', async () => {
    const { provider } = await fixture(() => json({ code: 1, data: null }), {
      token: null,
    })
    const config = await call<{ hasToken: boolean; baseUrl: string }>(
      provider,
      'sim8.config.get',
    )
    expect(config.hasToken).toBe(false)
    expect(config.baseUrl).toBe('https://api.cc')
  })

  it('verifies a token against the profile before storing it', async () => {
    const { provider, store } = await fixture(
      ({ url }) => {
        if (url.includes('/profile/info')) {
          return json({
            code: 1,
            data: { username: 'u', nickname: 'n', avatar: '', money: 12.5 },
          })
        }
        return json({ code: 0, msg: 'unexpected' })
      },
      { token: null },
    )

    const config = await call<{ hasToken: boolean; profile: { money: number } }>(
      provider,
      'sim8.config.set',
      { token: 'Bearer abc' },
    )
    expect(config.hasToken).toBe(true)
    expect(config.profile.money).toBe(12.5)
    const document = await store.read()
    expect(document.config.tokenRef).not.toBeNull()
    expect(JSON.stringify(document)).not.toContain('abc')
  })

  it('refuses to store a token the API rejects', async () => {
    const { provider, store } = await fixture(
      () => json({ code: 401, msg: 'token 无效' }),
      {
        token: null,
      },
    )
    const error = await failureOf(() =>
      call(provider, 'sim8.config.set', { token: 'wrong' }),
    )
    expect(error.code).toBe('AUTH_FAILED')
    const document = await store.read()
    expect(document.config.tokenRef).toBeNull()
  })

  it('normalizes the base url and keeps the token when only the url changes', async () => {
    const { provider, store } = await fixture(() => json({ code: 1, data: null }))
    const config = await call<{ baseUrl: string; hasToken: boolean }>(
      provider,
      'sim8.config.set',
      { baseUrl: 'api.example.com/' },
    )
    expect(config.baseUrl).toBe('https://api.example.com')
    expect(config.hasToken).toBe(true)
    expect((await store.read()).config.baseUrl).toBe('https://api.example.com')
  })

  it('clears the token', async () => {
    const { provider, store } = await fixture(() => json({ code: 1, data: null }))
    const config = await call<{ hasToken: boolean }>(provider, 'sim8.config.set', {
      token: null,
    })
    expect(config.hasToken).toBe(false)
    expect((await store.read()).config.tokenRef).toBeNull()
  })

  it('refreshes the cached profile', async () => {
    const { provider, store } = await fixture(() =>
      json({ code: 1, data: { username: 'u', nickname: 'n', avatar: '', money: 3 } }),
    )
    const result = await call<{ profile: { money: number } }>(provider, 'sim8.profile')
    expect(result.profile.money).toBe(3)
    expect((await store.read()).config.profile?.money).toBe(3)
  })

  it('says what is missing instead of calling the API without a token', async () => {
    const { provider } = await fixture(() => json({ code: 1, data: null }), {
      token: null,
    })
    const error = await failureOf(() => call(provider, 'sim8.catalog.categories'))
    expect(error.code).toBe('NOT_CONFIGURED')
  })
})

describe('projects', () => {
  it('lists categories', async () => {
    const { provider } = await fixture(() =>
      json({ code: 1, data: { list: [{ id: 2, name: '热门' }], total: 1 } }),
    )
    const result = await call<{ items: unknown[] }>(provider, 'sim8.catalog.categories')
    expect(result.items).toHaveLength(1)
  })

  it('lists projects with the documented defaults', async () => {
    const { provider, calls } = await fixture(() =>
      json({ code: 1, data: { list: [{ id: 9, name: 'Vinted', price: 1.5, num: 20 }] } }),
    )
    const result = await call<{ items: Array<{ id: number }> }>(
      provider,
      'sim8.catalog.apps',
    )
    expect(result.items[0]?.id).toBe(9)
    expect(calls[0]?.body).toEqual({ cate_id: 2, type: 1 })
  })

  it('passes a project name filter through', async () => {
    const { provider, calls } = await fixture(() => json({ code: 1, data: { list: [] } }))
    await call(provider, 'sim8.catalog.apps', { name: 'vinted' })
    expect(calls[0]?.body).toEqual({ cate_id: 2, type: 1, name: 'vinted' })
  })

  it('lists the prefixes of a project', async () => {
    const { provider, calls } = await fixture(() =>
      json({ code: 1, data: { list: [{ prefix: '1415', num: 4 }], count: 1, num: 4 } }),
    )
    const result = await call<{ num: number }>(provider, 'sim8.buy.prefixes', {
      appId: 9,
    })
    expect(result.num).toBe(4)
    expect(calls[0]?.body).toEqual({ app_id: 9, type: 1, expiry: 0 })
  })
})

describe('buying', () => {
  it('stores the numbers a purchase returned', async () => {
    const { provider, store } = await fixture(() => json(PURCHASE))
    const result = await call<{ ordernum: string; records: SmsRecord[] }>(
      provider,
      'sim8.buy.create',
      { appId: 9, num: 2 },
    )
    expect(result.ordernum).toBe('ORD-1')
    expect(result.records).toHaveLength(2)
    expect((await store.read()).records).toHaveLength(2)
  })

  it('sends the purchase parameters the API expects', async () => {
    const { provider, calls } = await fixture(() => json(PURCHASE))
    await call(provider, 'sim8.buy.create', {
      appId: 9,
      num: 2,
      type: 2,
      expiry: 3,
      prefix: '1415,1416',
      excludePrefix: '1417',
    })
    expect(calls[0]?.body).toEqual({
      app_id: 9,
      num: 2,
      type: 2,
      expiry: 3,
      prefix: '1415,1416',
      exclude_prefix: '1417',
    })
  })

  it('omits empty prefix fields instead of sending blank strings', async () => {
    const { provider, calls } = await fixture(() => json(PURCHASE))
    await call(provider, 'sim8.buy.create', {
      appId: 9,
      num: 1,
      prefix: '',
      excludePrefix: '',
    })
    expect(calls[0]?.body).toEqual({ app_id: 9, num: 1, type: 1, expiry: 0 })
  })

  it('rejects a count outside the API range', async () => {
    const { provider } = await fixture(() => json(PURCHASE))
    const error = await failureOf(() =>
      call(provider, 'sim8.buy.create', { appId: 9, num: 0 }),
    )
    expect(error.code).toBe('INVALID_REQUEST')
  })

  it('reports the provider reason when a purchase fails', async () => {
    const { provider } = await fixture(() => json({ code: 0, msg: '余额不足' }))
    const error = await failureOf(() =>
      call(provider, 'sim8.buy.create', { appId: 9, num: 1 }),
    )
    expect(error.message).toBe('余额不足')
  })

  it('places a deferred order with an idempotency key', async () => {
    const { provider, calls } = await fixture(() =>
      json({
        code: 1,
        data: {
          ordernum: 'ORD-2',
          allocation_status: 'pending',
          requested_num: 3,
          allocated_num: 0,
          api_count: 0,
          expire_at: '2026-11-01 00:00:00',
        },
      }),
    )
    const state = await call<{ ordernum: string; allocationStatus: string }>(
      provider,
      'sim8.buy.deferred',
      { appId: 9, num: 3 },
    )
    expect(state.ordernum).toBe('ORD-2')
    expect(state.allocationStatus).toBe('pending')
    expect(calls[0]?.body?.['request_id']).toBe('req-1')
  })
})

describe('orders', () => {
  it('lists orders', async () => {
    const { provider, calls } = await fixture(() =>
      json({
        code: 1,
        data: {
          list: [{ ordernum: 'ORD-1', allocation_status: 'completed', requested_num: 2 }],
          total: 1,
        },
      }),
    )
    const result = await call<{ items: Array<{ ordernum: string }> }>(
      provider,
      'sim8.orders.list',
      { page: 2, limit: 10 },
    )
    expect(result.items[0]?.ordernum).toBe('ORD-1')
    expect(calls[0]?.body).toEqual({ page: 2, limit: 10 })
  })

  it('syncs every record link of an order into the local list', async () => {
    const { provider, store } = await fixture(() =>
      json({
        code: 1,
        data: {
          ...PURCHASE.data,
          allocation_status: 'completed',
          requested_num: 2,
          allocated_num: 2,
        },
      }),
    )
    const result = await call<{
      records: SmsRecord[]
      allocation: { allocationStatus: string }
    }>(provider, 'sim8.orders.apis', { ordernum: 'ORD-1' })
    expect(result.records).toHaveLength(2)
    expect(result.allocation.allocationStatus).toBe('completed')
    expect((await store.read()).records).toHaveLength(2)
  })

  it('reads a single record link of an order', async () => {
    const { provider } = await fixture(() =>
      json({
        code: 1,
        data: { data: { id: 5, tel: '+14155550100', api: 'https://api.cc/r?token=t1' } },
      }),
    )
    const result = await call<{ record: SmsRecord | null }>(provider, 'sim8.orders.one', {
      ordernum: 'ORD-1',
    })
    expect(result.record?.apiId).toBe(5)
  })

  it('reports an order with no numbers yet', async () => {
    const { provider } = await fixture(() => json({ code: 1, data: { data: null } }))
    const error = await failureOf(() =>
      call(provider, 'sim8.orders.one', { ordernum: 'ORD-1' }),
    )
    expect(error.message).toContain('还没有分配号码')
  })

  it('replaces the link of a number after rotating its token', async () => {
    const { provider, calls } = await fixture(({ url }) => {
      if (url.includes('/buy/create')) return json(PURCHASE)
      return json({
        code: 1,
        data: {
          id: 5,
          tel: '+14155550100',
          token: 'fresh',
          api: 'https://api.cc/api/record?token=fresh',
        },
      })
    })
    await call(provider, 'sim8.buy.create', { appId: 9, num: 2 })
    const result = await call<{ record: SmsRecord | null }>(
      provider,
      'sim8.orders.changeToken',
      {
        apiId: 5,
      },
    )
    expect(result.record?.token).toBe('fresh')
    expect(calls[1]?.body).toEqual({ id: 5 })
  })

  it('builds the renewal text from the stored records', async () => {
    const { provider, calls } = await fixture(({ url }) => {
      if (url.includes('/buy/create')) return json(PURCHASE)
      return json({ code: 1, data: { list: PURCHASE.data.list, success: 2, failed: 0 } })
    })
    await call(provider, 'sim8.buy.create', { appId: 9, num: 2 })
    const report = await call<RenewReport>(provider, 'sim8.orders.renewText', {
      tels: ['+14155550100'],
    })
    expect(report.success).toBe(2)
    expect(String(calls[1]?.body?.['api'])).toBe(
      '+14155550100----https://api.cc/api/record?token=t1',
    )
  })

  it('refuses to renew a number that has no link', async () => {
    const { provider } = await fixture(() => json({ code: 1, data: { list: [] } }))
    const error = await failureOf(() =>
      call(provider, 'sim8.orders.renewText', { tels: ['+14155550199'] }),
    )
    expect(error.message).toContain('没有 +14155550199 的记录')
  })

  it('renews by record id', async () => {
    const { provider, calls } = await fixture(() =>
      json({ code: 1, data: { ids: '5,6' } }),
    )
    const result = await call<{ ids: string }>(provider, 'sim8.orders.renewIds', {
      ids: [5, 6],
    })
    expect(result.ids).toBe('5,6')
    expect(calls[0]?.body).toEqual({ ids: '5,6' })
  })
})

describe('number filtering', () => {
  it('lists filter projects', async () => {
    const { provider } = await fixture(() =>
      json({
        code: 1,
        data: {
          list: [{ id: 4, name: 'Vinted', price: 0.02, number_min: 10, number_max: 500 }],
        },
      }),
    )
    const result = await call<{ items: Array<{ min: number | null }> }>(
      provider,
      'sim8.filter.apps',
    )
    expect(result.items[0]?.min).toBe(10)
  })

  it('uploads the number list as a file', async () => {
    const { provider, calls } = await fixture(() =>
      json({ code: 1, data: { order_id: 3 } }),
    )
    const result = await call<{ orderId: number }>(provider, 'sim8.filter.create', {
      appId: 4,
      code: 'US',
      numbers: ['14155550100', '14155550101'],
    })
    expect(result.orderId).toBe(3)
    const form = calls[0]?.init.body as FormData
    expect(form.get('app_id')).toBe('4')
    expect(form.get('code')).toBe('US')
    const file = form.get('file') as File
    expect(await file.text()).toBe('14155550100\n14155550101\n')
  })

  it('reports a filter order that came back without an id', async () => {
    const { provider } = await fixture(() => json({ code: 1, data: {} }))
    const error = await failureOf(() =>
      call(provider, 'sim8.filter.create', { appId: 4, code: 'US', numbers: ['1'] }),
    )
    expect(error.message).toContain('没有返回订单 ID')
  })

  it('reads a filter order detail', async () => {
    const { provider, calls } = await fixture(() =>
      json({ code: 1, data: { order_id: 3, valid: 9, status: 2 } }),
    )
    const detail = await call<{ valid: number | null }>(provider, 'sim8.filter.detail', {
      orderId: 3,
    })
    expect(detail.valid).toBe(9)
    expect(calls[0]?.url).toContain('order_id=3')
  })
})

describe('reading a code', () => {
  it('extracts the code from the record link and remembers it', async () => {
    const { provider, store } = await fixture(({ url }) => {
      if (url.includes('/buy/create')) return json(PURCHASE)
      return new Response('Your Vinted code is 482913', {
        headers: { 'content-type': 'text/plain' },
      })
    })
    await call(provider, 'sim8.buy.create', { appId: 9, num: 2 })
    const result = await call<{ result: { code: string | null; body: string } }>(
      provider,
      'sim8.sms.read',
      { tel: '+14155550100' },
    )
    expect(result.result.code).toBe('482913')
    expect(result.result.body).toContain('482913')
    const record = (await store.read()).records.find(
      (entry) => entry.tel === '+14155550100',
    )
    expect(record?.lastRead?.code).toBe('482913')
  })

  it('fetches the record link without the account token', async () => {
    const { provider, calls } = await fixture(({ url }) => {
      if (url.includes('/buy/create')) return json(PURCHASE)
      return new Response('482913', { headers: { 'content-type': 'text/plain' } })
    })
    await call(provider, 'sim8.buy.create', { appId: 9, num: 1 })
    await call(provider, 'sim8.sms.read', { tel: '+14155550100' })
    const headers = calls[1]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBeUndefined()
  })

  it('answers "not yet" instead of failing when there is no code', async () => {
    const { provider } = await fixture(({ url }) => {
      if (url.includes('/buy/create')) return json(PURCHASE)
      return new Response('{"code":0,"msg":"还没有收到短信"}', {
        headers: { 'content-type': 'application/json' },
      })
    })
    await call(provider, 'sim8.buy.create', { appId: 9, num: 1 })
    const result = await call<{ result: { code: string | null } }>(
      provider,
      'sim8.sms.read',
      {
        tel: '+14155550100',
      },
    )
    expect(result.result.code).toBeNull()
  })

  it('reads a link given directly', async () => {
    const { provider } = await fixture(
      () => new Response('code 654321', { headers: { 'content-type': 'text/plain' } }),
      { token: null },
    )
    const result = await call<{ result: { code: string | null } }>(
      provider,
      'sim8.sms.read',
      {
        url: 'https://api.cc/api/record?token=direct',
      },
    )
    expect(result.result.code).toBe('654321')
  })

  it('reports a dead record link', async () => {
    const { provider } = await fixture(({ url }) => {
      if (url.includes('/buy/create')) return json(PURCHASE)
      return new Response('gone', { status: 404 })
    })
    await call(provider, 'sim8.buy.create', { appId: 9, num: 1 })
    const error = await failureOf(() =>
      call(provider, 'sim8.sms.read', { tel: '+14155550100' }),
    )
    expect(error.message).toContain('404')
  })

  it('rejects a number that was never bought', async () => {
    const { provider } = await fixture(() => json({ code: 1, data: null }))
    const error = await failureOf(() =>
      call(provider, 'sim8.sms.read', { tel: '+14155550199' }),
    )
    expect(error.message).toContain('没有这个号码的记录')
  })
})

describe('local records', () => {
  it('lists, searches, removes and clears', async () => {
    const { provider } = await fixture(({ url }) => {
      if (url.includes('/buy/create')) return json(PURCHASE)
      return json({ code: 1, data: null })
    })
    await call(provider, 'sim8.buy.create', { appId: 9, num: 2 })

    const all = await call<{ items: SmsRecord[]; total: number }>(
      provider,
      'sim8.records.list',
    )
    expect(all.total).toBe(2)

    const searched = await call<{ matched: number }>(provider, 'sim8.records.list', {
      query: '14155550101',
    })
    expect(searched.matched).toBe(1)

    const removed = await call<{ removed: boolean }>(provider, 'sim8.records.remove', {
      tel: '14155550101',
    })
    expect(removed.removed).toBe(true)

    const cleared = await call<{ removed: number }>(provider, 'sim8.records.clear')
    expect(cleared.removed).toBe(1)
  })

  it('rejects an unknown method', async () => {
    const { provider } = await fixture(() => json({ code: 1, data: null }))
    const error = await failureOf(() => call(provider, 'sim8.nope'))
    expect(error.code).toBe('INVALID_REQUEST')
  })
})

describe('method table', () => {
  it('covers every documented endpoint', () => {
    expect(SIM8_METHODS).toEqual(
      expect.arrayContaining([
        'sim8.profile',
        'sim8.catalog.categories',
        'sim8.catalog.apps',
        'sim8.buy.prefixes',
        'sim8.buy.create',
        'sim8.buy.deferred',
        'sim8.orders.list',
        'sim8.orders.apis',
        'sim8.orders.changeToken',
        'sim8.orders.one',
        'sim8.orders.renewText',
        'sim8.orders.renewIds',
        'sim8.filter.apps',
        'sim8.filter.create',
        'sim8.filter.detail',
        'sim8.sms.read',
      ]),
    )
    // No duplicates: the handshake reports this list verbatim.
    expect(new Set(SIM8_METHODS).size).toBe(SIM8_METHODS.length)
  })
})
