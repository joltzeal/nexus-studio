import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AccountRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import {
  createFileStore,
  createMemoryStore,
  type AccountStore,
} from '../store/account-store.js'
import { AccountPool } from './accounts.js'
import { startVintedAccountsPlugin } from '../index.js'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
const directories: string[] = []
const plugins: AccountPool[] = []

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((pool) => pool.orders.stop()))
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
  vi.useRealTimers()
})

function context(method: string, payload: unknown = {}): DispatchContext {
  return {
    requestId: `test-${method}`,
    capability: 'account.pool',
    method,
    payload,
    deadlineAt: Date.now() + 10_000,
    assertAlive() {},
  }
}

function call<T = unknown>(pool: AccountPool, method: string, payload: unknown = {}) {
  return pool.call(context(method, payload)) as Promise<T>
}

function item(id: string) {
  return {
    id,
    url: `https://www.vinted.fr/items/${id}`,
    title: `Canvas ${id}`,
    imageUrl: null,
  }
}

const settings = {
  intervalMinutes: 30,
  bark: {
    enabled: true,
    baseUrl: 'https://bark.example.test',
    deviceKey: 'synthetic-device-key',
  },
}

function fixture(options: { store?: AccountStore; fetchImpl?: typeof fetch } = {}) {
  const store = options.store ?? createMemoryStore()
  const clock = { now: new Date('2026-11-11T06:00:00.000Z') }
  const responses = {
    items: [item('1'), item('2')],
    sold: false,
    error: null as Error | null,
    wait: null as Promise<void> | null,
    checked: [] as string[],
    sent: [] as Record<string, unknown>[],
    barkFails: false,
  }
  const pool = new AccountPool({
    store,
    logger,
    now: () => clock.now,
    orderCheckDelayMs: 0,
    orderSourceFactory: () => ({
      async scan(_url, signal) {
        if (responses.wait) await responses.wait
        if (signal.aborted) throw signal.reason
        if (responses.error) throw responses.error
        return structuredClone(responses.items)
      },
      async check(value) {
        responses.checked.push(value.id)
        return {
          sold: responses.sold,
          error: responses.sold ? null : '页面未显示 Sold 标记',
        }
      },
    }),
    fetchImpl:
      options.fetchImpl ??
      (async (_url, init) => {
        responses.sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ code: responses.barkFails ? 500 : 200 }, { status: 200 })
      }),
  })
  plugins.push(pool)
  return {
    pool,
    store,
    clock,
    responses,
    advance(minutes = 30) {
      clock.now = new Date(clock.now.getTime() + minutes * 60_000)
    },
  }
}

async function seed(pool: AccountPool, extra: Partial<AccountRecord> = {}) {
  return (
    await call<{ item: AccountRecord }>(pool, 'vinted.accounts.save', {
      loginMethod: 'email',
      account: 'seller@example.test',
      password: 'synthetic-password',
      phone: '',
      emailOtpUrl: '',
      smsOtpUrl: '',
      status: 'active',
      note: '',
      homepageUrl: 'https://vinted.fr/member/42',
      ...extra,
    })
  ).item
}

interface View {
  accountId: string
  enabled: boolean
  running: boolean
  lastCompleteAt: string | null
  lastItemCount: number | null
  lastError: string | null
  pendingCount: number
  soldCount: number
  candidates: {
    id: string
    itemId: string
    status: string
    notifiedAt: string | null
    notifyError: string | null
  }[]
}

async function detail(pool: AccountPool, accountId: string) {
  return (
    await call<{ items: View[] }>(pool, 'vinted.accounts.orders.list', { accountId })
  ).items[0]!
}

