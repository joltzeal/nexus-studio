import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PluginFailure } from '../domain/errors.js'
import type {
  EmailProvider,
  MailboxView,
  MailMessage,
  MailMessagePage,
  MailReadInput,
} from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import {
  createFileStore,
  createMemoryStore,
  type EmailStore,
} from '../store/private-store.js'
import { EmailService } from './email.js'

const initial = {
  provider: 'microsoft',
  transport: 'graph',
  email: 'fixture@example.test',
  clientId: '00000000-0000-4000-8000-000000000001',
  refreshToken: 'synthetic-refresh',
  password: 'synthetic-password',
  enabled: true,
  note: '',
}
const context = (method: string, payload: unknown = {}): DispatchContext => ({
  requestId: randomUUID(),
  capability: 'email.provider',
  method,
  payload,
  deadlineAt: Date.now() + 120_000,
  assertAlive() {},
  signal: new AbortController().signal,
})
const mail = (id: string, isRead = false): MailMessage => ({
  id,
  isRead,
  subject: id,
  from: { name: 'Sender', address: 'sender@example.test' },
  receivedAt: '2026-11-12T00:50:00.000Z',
  hasAttachments: false,
  preview: 'Text',
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(store: EmailStore = createMemoryStore()) {
  let clock = new Date('2026-11-12T01:00:00.000Z')
  const flags = new Map([
    ['one', false],
    ['two', false],
    ['three', true],
  ])
  const provider: EmailProvider = {
    tokens: {
      refresh: vi.fn(async () => ({ accessToken: 'synthetic-access', expiresIn: 3600 })),
    },
    mailbox: {
      list: vi.fn(async (_session, input): Promise<MailMessagePage> => {
        const items =
          input.folder === 'inbox' ? [...flags].map(([id, read]) => mail(id, read)) : []
        return {
          items: items.filter(
            (item) =>
              !input.readState ||
              input.readState === 'all' ||
              item.isRead === (input.readState === 'read'),
          ),
          nextCursor: null,
          total: items.length,
          unread: items.filter((item) => !item.isRead).length,
        }
      }),
      get: vi.fn(async () => ({
        ...mail('one'),
        to: [],
        body: 'Text',
        html: '<p>Text</p>',
        truncated: false,
      })),
      setRead: vi.fn(async (_session, input: MailReadInput) => {
        flags.set(input.messageId, input.isRead)
      }),
    },
  }
  const providers = { get: () => provider }
  const logger = { debug() {}, info() {}, warn: vi.fn(), error() {} }
  const create = () => new EmailService({ store, providers, logger, now: () => clock })
  const service = create()
  const call = (method: string, payload: unknown = {}) =>
    service.call(context(method, payload))
  const save = (patch: Record<string, unknown> = {}) =>
    call('email.accounts.save', { ...initial, ...patch }) as Promise<MailboxView>
  const account = await save()
  const prepare = async (id: string) =>
    store.mutate((document) => {
      const entry = document.accounts.find((item) => item.id === id)!
      entry.accessToken = 'synthetic-access'
      entry.accessExpiresAt = '2026-11-13T01:00:00.000Z'
      entry.nextRefreshAt = '2026-11-13T00:55:00.000Z'
      entry.status = 'active'
    })
  await prepare(account.id)
  return {
    account,
    service,
    store,
    provider,
    create,
    call,
    save,
    prepare,
    flags,
    logger,
    advance: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * 60_000)
    },
    get: () => call('email.accounts.get', { id: account.id }) as Promise<MailboxView>,
    settings: (patch: Record<string, unknown>) =>
      call('email.settings.save', {
        autoRefresh: false,
        intervalMinutes: 60,
        autoReceive: true,
        receiveIntervalMinutes: 1,
        ...patch,
      }),
  }
}

