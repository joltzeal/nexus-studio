import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { cancelled } from '../domain/errors.js'
import type { AccountRecord } from '../domain/types.js'
import { createVintedAccountsPlugin } from '../index.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import {
  createFileStore,
  createMemoryStore,
  type AccountStore,
} from '../store/account-store.js'
import { ACCOUNT_METHODS, AccountPool } from './accounts.js'

const directories: string[] = []
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'account-detach-'))
  directories.push(value)
  return value
}

function context(method: string, payload: unknown): DispatchContext {
  return {
    requestId: `req-${method}`,
    capability: 'account.pool',
    method,
    payload,
    deadlineAt: Date.now() + 1000,
    assertAlive: () => undefined,
  }
}

function call(pool: AccountPool, method: string, payload: unknown) {
  return pool.call(context(method, payload))
}

async function seed(store: AccountStore) {
  const pool = new AccountPool({ store, logger })
  const saved = (await call(pool, 'vinted.accounts.save', {
    loginMethod: 'email',
    account: 'detach@example.test',
    password: 'keep-password',
    phone: '+33 123456',
    emailOtpUrl: 'https://mail.example.test/inbox',
    smsOtpUrl: 'https://sms.example.test/inbox',
    note: 'keep this account',
    status: 'limited',
    homepageUrl: 'https://vinted.fr/member/42',
  })) as { item: AccountRecord }
  for (const windowId of ['delete-me', 'keep-me']) {
    await call(pool, 'vinted.accounts.bind', {
      accountId: saved.item.id,
      windowId,
      confirmDuplicates: true,
    })
  }
  return pool
}