describe('automatic account sale queries', () => {
  it('enrols existing homepage accounts, establishes a baseline and only pushes confirmed sales', async () => {
    const f = fixture()
    const account = await seed(f.pool)
    await seed(f.pool, { account: 'no-homepage@example.test', homepageUrl: '' })
    await call(f.pool, 'vinted.accounts.orders.settings.save', settings)
    await f.pool.orders.tick()
    expect(await detail(f.pool, account.id)).toMatchObject({
      enabled: true,
      running: false,
      lastItemCount: 2,
      candidates: [],
    })
    expect(f.responses.sent).toEqual([])

    f.responses.items = [item('2')]
    f.advance()
    await f.pool.orders.tick()
    expect(await detail(f.pool, account.id)).toMatchObject({
      lastItemCount: 1,
      pendingCount: 1,
      candidates: [{ itemId: '1', status: 'pending', notifiedAt: null }],
    })
    expect(f.responses.sent).toEqual([])

    f.responses.sold = true
    f.advance()
    await f.pool.orders.tick()
    expect(await detail(f.pool, account.id)).toMatchObject({
      soldCount: 1,
      candidates: [
        { itemId: '1', status: 'sold', notifiedAt: '2026-11-11T07:00:00.000Z' },
      ],
    })
    expect(f.responses.sent).toEqual([
      {
        device_key: 'synthetic-device-key',
        title: 'Vinted 商品已售',
        body: 'seller@example.test\nCanvas 1',
        group: 'Vinted 订单监控',
        url: 'https://www.vinted.fr/items/1',
      },
    ])
    f.advance()
    await f.pool.orders.tick()
    expect(f.responses.sent).toHaveLength(1)
    const list = await call<{ items: View[] }>(f.pool, 'vinted.accounts.orders.list')
    expect(list.items).toHaveLength(1)
    expect(list.items[0]?.candidates).toEqual([])
  })

  it('preserves the previous full snapshot on scan failure and recovers on retry', async () => {
    const f = fixture()
    const account = await seed(f.pool)
    await f.pool.orders.tick()
    f.responses.error = new Error('upstream failure with secret material')
    f.responses.items = []
    f.advance()
    await f.pool.orders.tick()
    expect(await detail(f.pool, account.id)).toMatchObject({
      lastItemCount: 2,
      lastCompleteAt: '2026-11-11T06:00:00.000Z',
      candidates: [],
    })
    expect((await detail(f.pool, account.id)).lastError).not.toContain('secret')
    f.responses.error = null
    f.advance()
    await f.pool.orders.tick()
    expect((await detail(f.pool, account.id)).candidates).toHaveLength(2)
  })

  it('ignores late results when an account changes homepage or is removed', async () => {
    const f = fixture()
    const account = await seed(f.pool)
    let finish = () => {}
    f.responses.wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    const running = f.pool.orders.tick()
    await eventually(async () => (await detail(f.pool, account.id)).running)
    await seed(f.pool, {
      id: account.id,
      homepageUrl: 'https://www.vinted.fr/member/99',
    })
    finish()
    await running
    expect(await detail(f.pool, account.id)).toMatchObject({
      lastCompleteAt: null,
      lastItemCount: null,
    })
    await call(f.pool, 'vinted.accounts.remove', { accountId: account.id })
    expect(
      await call(f.pool, 'vinted.accounts.orders.list', { accountId: account.id }),
    ).toEqual({ items: [] })
  })

  it('serializes manual and scheduled queries and persists pause across restarts', async () => {
    const f = fixture()
    const account = await seed(f.pool)
    let finish = () => {}
    f.responses.wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    const running = f.pool.orders.tick()
    await eventually(async () => (await detail(f.pool, account.id)).running)
    expect(
      await call(f.pool, 'vinted.accounts.orders.run', { accountId: account.id }),
    ).toEqual({ queued: false })
    await call(f.pool, 'vinted.accounts.orders.enabled', {
      accountId: account.id,
      enabled: false,
    })
    finish()
    await running
    expect(await detail(f.pool, account.id)).toMatchObject({
      enabled: false,
      lastCompleteAt: null,
    })
    const restarted = fixture({ store: f.store })
    await restarted.pool.orders.tick()
    expect(await detail(restarted.pool, account.id)).toMatchObject({
      enabled: false,
      lastCompleteAt: null,
    })
  })

  it('closes a reappearing disappearance cycle so a later sale can be notified', async () => {
    const f = fixture()
    const account = await seed(f.pool)
    await call(f.pool, 'vinted.accounts.orders.settings.save', settings)
    await f.pool.orders.tick()
    f.responses.items = [item('2')]
    f.responses.sold = true
    f.advance()
    await f.pool.orders.tick()
    f.responses.items = [item('1'), item('2')]
    f.advance()
    await f.pool.orders.tick()
    expect((await detail(f.pool, account.id)).candidates[0]?.status).toBe('reappeared')
    f.responses.items = [item('2')]
    f.advance()
    await f.pool.orders.tick()
    expect(f.responses.sent).toHaveLength(2)
    expect((await detail(f.pool, account.id)).candidates).toHaveLength(2)
  })

  it('retries failed Bark delivery after restart without notifying a delivered sale again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-orders-'))
    directories.push(directory)
    const f = fixture({ store: createFileStore(directory) })
    const account = await seed(f.pool)
    await call(f.pool, 'vinted.accounts.orders.settings.save', settings)
    await f.pool.orders.tick()
    f.responses.items = [item('2')]
    f.responses.sold = true
    f.responses.barkFails = true
    f.advance()
    await f.pool.orders.tick()
    expect((await detail(f.pool, account.id)).candidates[0]).toMatchObject({
      status: 'sold',
      notifiedAt: null,
      notifyError: expect.any(String),
    })
    await f.pool.orders.stop()
    const restarted = fixture({ store: createFileStore(directory) })
    restarted.advance(60)
    restarted.responses.items = [item('2')]
    await restarted.pool.orders.tick()
    expect(restarted.responses.sent).toHaveLength(1)
    const again = fixture({ store: createFileStore(directory) })
    again.advance(90)
    again.responses.items = [item('2')]
    await again.pool.orders.tick()
    expect(again.responses.sent).toEqual([])
  })

  it('rejects invalid configuration before writing, and transfers only settings', async () => {
    const f = fixture()
    await seed(f.pool)
    await call(f.pool, 'vinted.accounts.orders.settings.save', settings)
    await f.pool.orders.tick()
    await expect(
      call(f.pool, 'vinted.accounts.orders.settings.save', {
        ...settings,
        intervalMinutes: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      call(f.pool, 'vinted.accounts.orders.settings.save', {
        ...settings,
        bark: { ...settings.bark, baseUrl: 'https://user:pass@bark.example.test' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const exported = await call(f.pool, 'configuration.export')
    expect(exported).toEqual({ schemaVersion: 1, data: settings })
    const clean = fixture()
    await call(clean.pool, 'configuration.import', exported)
    expect(await call(clean.pool, 'vinted.accounts.orders.settings.get')).toEqual(
      settings,
    )
    expect(await call(clean.pool, 'vinted.accounts.list')).toMatchObject({ items: [] })
  })

  it('reports configuration disk failure and keeps the prior saved key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-orders-config-'))
    directories.push(directory)
    const f = fixture({ store: createFileStore(directory) })
    await call(f.pool, 'vinted.accounts.orders.settings.save', settings)
    await mkdir(join(directory, 'vinted-accounts.json.tmp'))
    await expect(
      call(f.pool, 'vinted.accounts.orders.settings.save', {
        ...settings,
        bark: { ...settings.bark, deviceKey: 'replacement-key' },
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await call(f.pool, 'vinted.accounts.orders.settings.get')).toEqual(settings)
  })

  it('enrols spreadsheet imports and clears a removed homepage in the same write', async () => {
    const f = fixture()
    await call(f.pool, 'vinted.accounts.import', {
      filename: 'accounts.csv',
      text: '登录方式,账号,密码,主页链接\nemail,import@example.test,synthetic,https://vinted.fr/member/42',
    })
    await f.pool.orders.tick()
    const list = await call<{ items: AccountRecord[] }>(f.pool, 'vinted.accounts.list')
    const account = list.items[0]!
    expect(await detail(f.pool, account.id)).toMatchObject({ lastItemCount: 2 })
    await seed(f.pool, { id: account.id, account: account.account, homepageUrl: '' })
    expect((await f.store.read()).orderWatch.records).toEqual([])
  })

  it('keeps an invalid homepage visible as an error without querying it', async () => {
    const f = fixture()
    const account = await seed(f.pool, {
      homepageUrl: 'https://vinted.fr.example.test/member/42',
    })
    await f.pool.orders.tick()
    expect(await detail(f.pool, account.id)).toMatchObject({
      enabled: false,
      lastItemCount: null,
      lastError: expect.any(String),
    })
    expect((await f.store.read()).orderWatch.records).toEqual([])
    await expect(
      call(f.pool, 'vinted.accounts.orders.run', { accountId: account.id }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('does not apply account changes when queued settings are cancelled', async () => {
    const f = fixture()
    await call(f.pool, 'vinted.accounts.orders.settings.save', settings)
    let release = () => {}
    const blocked = f.store.mutate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await Promise.resolve()
    let alive = true
    const request = context('vinted.accounts.orders.settings.save', {
      ...settings,
      intervalMinutes: 5,
    })
    request.assertAlive = () => {
      if (!alive) throw new Error('cancelled')
    }
    const save = f.pool.call(request)
    const rejection = expect(save).rejects.toThrow('cancelled')
    alive = false
    release()
    await blocked
    await rejection
    expect(await call(f.pool, 'vinted.accounts.orders.settings.get')).toEqual(settings)
  })

  it('does not import queued settings after the request has been cancelled', async () => {
    const f = fixture()
    await call(f.pool, 'vinted.accounts.orders.settings.save', settings)
    let release = () => {}
    const blocked = f.store.mutate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await Promise.resolve()
    let alive = true
    const request = context('configuration.import', {
      schemaVersion: 1,
      data: { ...settings, intervalMinutes: 5 },
    })
    request.assertAlive = () => {
      if (!alive) throw new Error('cancelled import')
    }
    const save = f.pool.call(request)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const rejection = expect(save).rejects.toThrow('cancelled import')
    alive = false
    release()
    await blocked
    await rejection
    expect(await call(f.pool, 'vinted.accounts.orders.settings.get')).toEqual(settings)
  })

  it('starts existing accounts on plugin boot and stops network work on host EOF', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-orders-boot-'))
    directories.push(directory)
    const seeded = fixture({ store: createFileStore(directory) })
    const account = await seed(seeded.pool)
    const input = new PassThrough()
    const output = new PassThrough()
    const diagnostics = new PassThrough()
    let scanned = false
    let cancelled = false
    const instance = startVintedAccountsPlugin({
      storageDirectory: directory,
      input,
      output,
      diagnostics,
      orderSourceFactory: () => ({
        scan: async (_url, signal) => {
          scanned = true
          return new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                cancelled = true
                resolve([item('1')])
              },
              { once: true },
            )
          })
        },
        check: async () => ({ sold: false, error: null }),
      }),
    })
    plugins.push(instance.plugin)
    await eventually(async () => scanned)
    input.end()
    await eventually(async () => cancelled)
    await instance.plugin.orders.stop()
    expect(await detail(instance.plugin, account.id)).toMatchObject({
      running: false,
      lastItemCount: null,
    })
    instance.stop()
    input.destroy()
    output.destroy()
    diagnostics.destroy()
  })

  it('limits simultaneous scans and eventually processes other due accounts', async () => {
    const f = fixture()
    for (let index = 0; index < 5; index += 1) {
      await seed(f.pool, { account: `seller-${index}@example.test` })
    }
    let finish = () => {}
    f.responses.wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    const ticking = f.pool.orders.tick()
    await eventually(async () => {
      const result = await call<{ items: View[] }>(f.pool, 'vinted.accounts.orders.list')
      return result.items.filter((entry) => entry.running).length === 2
    })
    const busy = await call<{ items: View[] }>(f.pool, 'vinted.accounts.orders.list')
    expect(busy.items.filter((entry) => entry.running)).toHaveLength(2)
    finish()
    await ticking
    await f.pool.orders.tick()
    await f.pool.orders.tick()
    const result = await call<{ items: View[] }>(f.pool, 'vinted.accounts.orders.list')
    expect(result.items.filter((entry) => entry.lastItemCount === 2)).toHaveLength(5)
  })

  it('does not let a paused old query overwrite a later resume request', async () => {
    const f = fixture()
    const account = await seed(f.pool)
    let finish = () => {}
    f.responses.wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    const running = f.pool.orders.tick()
    await eventually(async () => (await detail(f.pool, account.id)).running)
    await call(f.pool, 'vinted.accounts.orders.enabled', {
      accountId: account.id,
      enabled: false,
    })
    await call(f.pool, 'vinted.accounts.orders.enabled', {
      accountId: account.id,
      enabled: true,
    })
    finish()
    await running
    const result = await detail(f.pool, account.id)
    expect(result.lastError).toBe(null)
    expect(result).toMatchObject({ enabled: true, nextRunAt: null })
    f.responses.wait = null
    await f.pool.orders.tick()
    expect((await detail(f.pool, account.id)).lastItemCount).toBe(2)
  })

  it('keeps the full 2000-account summary below the host message limit', async () => {
    const f = fixture()
    await f.store.mutate((document) => {
      document.accounts = Array.from({ length: 2000 }, (_, index) => ({
        id: `a${String(index).padStart(63, '0')}`,
        loginMethod: 'email',
        account: `seller-${index}@example.test`,
        password: 'synthetic',
        phone: '',
        emailOtpUrl: '',
        smsOtpUrl: '',
        note: '',
        status: 'active',
        homepageUrl: `https://www.vinted.co.uk/member/${'9'.repeat(32)}`,
        createdAt: '2026-11-11T06:00:00.000Z',
        updatedAt: '2026-11-11T06:00:00.000Z',
      }))
    })
    await f.store.mutate((document) => {
      for (const record of document.orderWatch.records) {
        record.lastError = '错'.repeat(500)
        record.lastCompleteAt = '2026-11-11T06:00:00.000Z'
        record.nextRunAt = '2026-11-11T06:30:00.000Z'
      }
    })
    const result = await call<{ items: View[] }>(f.pool, 'vinted.accounts.orders.list')
    expect(result.items).toHaveLength(2000)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024 - 1024)
    expect((await detail(f.pool, result.items[0]!.accountId)).lastError).toBe(
      '错'.repeat(500),
    )
  })

  it('retries an already confirmed Bark notification even when the next scan fails', async () => {
    const f = fixture()
    const account = await seed(f.pool)
    await call(f.pool, 'vinted.accounts.orders.settings.save', settings)
    await f.pool.orders.tick()
    f.responses.items = [item('2')]
    f.responses.sold = true
    f.responses.barkFails = true
    f.advance()
    await f.pool.orders.tick()
    expect((await detail(f.pool, account.id)).candidates[0]?.notifiedAt).toBe(null)
    f.responses.barkFails = false
    f.responses.error = new Error('Vinted unavailable')
    f.advance()
    await f.pool.orders.tick()
    expect((await detail(f.pool, account.id)).candidates[0]?.notifiedAt).toBe(
      '2026-11-11T07:00:00.000Z',
    )
    expect((await detail(f.pool, account.id)).lastError).not.toBe(null)
  })

  it('continues checking and delivering retained candidates when a new snapshot exceeds capacity', async () => {
    const f = fixture()
    const account = await seed(f.pool)
    await call(f.pool, 'vinted.accounts.orders.settings.save', settings)
    await f.pool.orders.tick()
    await f.store.mutate((document) => {
      document.orderWatch.records[0]!.candidates = Array.from(
        { length: 4000 },
        (_, index) => ({
          id: randomUUID(),
          itemId: String(1000 + index),
          itemUrl: `https://www.vinted.fr/items/${1000 + index}`,
          title: `Canvas ${1000 + index}`,
          imageUrl: null,
          lastSeenAt: '2026-11-10T06:00:00.000Z',
          missingAt: '2026-11-10T06:30:00.000Z',
          checkedAt: null,
          status: 'pending',
          checkError: null,
          notifiedAt: null,
          notifyError: null,
        }),
      )
    })
    f.responses.items = [item('2')]
    f.responses.sold = true
    f.advance()
    await f.pool.orders.tick()
    expect(f.responses.checked).toHaveLength(20)
    expect(f.responses.sent).toHaveLength(20)
    expect((await detail(f.pool, account.id)).lastItemCount).toBe(2)
    f.advance()
    await f.pool.orders.tick()
    expect((await detail(f.pool, account.id)).lastItemCount).toBe(1)
    expect((await f.store.read()).orderWatch.records[0]!.candidates).toHaveLength(4000)
  })
})

async function eventually(check: () => Promise<boolean>) {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Expected background operation did not start')
}
