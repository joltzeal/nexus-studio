import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  MessageGetInputSchema,
  MessageListInputSchema,
  MessageReadInputSchema,
} from '../domain/schemas.js'
import type { EmailProvider, MailMessagePage } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { createMemoryStore, emptyReception } from '../store/private-store.js'
import { EmailService } from './email.js'

const email = 'linked@example.test'
const message = {
  id: 'one',
  subject: 'Fixture',
  from: { name: '', address: 'sender@example.test' },
  receivedAt: null,
  isRead: false,
  hasAttachments: false,
  preview: '',
}
const page: MailMessagePage = { items: [message], nextCursor: null, total: 1, unread: 1 }
const ctx = (method: string, payload: unknown): DispatchContext => ({
  requestId: randomUUID(),
  capability: 'email.provider',
  method,
  payload,
  deadlineAt: Date.now() + 120_000,
  assertAlive() {},
  signal: new AbortController().signal,
})

async function setup() {
  const store = createMemoryStore()
  const id = randomUUID()
  const now = '2026-11-12T01:00:00.000Z'
  await store.mutate((document) =>
    document.accounts.push({
      id,
      provider: 'microsoft',
      transport: 'graph',
      email,
      password: '',
      clientId: '00000000-0000-4000-8000-000000000001',
      refreshToken: 'synthetic-refresh',
      accessToken: 'synthetic-access',
      accessExpiresAt: '2026-11-13T01:00:00.000Z',
      credentialRevision: randomUUID(),
      note: '',
      enabled: true,
      status: 'active',
      lastAttemptAt: null,
      lastRefreshedAt: null,
      lastRotatedAt: null,
      nextRefreshAt: null,
      refreshRequested: false,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorCode: null,
      reception: emptyReception(),
      receiveRequested: false,
      receiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    }),
  )
  const provider: EmailProvider = {
    tokens: {
      refresh: vi.fn(async () => ({ accessToken: 'synthetic-next', expiresIn: 3600 })),
    },
    mailbox: {
      list: vi.fn(async () => page),
      get: vi.fn(async () => ({
        ...message,
        to: [],
        body: 'Text',
        html: null,
        truncated: false,
      })),
      setRead: vi.fn(async () => {}),
    },
  }
  const service = new EmailService({
    store,
    providers: { get: () => provider },
    now: () => new Date(now),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const rename = () =>
    service.call(
      ctx('email.accounts.save', {
        id,
        provider: 'microsoft',
        transport: 'graph',
        email: 'renamed@example.test',
        clientId: '00000000-0000-4000-8000-000000000001',
        note: '',
        enabled: true,
      }),
    )
  const input = (method: string) => ({
    accountId: id,
    folder: 'inbox',
    expectedEmail: email,
    ...(method === 'get'
      ? { messageId: 'one' }
      : method === 'read'
        ? { messageIds: ['one'], isRead: true }
        : {}),
  })
  return { store, id, provider, service, rename, input }
}

describe('linked mailbox identity', () => {
  it('validates optional expectedEmail using EmailSchema on all message RPCs', () => {
    const base = { accountId: randomUUID(), folder: 'inbox' }
    for (const [schema, extra] of [
      [MessageListInputSchema, {}],
      [MessageGetInputSchema, { messageId: 'one' }],
      [MessageReadInputSchema, { messageIds: ['one'], isRead: true }],
    ] as const) {
      expect(schema.safeParse({ ...base, ...extra, expectedEmail: email }).success).toBe(
        true,
      )
      expect(
        schema.safeParse({ ...base, ...extra, expectedEmail: 'invalid' }).success,
      ).toBe(false)
    }
  })

  it.each(['list', 'get', 'read'])(
    'rejects a rename before %s without network or address lookup',
    async (method) => {
      const t = await setup()
      await t.rename()
      await expect(
        t.service.call(ctx(`email.messages.${method}`, t.input(method))),
      ).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(t.provider.tokens.refresh).not.toHaveBeenCalled()
      expect(t.provider.mailbox.list).not.toHaveBeenCalled()
      expect(t.provider.mailbox.get).not.toHaveBeenCalled()
      expect(t.provider.mailbox.setRead).not.toHaveBeenCalled()
    },
  )

  it.each(['list', 'get', 'read'])(
    'rejects a rename during %s and ignores the late result',
    async (method) => {
      const t = await setup()
      let release = () => {}
      const gate = new Promise<void>((done) => {
        release = done
      })
      if (method === 'list')
        vi.mocked(t.provider.mailbox.list).mockImplementationOnce(async () => {
          await gate
          return page
        })
      if (method === 'get')
        vi.mocked(t.provider.mailbox.get).mockImplementationOnce(async () => {
          await gate
          return {
            ...message,
            to: [],
            body: 'Private text',
            html: null,
            truncated: false,
          }
        })
      if (method === 'read')
        vi.mocked(t.provider.mailbox.setRead).mockImplementationOnce(async () => gate)
      const result = t.service
        .call(ctx(`email.messages.${method}`, t.input(method)))
        .catch((error: unknown) => error)
      const operation =
        method === 'list'
          ? t.provider.mailbox.list
          : method === 'get'
            ? t.provider.mailbox.get
            : t.provider.mailbox.setRead
      await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1))
      await t.rename()
      release()
      expect(await result).toMatchObject({ code: 'CANCELLED' })
      expect((await t.store.read()).accounts[0]?.reception.inbox).toBeNull()
    },
  )

  it('compares email case-insensitively and still resolves exclusively by UUID', async () => {
    const t = await setup()
    await expect(
      t.service.call(
        ctx('email.messages.list', {
          ...t.input('list'),
          expectedEmail: email.toUpperCase(),
        }),
      ),
    ).resolves.toEqual(page)
    await expect(
      t.service.call(
        ctx('email.messages.list', {
          ...t.input('list'),
          accountId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
