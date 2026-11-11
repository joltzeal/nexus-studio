import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { createVintedAccountsPlugin } from '../index.js'
import { AssignedAccountAddressSchema } from '../domain/address.js'
import { AccountSaveInputSchema } from '../domain/schemas.js'
import { AccountTransferDataSchema } from '../domain/transfer.js'
import type { AccountRecord, BindingRecord } from '../domain/types.js'
import type { DispatchContext, PluginResponse } from '../rpc/protocol.js'
import { createMemoryStore } from '../store/account-store.js'
import { AccountPool } from './accounts.js'

const PAGE_SIZE = 16
const LIMIT = 1024 * 1024
const timestamp = '2026-11-12T00:00:00.000Z'
const directories: string[] = []
const instances: ReturnType<typeof createVintedAccountsPlugin>[] = []

interface Page {
  items: AccountRecord[]
  bindings: BindingRecord[]
  total: number
  page: number
  pageSize: number
  revision: string
  storageDurable: boolean
}

function account(index: number): AccountRecord {
  return {
    loginMethod: 'email',
    account: `seller-${index}@example.test`,
    password: ' synthetic password ',
    phone: '+33123456789',
    emailOtpUrl: 'https://example.test/mail',
    smsOtpUrl: 'https://example.test/sms',
    note: 'Synthetic account with an independent address snapshot.',
    status: 'active',
    homepageUrl: 'https://www.vinted.fr/member/123',
    address: {
      id: `address-${index}`,
      street: 'Rue Exemple',
      houseNumber: '12',
      city: 'Paris',
      postalCode: '75001',
      countryCode: 'FR',
      state: 'Ile-de-France',
      county: 'Paris',
      latitude: 48.8566,
      longitude: 2.3522,
      source: 'osm',
      sourceUrl: 'https://www.openstreetmap.org/node/123',
      approximate: false,
      firstName: 'Marie',
      lastName: 'Exemple',
      username: 'marie.exemple',
      linkedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    // Deliberately differs from the persisted schema's property order.
    id: `account-${index}`,
  }
}

function bindings(accounts: AccountRecord[], windowsPerAccount = 2): BindingRecord[] {
  return accounts.flatMap((entry, index) =>
    Array.from({ length: windowsPerAccount }, (_, window) => ({
      windowId: `window-${index}-${window}`,
      accountId: entry.id,
      boundAt: timestamp,
    })),
  )
}

function context(payload: unknown = {}): DispatchContext {
  return {
    requestId: 'r'.repeat(128),
    capability: 'account.pool',
    method: 'vinted.accounts.list',
    payload,
    deadlineAt: Date.now() + 10_000,
    assertAlive: () => undefined,
  }
}

function fixture() {
  const store = createMemoryStore()
  const pool = new AccountPool({
    store,
    now: () => new Date(timestamp),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })
  return {
    pool,
    store,
    list: (payload: unknown = {}) => pool.call(context(payload)) as Promise<Page>,
  }
}

function rpc(storageDirectory: string) {
  const input = new PassThrough()
  const output = new PassThrough()
  const pending = new Map<
    string,
    (value: { reply: PluginResponse<Page>; bytes: number }) => void
  >()
  let buffer = ''
  let sequence = 0
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const reply = JSON.parse(line) as PluginResponse<Page>
      pending.get(reply.requestId)?.({
        reply,
        bytes: Buffer.byteLength(`${line}\n`, 'utf8'),
      })
      pending.delete(reply.requestId)
    }
  })
  const instance = createVintedAccountsPlugin({
    storageDirectory,
    input,
    output,
    diagnostics: new PassThrough(),
  })
  instances.push(instance)
  instance.server.start()
  input.write('{"type":"handshake","protocolVersion":1}\n')
  return {
    ...instance,
    request: (payload: unknown = {}) => {
      const requestId = `${++sequence}`.padStart(128, '\u0000')
      return new Promise<{ reply: PluginResponse<Page>; bytes: number }>((resolve) => {
        pending.set(requestId, resolve)
        input.write(
          `${JSON.stringify({
            protocolVersion: 1,
            requestId,
            capability: 'account.pool',
            method: 'vinted.accounts.list',
            deadlineMs: 10_000,
            payload,
          })}\n`,
        )
      })
    },
  }
}