describe('independent scheduled reception', () => {
  it('runs without an open page and stops its independent timer', async () => {
    vi.useFakeTimers()
    const t = await setup()
    try {
      t.service.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(t.provider.mailbox.list).toHaveBeenCalledTimes(2)
      t.advance(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(t.provider.mailbox.list).toHaveBeenCalledTimes(4)
      await t.service.stop()
      t.advance(10)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(t.provider.mailbox.list).toHaveBeenCalledTimes(4)
      expect(t.provider.tokens.refresh).not.toHaveBeenCalled()
    } finally {
      await t.service.stop()
      vi.useRealTimers()
    }
  })

  it('records a bounded timeout for an uncooperative provider without losing manual intent', async () => {
    const t = await setup()
    await t.settings({ autoReceive: false })
    await t.call('email.receive.queue', { ids: [t.account.id] })
    const timeout = new AbortController()
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    vi.mocked(t.provider.mailbox.list).mockImplementationOnce(
      async () => new Promise(() => {}),
    )
    try {
      const tick = t.service.tick()
      await vi.waitFor(() => expect(t.provider.mailbox.list).toHaveBeenCalledTimes(1))
      expect(deadline).toHaveBeenCalledWith(120_000)
      timeout.abort(new DOMException('private timeout details', 'TimeoutError'))
      await tick
      expect((await t.get()).reception).toMatchObject({
        lastCheckedAt: null,
        lastErrorCode: 'TIMEOUT',
        nextCheckAt: '2026-11-12T01:01:00.000Z',
      })
      expect((await t.store.read()).accounts[0]?.receiveRequested).toBe(true)
      expect(JSON.stringify(await t.get())).not.toContain('private timeout')
    } finally {
      deadline.mockRestore()
      await t.service.stop()
    }
  })

  it('defaults to every minute, reads both folders and atomically records real counts', async () => {
    const t = await setup()
    expect(await t.call('email.settings.get')).toMatchObject({
      autoReceive: true,
      receiveIntervalMinutes: 1,
    })
    await t.service.tick()
    expect(t.provider.mailbox.list).toHaveBeenCalledTimes(2)
    expect(t.provider.tokens.refresh).not.toHaveBeenCalled()
    expect((await t.get()).reception).toEqual({
      inbox: { total: 3, unread: 2 },
      junkemail: { total: 0, unread: 0 },
      lastCheckedAt: '2026-11-12T01:00:00.000Z',
      nextCheckAt: '2026-11-12T01:01:00.000Z',
      latestReceivedAt: '2026-11-12T00:50:00.000Z',
      lastError: null,
      lastErrorCode: null,
    })
    await t.service.tick()
    expect(t.provider.mailbox.list).toHaveBeenCalledTimes(2)
    t.advance(1)
    await t.service.tick()
    expect(t.provider.mailbox.list).toHaveBeenCalledTimes(4)
  })

  it('persists manual intent with auto receive off and executes it after restart', async () => {
    const t = await setup()
    await t.settings({ autoReceive: false })
    await t.service.tick()
    expect(t.provider.mailbox.list).not.toHaveBeenCalled()
    expect(await t.call('email.receive.queue', { ids: [t.account.id] })).toEqual({
      queued: 1,
      skipped: 0,
    })
    expect((await t.store.read()).accounts[0]?.receiveRequested).toBe(true)
    await t.service.stop()
    const restarted = t.create()
    try {
      await restarted.tick()
      expect(t.provider.mailbox.list).toHaveBeenCalledTimes(2)
      expect((await t.store.read()).accounts[0]?.receiveRequested).toBe(false)
    } finally {
      await restarted.stop()
    }
  })

  it('restores queued reception through a fresh file store with automatic reception disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-email-reception-'))
    const t = await setup(createFileStore(directory))
    let restarted: EmailService | undefined
    try {
      await t.settings({ autoReceive: false })
      await t.call('email.receive.queue', { ids: [t.account.id] })
      await t.service.stop()
      const store = createFileStore(directory)
      expect((await store.read()).accounts[0]?.receiveRequested).toBe(true)
      restarted = new EmailService({
        store,
        providers: { get: () => t.provider },
        logger: t.logger,
        now: () => new Date('2026-11-12T01:00:00.000Z'),
      })
      await restarted.tick()
      expect((await createFileStore(directory).read()).accounts[0]).toMatchObject({
        receiveRequested: false,
        reception: {
          inbox: { total: 3, unread: 2 },
          junkemail: { total: 0, unread: 0 },
          lastCheckedAt: '2026-11-12T01:00:00.000Z',
          nextCheckAt: null,
        },
      })
    } finally {
      await t.service.stop()
      await restarted?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not alter token refresh timing when reception settings change', async () => {
    const t = await setup()
    const before = (await t.store.read()).accounts[0]!.nextRefreshAt
    await t.settings({ autoReceive: false, receiveIntervalMinutes: 60 })
    expect((await t.store.read()).accounts[0]!.nextRefreshAt).toBe(before)
    for (const interval of [0, 61, 1.5]) {
      await expect(
        t.settings({ receiveIntervalMinutes: interval }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
  })

  it('shares a single reception flight and limits simultaneous accounts to two with fairness', async () => {
    const t = await setup()
    const second = await t.save({ email: 'second@example.test' })
    const third = await t.save({ email: 'third@example.test' })
    await t.prepare(second.id)
    await t.prepare(third.id)
    const gate = deferred<MailMessagePage>()
    vi.mocked(t.provider.mailbox.list).mockImplementation(async () => gate.promise)
    const tick = t.service.tick()
    await vi.waitFor(() => expect(t.provider.mailbox.list).toHaveBeenCalledTimes(2))
    expect((await t.get()).receiving).toBe(true)
    await t.service.tick()
    expect(await t.call('email.receive.queue', { ids: [t.account.id] })).toEqual({
      queued: 0,
      skipped: 1,
    })
    expect(t.provider.mailbox.list).toHaveBeenCalledTimes(2)
    gate.resolve({ items: [], nextCursor: null, total: 0, unread: 0 })
    await tick
    expect(t.provider.mailbox.list).toHaveBeenCalledTimes(4)
    await t.service.tick()
    expect(t.provider.mailbox.list).toHaveBeenCalledTimes(6)
    expect(
      (await t.store.read()).accounts.every(
        (item) => item.reception.lastCheckedAt !== null,
      ),
    ).toBe(true)
  })

  it('preserves confirmed counts on failure and persists bounded backoff through restart', async () => {
    const t = await setup()
    await t.service.tick()
    t.advance(1)
    vi.mocked(t.provider.mailbox.list).mockRejectedValueOnce(
      new PluginFailure('RATE_LIMITED', 'private server body', 300_000),
    )
    await t.service.tick()
    expect((await t.get()).reception).toMatchObject({
      inbox: { total: 3, unread: 2 },
      lastErrorCode: 'RATE_LIMITED',
      lastCheckedAt: '2026-11-12T01:00:00.000Z',
      nextCheckAt: '2026-11-12T01:06:00.000Z',
    })
    expect(JSON.stringify(await t.get())).not.toContain('private server body')
    await t.service.stop()
    const restarted = t.create()
    try {
      await restarted.tick()
      expect(t.provider.mailbox.list).toHaveBeenCalledTimes(3)
      t.advance(5)
      await restarted.tick()
      expect(t.provider.mailbox.list).toHaveBeenCalledTimes(5)
    } finally {
      await restarted.stop()
    }
  })

  it('preserves both folder counts if junk fails after a successful inbox response', async () => {
    const t = await setup()
    await t.service.tick()
    const before = (await t.get()).reception
    t.advance(1)
    vi.mocked(t.provider.mailbox.list)
      .mockResolvedValueOnce({ items: [], nextCursor: null, total: 100, unread: 90 })
      .mockRejectedValueOnce(new PluginFailure('UNAVAILABLE', 'private junk response'))
    await t.service.tick()
    expect((await t.get()).reception).toMatchObject({
      inbox: before.inbox,
      junkemail: before.junkemail,
      lastCheckedAt: before.lastCheckedAt,
      lastErrorCode: 'UNAVAILABLE',
    })
  })

  it.each(['AUTH_FAILED', 'PERMISSION_DENIED'] as const)(
    'stops repeated reception after %s until credentials change',
    async (code) => {
      const t = await setup()
      vi.mocked(t.provider.mailbox.list).mockRejectedValueOnce(
        new PluginFailure(code, 'private body'),
      )
      if (code === 'AUTH_FAILED')
        vi.mocked(t.provider.mailbox.list).mockRejectedValueOnce(
          new PluginFailure(code, 'private body'),
        )
      await t.service.tick()
      expect((await t.get()).reception).toMatchObject({
        lastErrorCode: code,
        nextCheckAt: null,
      })
      await t.save({ id: t.account.id, enabled: false })
      await t.save({ id: t.account.id, enabled: true })
      t.advance(100)
      await t.service.tick()
      expect(t.provider.mailbox.list).toHaveBeenCalledTimes(
        code === 'AUTH_FAILED' ? 2 : 1,
      )
      await t.save({ id: t.account.id, refreshToken: 'synthetic-new-credential' })
      await t.prepare(t.account.id)
      await t.service.tick()
      expect((await t.get()).reception.lastErrorCode).toBeNull()
    },
  )

  it.each(['pause', 'credentials', 'transport', 'remove'] as const)(
    'rejects stale results after %s',
    async (change) => {
      const t = await setup()
      const gate = deferred<MailMessagePage>()
      vi.mocked(t.provider.mailbox.list).mockImplementationOnce(async () => gate.promise)
      const tick = t.service.tick()
      await vi.waitFor(() => expect(t.provider.mailbox.list).toHaveBeenCalledTimes(1))
      if (change === 'remove') await t.call('email.accounts.remove', { id: t.account.id })
      else
        await t.save({
          id: t.account.id,
          ...(change === 'pause'
            ? { enabled: false }
            : change === 'transport'
              ? { transport: 'imap' }
              : { refreshToken: 'synthetic-changed' }),
        })
      await tick
      gate.resolve({ items: [mail('stale')], nextCursor: null, total: 999, unread: 999 })
      await Promise.resolve()
      const records = (await t.store.read()).accounts
      expect(records[0]?.reception.inbox ?? null).toBeNull()
      if (change === 'remove') expect(records).toHaveLength(0)
    },
  )

  it('cancels on stop without accepting late network data and retains interrupted manual intent', async () => {
    const t = await setup()
    await t.settings({ autoReceive: false })
    await t.call('email.receive.queue', { ids: [t.account.id] })
    const gate = deferred<MailMessagePage>()
    let requestSignal: AbortSignal | undefined
    vi.mocked(t.provider.mailbox.list).mockImplementationOnce(
      async (_session, _input, signal) => {
        requestSignal = signal
        return gate.promise
      },
    )
    const tick = t.service.tick()
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    await t.service.stop()
    await tick
    expect(requestSignal?.aborted).toBe(true)
    gate.resolve({ items: [], nextCursor: null, total: 0, unread: 0 })
    await Promise.resolve()
    expect((await t.store.read()).accounts[0]).toMatchObject({
      receiveRequested: true,
      reception: { inbox: null, lastCheckedAt: null },
    })
  })

  it('does not claim saved counts on disk failure or spin on repeated ticks', async () => {
    const t = await setup()
    const mutate = t.store.mutate.bind(t.store)
    let broken = true
    vi.spyOn(t.store, 'mutate').mockImplementation(async (apply) =>
      mutate(async (document) => {
        const result = await apply(document)
        if (broken && document.accounts[0]?.reception.lastCheckedAt)
          throw new PluginFailure('UNAVAILABLE', 'disk full')
        return result
      }),
    )
    await t.service.tick()
    expect((await t.store.read()).accounts[0]?.reception.inbox).toBeNull()
    await t.service.tick()
    expect(t.provider.mailbox.list).toHaveBeenCalledTimes(2)
    broken = false
    t.advance(1)
    await t.service.tick()
    expect((await t.store.read()).accounts[0]?.reception.inbox).toEqual({
      total: 3,
      unread: 2,
    })
  })
})

describe('email projections and read receipts', () => {
  it('partitions a read batch when token acquisition fails before any message write', async () => {
    const t = await setup()
    await t.store.mutate((document) => {
      document.accounts[0]!.accessToken = null
      document.accounts[0]!.accessExpiresAt = null
    })
    vi.mocked(t.provider.tokens.refresh).mockRejectedValueOnce(
      new PluginFailure('AUTH_FAILED', 'private authorization details'),
    )
    expect(
      await t.call('email.messages.read', {
        accountId: t.account.id,
        folder: 'inbox',
        messageIds: ['one', 'two'],
        isRead: false,
      }),
    ).toEqual({
      updatedIds: [],
      failures: ['one', 'two'].map((messageId) => ({ messageId, code: 'AUTH_FAILED' })),
      isRead: false,
    })
    expect(t.provider.mailbox.setRead).not.toHaveBeenCalled()
    expect((await t.get()).reception.inbox).toBeNull()
    expect(JSON.stringify(await t.get())).not.toContain('private authorization details')
  })

  it('keeps counts from the last success when recounting after a confirmed write fails', async () => {
    const t = await setup()
    await t.service.tick()
    vi.mocked(t.provider.mailbox.list).mockRejectedValueOnce(
      new PluginFailure('UNAVAILABLE', 'private count response'),
    )
    expect(
      await t.call('email.messages.read', {
        accountId: t.account.id,
        folder: 'inbox',
        messageIds: ['one'],
        isRead: true,
      }),
    ).toEqual({ updatedIds: ['one'], failures: [], isRead: true })
    expect((await t.get()).reception.inbox).toEqual({ total: 3, unread: 2 })
  })

  it('returns a single credential-free view and paginated minimal targets', async () => {
    const t = await setup()
    await t.save({ email: 'other@example.test' })
    const view = await t.get()
    expect(view).toMatchObject({ id: t.account.id, receiving: false })
    expect(JSON.stringify(view)).not.toMatch(
      /synthetic-|accessToken|refreshToken|password/,
    )
    const targets = await t.call('email.accounts.targets', {
      query: 'FIXTURE',
      page: 5,
      pageSize: 1,
    })
    expect(targets).toEqual({
      items: [
        { id: t.account.id, email: initial.email, enabled: true, status: 'active' },
      ],
      total: 1,
      page: 1,
      pageSize: 1,
      storageDurable: false,
    })
    await expect(
      t.call('email.accounts.targets', { pageSize: 51 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('returns only confirmed successes and safe per-message partial failures', async () => {
    const t = await setup()
    await t.service.tick()
    vi.mocked(t.provider.mailbox.setRead)
      .mockImplementationOnce(async (_session, input) => {
        t.flags.set(input.messageId, input.isRead)
      })
      .mockRejectedValueOnce(
        new PluginFailure('PERMISSION_DENIED', 'private provider response'),
      )
    expect(
      await t.call('email.messages.read', {
        accountId: t.account.id,
        folder: 'inbox',
        messageIds: ['one', 'two'],
        isRead: true,
      }),
    ).toEqual({
      updatedIds: ['one'],
      failures: [{ messageId: 'two', code: 'PERMISSION_DENIED' }],
      isRead: true,
    })
    expect((await t.get()).reception.inbox).toEqual({ total: 3, unread: 1 })
    expect(t.flags.get('two')).toBe(false)
    expect((await t.get()).status).toBe('active')
    t.advance(1)
    await t.service.tick()
    expect((await t.get()).reception.lastErrorCode).toBeNull()
  })

  it('does not change counts or reception authorization after every write is forbidden', async () => {
    const t = await setup()
    await t.service.tick()
    const reception = (await t.get()).reception
    vi.mocked(t.provider.mailbox.setRead).mockRejectedValue(
      new PluginFailure('PERMISSION_DENIED', 'write scope required'),
    )
    const result = await t.call('email.messages.read', {
      accountId: t.account.id,
      folder: 'inbox',
      messageIds: ['one', 'two'],
      isRead: true,
    })
    expect(result).toEqual({
      updatedIds: [],
      failures: ['one', 'two'].map((messageId) => ({
        messageId,
        code: 'PERMISSION_DENIED',
      })),
      isRead: true,
    })
    expect((await t.get()).reception).toEqual(reception)
  })

  it('rejects duplicate or oversized reception/read requests without provider side effects', async () => {
    const t = await setup()
    await expect(
      t.call('email.receive.queue', { ids: [t.account.id, t.account.id] }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    for (const messageIds of [
      ['one', 'one'],
      [],
      Array.from({ length: 21 }, (_, index) => `${index}`),
    ]) {
      await expect(
        t.call('email.messages.read', {
          accountId: t.account.id,
          folder: 'inbox',
          messageIds,
          isRead: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(t.provider.mailbox.setRead).not.toHaveBeenCalled()
  })

  it('invalidates an in-flight read-state request across pause and re-enable', async () => {
    const t = await setup()
    const gate = deferred<void>()
    vi.mocked(t.provider.mailbox.setRead).mockImplementationOnce(async () => gate.promise)
    const write = t
      .call('email.messages.read', {
        accountId: t.account.id,
        folder: 'inbox',
        messageIds: ['one', 'two'],
        isRead: true,
      })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(t.provider.mailbox.setRead).toHaveBeenCalledTimes(1))
    await t.save({ id: t.account.id, enabled: false })
    await t.save({ id: t.account.id, enabled: true })
    gate.resolve()
    expect(await write).toMatchObject({ code: 'CANCELLED' })
    expect(t.provider.mailbox.setRead).toHaveBeenCalledTimes(1)
    expect((await t.get()).reception.inbox).toBeNull()
  })
})