describe('account pool window.detach', () => {
  it('advertises the lifecycle hook and keeps the business unbind method live', async () => {
    expect(ACCOUNT_METHODS).toContain('window.detach')
    expect(ACCOUNT_METHODS).toContain('vinted.accounts.unbind')
    const store = createMemoryStore()
    const pool = await seed(store)
    expect(await call(pool, 'vinted.accounts.unbind', { windowId: 'delete-me' })).toEqual(
      {
        windowId: 'delete-me',
        unbound: true,
      },
    )
    expect(await call(pool, 'window.detach', { windowId: 'keep-me' })).toEqual({
      windowId: 'keep-me',
      unbound: true,
    })
    expect((await store.read()).accounts).toHaveLength(1)
  })

  it('only removes the selected binding and reports repeated cleanup as unbound=false', async () => {
    const store = createMemoryStore()
    const pool = await seed(store)
    const before = await store.read()
    expect(await call(pool, 'window.detach', { windowId: 'delete-me' })).toEqual({
      windowId: 'delete-me',
      unbound: true,
    })
    expect(await store.read()).toEqual({
      ...before,
      bindings: before.bindings.filter((binding) => binding.windowId !== 'delete-me'),
    })
    expect(await call(pool, 'window.detach', { windowId: 'delete-me' })).toEqual({
      windowId: 'delete-me',
      unbound: false,
    })
    expect(await call(pool, 'window.detach', { windowId: 'never-bound' })).toEqual({
      windowId: 'never-bound',
      unbound: false,
    })
    expect((await store.read()).accounts).toEqual(before.accounts)
  })

  it('persists only the binding removal and retries safely after reopening storage', async () => {
    const storage = await directory()
    const store = createFileStore(storage)
    const pool = await seed(store)
    const before = await store.read()
    await call(pool, 'window.detach', { windowId: 'delete-me' })
    const reopened = createFileStore(storage)
    expect(await reopened.read()).toEqual({
      ...before,
      bindings: before.bindings.filter((binding) => binding.windowId !== 'delete-me'),
    })
    const restarted = new AccountPool({ store: reopened, logger })
    expect(await call(restarted, 'window.detach', { windowId: 'delete-me' })).toEqual({
      windowId: 'delete-me',
      unbound: false,
    })
  })

  it('reports failed persistence and keeps the old binding so a later retry can finish', async () => {
    const storage = await directory()
    const store = createFileStore(storage)
    const pool = await seed(store)
    const before = await store.read()
    const file = join(storage, 'vinted-accounts.json')
    const persisted = await readFile(file, 'utf8')
    await mkdir(`${file}.tmp`)
    await expect(
      call(pool, 'window.detach', { windowId: 'delete-me' }),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(await store.read()).toEqual(before)
    expect(await readFile(file, 'utf8')).toBe(persisted)
    await rm(`${file}.tmp`, { recursive: true })
    expect(await call(pool, 'window.detach', { windowId: 'delete-me' })).toEqual({
      windowId: 'delete-me',
      unbound: true,
    })
  })

  it.each(['window.detach', 'vinted.accounts.unbind'])(
    'does not change bindings when a queued %s call is cancelled',
    async (method) => {
      const store = createMemoryStore()
      const pool = await seed(store)
      const before = await store.read()
      let release: () => void = () => undefined
      const queued = store.mutate(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      )
      await Promise.resolve()
      let alive = true
      const request = context(method, { windowId: 'delete-me' })
      request.assertAlive = () => {
        if (!alive) throw cancelled()
      }
      const detached = pool.call(request)
      const rejected = expect(detached).rejects.toMatchObject({ code: 'CANCELLED' })
      alive = false
      release()
      await queued
      await rejected
      expect(await store.read()).toEqual(before)
    },
  )

  it.each([
    null,
    {},
    { windowId: 1 },
    { windowId: '' },
    { windowId: ' ' },
    { windowId: 'delete-me', deleteAccount: true },
  ])('rejects malformed lifecycle input before changing storage: %j', async (payload) => {
    const store = createMemoryStore()
    const pool = await seed(store)
    const before = await store.read()
    await expect(call(pool, 'window.detach', payload)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(await store.read()).toEqual(before)
  })

  it('advertises and dispatches the hook over the plugin protocol', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const diagnostics = new PassThrough()
    const plugin = createVintedAccountsPlugin({ input, output, diagnostics })
    const messages: Record<string, unknown>[] = []
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split('\n')) {
        messages.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
    try {
      await seed(plugin.store)
      plugin.server.start()
      input.write('{"type":"handshake","protocolVersion":1}\n')
      expect(messages.find((message) => message['type'] === 'ready')).toMatchObject({
        capabilities: ['account.pool'],
        methods: expect.arrayContaining(['window.detach', 'vinted.accounts.unbind']),
      })
      const request = (
        requestId: string,
        payload: unknown,
        capability = 'account.pool',
      ) => {
        input.write(
          `${JSON.stringify({
            protocolVersion: 1,
            requestId,
            capability,
            method: 'window.detach',
            payload,
            deadlineMs: 1000,
          })}\n`,
        )
      }
      request('detach-1', { windowId: 'delete-me' })
      await expect
        .poll(() => messages.find((message) => message['requestId'] === 'detach-1'))
        .toEqual({
          protocolVersion: 1,
          requestId: 'detach-1',
          ok: true,
          result: { windowId: 'delete-me', unbound: true },
        })
      request('detach-2', { windowId: 'delete-me' })
      await expect
        .poll(() => messages.find((message) => message['requestId'] === 'detach-2'))
        .toMatchObject({
          ok: true,
          result: { windowId: 'delete-me', unbound: false },
        })
      request('invalid', { windowId: 'keep-me', deleteAccount: true })
      await expect
        .poll(() => messages.find((message) => message['requestId'] === 'invalid'))
        .toMatchObject({
          ok: false,
          error: { code: 'INVALID_REQUEST' },
        })
      request('denied', { windowId: 'keep-me' }, 'proxy.provider')
      expect(messages.find((message) => message['requestId'] === 'denied')).toMatchObject(
        {
          ok: false,
          error: { code: 'PERMISSION_DENIED' },
        },
      )
      expect(
        (await plugin.store.read()).bindings.map((binding) => binding.windowId),
      ).toEqual(['keep-me'])
    } finally {
      plugin.stop()
      input.destroy()
      output.destroy()
      diagnostics.destroy()
    }
  })
})