afterEach(async () => {
  for (const instance of instances.splice(0)) instance.stop()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('account list pagination', () => {
  it('serializes every page of 2000 complete addresses below the RPC limit and reopens the same revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-account-pages-'))
    directories.push(directory)
    const client = rpc(directory)
    const accounts = Array.from({ length: 2000 }, (_, index) => account(index))
    AccountTransferDataSchema.shape.accounts.parse(accounts)
    const allBindings = bindings(accounts)
    await client.store.mutate((document) => {
      document.accounts = accounts
      document.bindings = allBindings
    })
    expect(
      Buffer.byteLength(JSON.stringify({ items: accounts, bindings: allBindings })),
    ).toBeGreaterThan(LIMIT)
    const collected: AccountRecord[] = []
    const collectedBindings: BindingRecord[] = []
    let revision: string | undefined
    for (let page = 1; page <= Math.ceil(2000 / PAGE_SIZE); page += 1) {
      const { reply, bytes } = await client.request(
        page === 1 ? {} : { page, pageSize: PAGE_SIZE, revision },
      )
      expect(reply.ok).toBe(true)
      expect(bytes).toBeLessThan(LIMIT)
      const result = reply.result!
      revision ??= result.revision
      expect(result).toMatchObject({
        page,
        pageSize: PAGE_SIZE,
        total: 2000,
        revision,
        storageDurable: true,
      })
      const ids = new Set(result.items.map((entry) => entry.id))
      expect(result.bindings.every((entry) => ids.has(entry.accountId))).toBe(true)
      collected.push(...result.items)
      collectedBindings.push(...result.bindings)
    }
    expect(collected).toEqual(accounts)
    expect(collectedBindings).toEqual(allBindings)
    client.stop()
    const reopened = rpc(directory)
    const first = await reopened.request({ revision })
    expect(first.reply.ok).toBe(true)
    expect(first.reply.result?.revision).toBe(revision)
    expect(first.reply.result?.items).toEqual(accounts.slice(0, PAGE_SIZE))
    const last = await reopened.request({ page: 125, revision })
    expect(last.reply.ok).toBe(true)
    expect(last.reply.result?.items).toEqual(accounts.slice(-PAGE_SIZE))
    expect(last.bytes).toBeLessThan(LIMIT)
  })

  it.each(['unicode', 'escaped'] as const)(
    'keeps maximum-length %s fields and several bindings per account within the byte budget',
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), 'nexus-account-page-bytes-'))
      directories.push(directory)
      const client = rpc(directory)
      const text = (length: number) =>
        kind === 'unicode'
          ? '\u6c49'.repeat(length)
          : `${'\u0000'.repeat(length - 4)}"\\\n\u0000`
      const longTimestamp = `2026-11-12T00:00:00.${'0'.repeat(43)}Z`
      const accounts = Array.from({ length: 50 }, (_, index) => {
        const entry = account(index)
        const fields = AccountSaveInputSchema.parse({
          id: `${index}`.padEnd(64, text(64)),
          loginMethod: entry.loginMethod,
          account: `${index}`.padEnd(190, text(190)),
          password: text(190),
          phone: text(40),
          emailOtpUrl: text(2048),
          smsOtpUrl: text(2048),
          homepageUrl: text(2048),
          note: text(200),
          status: entry.status,
        })
        return {
          ...fields,
          id: fields.id!,
          createdAt: longTimestamp,
          updatedAt: longTimestamp,
          address: AssignedAccountAddressSchema.parse({
            id: `${index}`.padEnd(64, text(64)),
            street: text(200),
            houseNumber: text(32),
            city: text(120),
            postalCode: text(16),
            countryCode: 'FR',
            state: text(120),
            county: text(120),
            latitude: 48.8566,
            longitude: 2.3522,
            source: 'osm',
            sourceUrl: text(2048),
            approximate: false,
            firstName: text(80),
            lastName: text(80),
            username: 'a'.repeat(20),
            linkedAt: longTimestamp,
          }),
        }
      })
      const allBindings = bindings(accounts, 4).map((binding) => ({
        ...binding,
        windowId: binding.windowId.padEnd(64, text(64)),
        boundAt: longTimestamp,
      }))
      await client.store.mutate((document) => {
        document.accounts = accounts
        document.bindings = allBindings
      })
      expect(
        Buffer.byteLength(JSON.stringify({ items: accounts, bindings: allBindings })),
      ).toBeGreaterThan(LIMIT)
      let revision: string | undefined
      let count = 0
      for (let page = 1; page <= 4; page += 1) {
        const { reply, bytes } = await client.request({ page, revision })
        expect(reply.ok).toBe(true)
        expect(bytes).toBeLessThan(LIMIT)
        revision ??= reply.result!.revision
        count += reply.result!.items.length
        expect(reply.result!.bindings).toHaveLength(reply.result!.items.length * 4)
      }
      expect(count).toBe(50)
    },
  )

  it.each(['credentials', 'address', 'bindings', 'order'] as const)(
    'refuses a stale revision after changing %s, including changes outside the requested page',
    async (change) => {
      const f = fixture()
      await f.store.mutate((document) => {
        document.accounts = [account(0), account(1), account(2)]
        document.bindings = bindings(document.accounts)
      })
      const first = await f.list({ pageSize: 1 })
      await f.store.mutate((document) => {
        if (change === 'credentials') document.accounts[2]!.password = 'rotated'
        if (change === 'address') document.accounts[2]!.address = null
        if (change === 'bindings') document.bindings.pop()
        if (change === 'order') document.accounts.reverse()
      })
      await expect(
        f.list({ page: 2, pageSize: 1, revision: first.revision }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      const fresh = await f.list({ pageSize: 1 })
      expect(fresh.revision).not.toBe(first.revision)
    },
  )

  it('keeps a revision stable when only order-watch settings change', async () => {
    const f = fixture()
    const first = await f.list()
    await f.store.mutate((document) => {
      document.orderWatch.settings.intervalMinutes = 60
    })
    expect(await f.list({ revision: first.revision })).toEqual(first)
  })

  it('honors smaller pages and returns no foreign bindings on an out-of-range page', async () => {
    const f = fixture()
    await f.store.mutate((document) => {
      document.accounts = [account(0), account(1), account(2)]
      document.bindings = bindings(document.accounts)
    })
    const first = await f.list({ pageSize: 2 })
    expect(first.items.map((entry) => entry.id)).toEqual(['account-0', 'account-1'])
    const second = await f.list({ page: 2, pageSize: 2, revision: first.revision })
    expect(second.items.map((entry) => entry.id)).toEqual(['account-2'])
    expect(second.bindings.map((entry) => entry.windowId)).toEqual([
      'window-2-0',
      'window-2-1',
    ])
    expect(await f.list({ page: 100, revision: first.revision })).toMatchObject({
      items: [],
      bindings: [],
      total: 3,
      page: 100,
      pageSize: PAGE_SIZE,
      revision: first.revision,
    })
  })

  it('reports an oversized page explicitly instead of sending an oversized success line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-account-page-overflow-'))
    directories.push(directory)
    const client = rpc(directory)
    await client.store.mutate((document) => {
      document.accounts = [account(0)]
      document.bindings = bindings(document.accounts, 20_000)
    })
    const { reply, bytes } = await client.request()
    expect(reply).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(reply.error?.message).toMatch(/过大|上限/)
    expect(reply).not.toHaveProperty('result')
    expect(bytes).toBeLessThan(LIMIT)
  })

  it.each([
    null,
    { page: 0 },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { pageSize: 0 },
    { pageSize: 17 },
    { pageSize: 51 },
    { revision: '' },
    { revision: 12 },
    { revision: 'x'.repeat(129) },
    { unknown: true },
  ])('rejects malformed or unbounded list inputs: %j', async (input) => {
    await expect(fixture().list(input)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})
