import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PluginFailure } from '../domain/errors.js'
import type {
  EmailProvider,
  MailboxView,
  TokenRefresher,
  TokenSet,
} from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { createMemoryStore } from '../store/private-store.js'
import { EmailService } from './email.js'

const clientId = '00000000-0000-4000-8000-000000000001'
const initial = {
  provider: 'microsoft',
  transport: 'graph',
  email: 'owner@outlook.com',
  clientId,
  password: 'synthetic-password',
  refreshToken: 'synthetic-refresh-original',
  note: '',
  enabled: true,
}
const issued: TokenSet = {
  accessToken: 'synthetic-access',
  refreshToken: 'synthetic-rotated',
  expiresIn: 3600,
}
function context(method: string, payload: unknown = {}): DispatchContext {
  return {
    requestId: randomUUID(),
    capability: 'email.provider',
    method,
    payload,
    deadlineAt: Date.now() + 120_000,
    assertAlive() {},
    signal: new AbortController().signal,
  }
}
async function setup(refreshImpl: TokenRefresher['refresh'] = async () => issued) {
  const refresh = vi.fn(refreshImpl)
  const store = createMemoryStore()
  await store.mutate((document) => {
    document.settings.autoReceive = false
  })
  let time = new Date('2026-11-12T01:00:00.000Z')
  const provider: EmailProvider = {
    tokens: { refresh },
    mailbox: {
      list: vi.fn(async () => ({ items: [], nextCursor: null, total: 0, unread: 0 })),
      setRead: vi.fn(async () => {}),
      get: vi.fn(async () => {
        throw new Error('unused')
      }),
    },
  }
  const logger = { debug() {}, info() {}, warn: vi.fn(), error() {} }
  const providers = { get: vi.fn(() => provider) }
  const create = () => new EmailService({ store, providers, logger, now: () => time })
  const service = create()
  return {
    store,
    provider,
    providers,
    service,
    refresh,
    create,
    setTime: (value: string) => {
      time = new Date(value)
    },
    save: (patch: Record<string, unknown> = {}) =>
      service.call(
        context('email.accounts.save', { ...initial, ...patch }),
      ) as Promise<MailboxView>,
    list: () =>
      service.call(context('email.accounts.list')) as Promise<{ items: MailboxView[] }>,
  }
}

describe('email account service', () => {
  it('persists credentials but never returns them in summaries', async () => {
    const t = await setup()
    const view = await t.save()
    expect(view.status).toBe('pending')
    expect(JSON.stringify(view)).not.toContain('synthetic-')
    expect(view.hasRefreshToken).toBe(true)
    expect((await t.store.read()).accounts[0]?.refreshToken).toBe(initial.refreshToken)
    expect((await t.list()).items).toHaveLength(1)
  })

  it('skips duplicate import without overwriting the latest rotated token', async () => {
    const t = await setup()
    await t.save()
    await t.service.tick()
    const report = await t.service.call(
      context('email.accounts.import', {
        transport: 'graph',
        text: `OWNER@outlook.com----old-password----${clientId}----synthetic-old-token\nnew@hotmail.com--------${clientId}----synthetic-new-token\nmalformed`,
      }),
    )
    expect(report).toMatchObject({ total: 3, inserted: 1, skipped: 2 })
    expect((await t.store.read()).accounts[0]?.refreshToken).toBe('synthetic-rotated')
    expect(JSON.stringify(report)).not.toContain('synthetic-')
  })

  it('keeps edited credentials when blank credential fields are omitted', async () => {
    const t = await setup()
    const original = await t.save()
    await t.service.tick()
    await t.service.call(
      context('email.accounts.save', {
        id: original.id,
        provider: 'microsoft',
        transport: 'graph',
        email: initial.email,
        clientId,
        enabled: true,
        note: 'updated note',
      }),
    )
    const record = (await t.store.read()).accounts[0]!
    expect(record.refreshToken).toBe('synthetic-rotated')
    expect(record.password).toBe('synthetic-password')
    expect(record.status).toBe('active')
  })

  it('strictly sorts newest first, filters and clamps pages', async () => {
    const t = await setup()
    await t.save()
    t.setTime('2026-11-12T01:01:00.000Z')
    await t.save({ email: 'newer@hotmail.com', note: 'priority' })
    const result = await t.service.call(
      context('email.accounts.list', { page: 50, pageSize: 1, query: 'priority' }),
    )
    expect(result).toMatchObject({
      page: 1,
      total: 1,
      items: [{ email: 'newer@hotmail.com' }],
    })
  })

  it('rejects unsupported capability and preserves data on cancelled writes', async () => {
    const t = await setup()
    const bad = context('email.accounts.save', initial)
    bad.assertAlive = () => {
      throw new PluginFailure('CANCELLED', 'cancelled')
    }
    await expect(t.service.call(bad)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(
      t.service.call({ ...context('email.settings.get'), capability: 'account.pool' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect((await t.store.read()).accounts).toHaveLength(0)
  })
})

describe('durable email refresh coordination', () => {
  it('rotates token atomically, refreshes before expiry and resumes after restart', async () => {
    const t = await setup()
    await t.save()
    await t.service.tick()
    const record = (await t.store.read()).accounts[0]!
    expect(record).toMatchObject({
      refreshToken: 'synthetic-rotated',
      accessToken: 'synthetic-access',
      status: 'active',
      accessExpiresAt: '2026-11-12T02:00:00.000Z',
      nextRefreshAt: '2026-11-12T01:55:00.000Z',
      lastRotatedAt: '2026-11-12T01:00:00.000Z',
    })
    await t.service.stop()
    t.setTime('2026-11-12T01:56:00.000Z')
    const restarted = t.create()
    await restarted.tick()
    expect(t.refresh).toHaveBeenCalledTimes(2)
    expect(t.refresh.mock.calls[1]?.[0]).toMatchObject({
      refreshToken: 'synthetic-rotated',
    })
    await restarted.stop()
  })

  it('keeps refresh token and last rotation timestamp when no new token is issued', async () => {
    const t = await setup(
      vi.fn(async () => ({ accessToken: 'synthetic-access', expiresIn: 3600 })),
    )
    await t.save()
    await t.service.tick()
    expect((await t.store.read()).accounts[0]).toMatchObject({
      refreshToken: initial.refreshToken,
      lastRotatedAt: null,
      lastRefreshedAt: '2026-11-12T01:00:00.000Z',
      status: 'active',
    })
  })

  it('stops automatic retry on invalid_grant and resumes after credentials change', async () => {
    const t = await setup(
      vi.fn(async () => {
        throw new PluginFailure('AUTH_FAILED', '需要更新邮箱凭据')
      }),
    )
    const account = await t.save()
    await t.service.tick()
    expect((await t.store.read()).accounts[0]).toMatchObject({
      status: 'reauth-required',
      nextRefreshAt: null,
      refreshToken: initial.refreshToken,
      lastRefreshedAt: null,
    })
    await t.service.tick()
    expect(t.refresh).toHaveBeenCalledTimes(1)
    await t.save({ id: account.id, refreshToken: 'synthetic-replacement' })
    await t.service.tick()
    expect(t.refresh).toHaveBeenCalledTimes(2)
  })

  it('backs off transient failures and honors Retry-After without erasing success', async () => {
    const t = await setup()
    await t.save()
    await t.service.tick()
    t.refresh.mockRejectedValueOnce(
      new PluginFailure('RATE_LIMITED', '稍后重试', 300_000),
    )
    t.setTime('2026-11-12T01:56:00.000Z')
    await t.service.tick()
    expect((await t.store.read()).accounts[0]).toMatchObject({
      status: 'error',
      nextRefreshAt: '2026-11-12T02:01:00.000Z',
      lastRefreshedAt: '2026-11-12T01:00:00.000Z',
      refreshToken: 'synthetic-rotated',
    })
  })

  it.each(['AUTH_FAILED', 'PERMISSION_DENIED'] as const)(
    'does not retry %s after pausing and resuming the mailbox',
    async (code) => {
      const t = await setup(async () => {
        throw new PluginFailure(code, '请更新邮箱授权')
      })
      const account = await t.save()
      await t.service.tick()
      await t.save({ id: account.id, enabled: false })
      await t.save({ id: account.id, enabled: true })
      await t.service.tick()
      expect(t.refresh).toHaveBeenCalledTimes(1)
      expect((await t.list()).items[0]?.status).toBe('reauth-required')
    },
  )

  it('persists terminal permission failure and clears manual intent until credentials change', async () => {
    const t = await setup(async () => {
      throw new PluginFailure('PERMISSION_DENIED', '所选通道缺少权限')
    })
    const account = await t.save()
    await t.service.call(
      context('email.settings.save', {
        autoRefresh: false,
        intervalMinutes: 60,
        autoReceive: false,
        receiveIntervalMinutes: 1,
      }),
    )
    await t.service.call(context('email.refresh.queue', { ids: [account.id] }))
    await t.service.tick()
    expect((await t.store.read()).accounts[0]).toMatchObject({
      status: 'reauth-required',
      lastErrorCode: 'PERMISSION_DENIED',
      nextRefreshAt: null,
      refreshRequested: false,
    })
    await expect(
      t.service.call(
        context('email.messages.list', { accountId: account.id, folder: 'inbox' }),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await t.service.stop()
    t.setTime('2026-11-14T01:00:00.000Z')
    const restarted = t.create()
    try {
      await restarted.tick()
      expect(t.refresh).toHaveBeenCalledTimes(1)
      await restarted.call(
        context('email.accounts.save', {
          ...initial,
          id: account.id,
          refreshToken: 'synthetic-reauthorized',
        }),
      )
      await restarted.call(context('email.refresh.queue', { ids: [account.id] }))
      t.refresh.mockResolvedValueOnce(issued)
      await restarted.tick()
      expect(t.refresh).toHaveBeenCalledTimes(2)
      expect((await t.store.read()).accounts[0]).toMatchObject({
        status: 'active',
        lastErrorCode: null,
      })
    } finally {
      await restarted.stop()
    }
  })

  it('refreshes a rejected access token once and retries only a read operation', async () => {
    const t = await setup()
    const account = await t.save()
    await t.service.tick()
    t.refresh.mockResolvedValueOnce({
      accessToken: 'synthetic-fresh-access',
      refreshToken: 'synthetic-next-rotation',
      expiresIn: 3600,
    })
    vi.mocked(t.provider.mailbox.list)
      .mockRejectedValueOnce(new PluginFailure('AUTH_FAILED', '访问令牌已失效'))
      .mockResolvedValueOnce({ items: [], nextCursor: null, total: 0, unread: 0 })
    expect(
      await t.service.call(
        context('email.messages.list', { accountId: account.id, folder: 'inbox' }),
      ),
    ).toEqual({ items: [], nextCursor: null, total: 0, unread: 0 })
    expect(t.refresh).toHaveBeenCalledTimes(2)
    expect(vi.mocked(t.provider.mailbox.list).mock.calls[1]?.[0].accessToken).toBe(
      'synthetic-fresh-access',
    )
  })

  it('allows a persisted manual queue while automatic refresh is off', async () => {
    const t = await setup()
    const account = await t.save()
    await t.service.call(
      context('email.settings.save', {
        autoRefresh: false,
        intervalMinutes: 60,
        autoReceive: false,
        receiveIntervalMinutes: 1,
      }),
    )
    await t.service.tick()
    expect(t.refresh).not.toHaveBeenCalled()
    expect(
      await t.service.call(context('email.refresh.queue', { ids: [account.id] })),
    ).toEqual({ queued: 1, skipped: 0 })
    expect((await t.store.read()).accounts[0]?.refreshRequested).toBe(true)
    await t.service.tick()
    expect(t.refresh).toHaveBeenCalledTimes(1)
  })

  it('retains an interrupted manual refresh across restart with automatic refresh disabled', async () => {
    const t = await setup()
    const account = await t.save()
    await t.service.call(
      context('email.settings.save', {
        autoRefresh: false,
        intervalMinutes: 60,
        autoReceive: false,
        receiveIntervalMinutes: 1,
      }),
    )
    await t.service.call(context('email.refresh.queue', { ids: [account.id] }))
    t.refresh.mockImplementationOnce(
      async (_credentials, signal) =>
        new Promise<TokenSet>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    )
    const tick = t.service.tick()
    await vi.waitFor(() => expect(t.refresh).toHaveBeenCalledTimes(1))
    await t.service.stop()
    await tick
    expect((await t.store.read()).accounts[0]?.refreshRequested).toBe(true)
    t.setTime('2026-11-12T01:03:00.000Z')
    const restarted = t.create()
    await restarted.tick()
    expect(t.refresh).toHaveBeenCalledTimes(2)
    expect((await t.store.read()).accounts[0]?.refreshRequested).toBe(false)
    await restarted.stop()
  })

  it('deduplicates concurrent scheduled and mail-triggered refresh', async () => {
    let resolve!: (tokens: TokenSet) => void
    const t = await setup(
      vi.fn(
        () =>
          new Promise<TokenSet>((done) => {
            resolve = done
          }),
      ),
    )
    const account = await t.save()
    const tick = t.service.tick()
    await vi.waitFor(() => expect(t.refresh).toHaveBeenCalledTimes(1))
    const reading = t.service.call(
      context('email.messages.list', { accountId: account.id, folder: 'inbox' }),
    )
    resolve(issued)
    await Promise.all([tick, reading])
    expect(t.refresh).toHaveBeenCalledTimes(1)
    expect(t.provider.mailbox.list).toHaveBeenCalledTimes(1)
  })

  it('does not commit late results after credentials change or deletion', async () => {
    let resolve!: (tokens: TokenSet) => void
    const t = await setup(
      vi.fn(
        () =>
          new Promise<TokenSet>((done) => {
            resolve = done
          }),
      ),
    )
    const account = await t.save()
    const tick = t.service.tick()
    await vi.waitFor(() => expect(t.refresh).toHaveBeenCalledTimes(1))
    await t.save({ id: account.id, refreshToken: 'synthetic-edited' })
    resolve(issued)
    await tick
    expect((await t.store.read()).accounts[0]).toMatchObject({
      refreshToken: 'synthetic-edited',
      accessToken: null,
    })
    const nextTick = t.service.tick()
    await vi.waitFor(() => expect(t.refresh).toHaveBeenCalledTimes(2))
    await t.service.call(context('email.accounts.remove', { id: account.id }))
    resolve(issued)
    await nextTick
    expect((await t.store.read()).accounts).toHaveLength(0)
  })

  it('retries a rotated result after disk failure without another remote rotation', async () => {
    const t = await setup()
    await t.save()
    const mutate = t.store.mutate.bind(t.store)
    let rejectCommit = true
    vi.spyOn(t.store, 'mutate').mockImplementation(async (apply) =>
      mutate(async (document) => {
        const result = await apply(document)
        if (rejectCommit && document.accounts[0]?.accessToken !== null)
          throw new PluginFailure('UNAVAILABLE', '磁盘已满')
        return result
      }),
    )
    await t.service.tick()
    expect((await t.store.read()).accounts[0]?.refreshToken).toBe(initial.refreshToken)
    expect((await t.list()).items[0]).toMatchObject({ status: 'error' })
    rejectCommit = false
    t.setTime('2026-11-12T01:02:00.000Z')
    await t.service.tick()
    expect((await t.store.read()).accounts[0]?.refreshToken).toBe('synthetic-rotated')
    expect(t.refresh).toHaveBeenCalledTimes(1)
  })

  it('limits concurrent refreshes to two and skips paused mailboxes', async () => {
    const pending: ((tokens: TokenSet) => void)[] = []
    const t = await setup(
      vi.fn(() => new Promise<TokenSet>((done) => pending.push(done))),
    )
    await t.save()
    await t.save({ email: 'two@hotmail.com' })
    await t.save({ email: 'three@live.com' })
    await t.save({ email: 'paused@outlook.com', enabled: false })
    const tick = t.service.tick()
    await vi.waitFor(() => expect(t.refresh).toHaveBeenCalledTimes(2))
    for (const resolve of pending) resolve(issued)
    await tick
    expect(t.refresh).toHaveBeenCalledTimes(2)
    expect((await t.store.read()).accounts.find((a) => !a.enabled)?.status).toBe('paused')
  })

  it('cancels requests on shutdown and never runs a later timer', async () => {
    let refreshSignal!: AbortSignal
    const t = await setup(
      vi.fn(async (_input, signal: AbortSignal) => {
        refreshSignal = signal
        return new Promise<TokenSet>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }),
    )
    await t.save()
    const tick = t.service.tick()
    await vi.waitFor(() => expect(t.refresh).toHaveBeenCalledTimes(1))
    await t.service.stop()
    await tick
    expect(refreshSignal.aborted).toBe(true)
    await t.service.tick()
    expect(t.refresh).toHaveBeenCalledTimes(1)
  })

  it('exports only scheduler settings and leaves accounts intact on configuration import', async () => {
    const t = await setup()
    await t.save()
    expect(await t.service.call(context('configuration.export'))).toEqual({
      schemaVersion: 1,
      data: {
        autoRefresh: true,
        intervalMinutes: 60,
        autoReceive: false,
        receiveIntervalMinutes: 1,
      },
    })
    await t.service.call(
      context('configuration.import', {
        schemaVersion: 1,
        data: {
          autoRefresh: false,
          intervalMinutes: 120,
          autoReceive: true,
          receiveIntervalMinutes: 5,
        },
      }),
    )
    expect((await t.store.read()).accounts).toHaveLength(1)
  })
})
