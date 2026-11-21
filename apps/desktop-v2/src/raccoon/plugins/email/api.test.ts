import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEmailApi } from './api.ts'
import { supportsEmailBase, supportsEmailReader } from './api.ts'
import { EMAIL_METHODS } from './model.ts'

const mailbox = {
  id: 'mail-1',
  provider: 'microsoft',
  transport: 'graph',
  email: 'mail@example.test',
  clientId: 'client-1',
  note: '',
  enabled: true,
  status: 'active',
  hasPassword: false,
  hasRefreshToken: true,
  refreshing: false,
  receiving: false,
  reception: {
    lastCheckedAt: null,
    nextCheckAt: null,
    latestReceivedAt: null,
    lastError: null,
    lastErrorCode: null,
    inbox: { total: 1, unread: 1 },
    junkemail: null,
  },
  accessExpiresAt: null,
  lastAttemptAt: null,
  lastRefreshedAt: null,
  lastRotatedAt: null,
  nextRefreshAt: null,
  lastError: null,
  lastErrorCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
const message = {
  id: 'message-1',
  subject: 'Order',
  from: { name: 'Seller', address: 'seller@example.test' },
  receivedAt: '2026-01-01T00:00:00.000Z',
  isRead: false,
  hasAttachments: false,
  preview: 'Receipt',
}

test('validates mailbox lists and sanitizes unsafe error text', async () => {
  const api = createEmailApi(async (_id, _capability, method, _payload, parse) =>
    parse(
      method === 'email.accounts.list'
        ? {
            items: [{ ...mailbox, lastError: 'token=secret' }],
            total: 1,
            page: 1,
            pageSize: 20,
            storageDurable: true,
          }
        : null,
    ),
  )
  const result = await api.listMailboxes({ page: 1, pageSize: 20 })
  assert.equal(result.items[0]?.lastError, '刷新未成功，请检查授权和应用代理后重试。')
  assert.equal(JSON.stringify(result).includes('token=secret'), false)
})

test('rejects malformed message pages, cursors, and credential-bearing mailbox DTOs', async () => {
  for (const result of [
    { items: [message, message], total: 2, unread: 1, nextCursor: null },
    {
      items: [{ ...message, receivedAt: 'yesterday' }],
      total: 1,
      unread: 1,
      nextCursor: null,
    },
  ]) {
    const api = createEmailApi(async (_id, _capability, _method, _payload, parse) =>
      parse(result),
    )
    await assert.rejects(api.listMessages({ accountId: 'mail-1', folder: 'inbox' }))
  }
  const secretMailbox = createEmailApi(
    async (_id, _capability, _method, _payload, parse) =>
      parse({ ...mailbox, refreshToken: 'should-not-be-returned' }),
  )
  await assert.rejects(secretMailbox.getMailbox('mail-1'))
})

test('bounds message reads and validates device authorization state transitions', async () => {
  const calls: { method: string; payload: unknown }[] = []
  const api = createEmailApi(async (_id, _capability, method, payload, parse) => {
    calls.push({ method, payload })
    if (method === 'email.authorization.start')
      return parse({
        authorizationId: 'auth-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://microsoft.com/devicelogin',
        expiresAt: '2026-01-01T00:00:00.000Z',
        intervalSeconds: 5,
      })
    if (method === 'email.authorization.poll')
      return parse({ status: 'pending', retryAfterSeconds: 5 })
    return parse({ items: [message], total: 1, unread: 1, nextCursor: null })
  })
  const challenge = await api.startAuthorization('mail-1', mailbox.email)
  assert.equal(challenge.authorizationId, 'auth-1')
  assert.deepEqual(await api.pollAuthorization('auth-1', 'mail-1'), {
    status: 'pending',
    retryAfterSeconds: 5,
  })
  const page = await api.listMessages({
    accountId: 'mail-1',
    expectedEmail: mailbox.email,
    folder: 'inbox',
  })
  assert.equal(page.items.length, 1)
  assert.equal(calls[0]?.method, 'email.authorization.start')
  assert.equal(calls[1]?.method, 'email.authorization.poll')
})

test('RPC failures never expose provider credentials in the displayed error', async () => {
  const api = createEmailApi(async () => {
    throw Object.assign(new Error('refresh_token=private-value'), { code: 'AUTH_FAILED' })
  })
  await assert.rejects(
    api.getMailbox('mail-1'),
    (cause: unknown) =>
      cause instanceof Error &&
      !cause.message.includes('private-value') &&
      cause.message.includes('授权'),
  )
})

test('read writes reject empty, duplicate and oversized requests before RPC', async () => {
  let calls = 0
  const api = createEmailApi(async () => {
    calls++
    throw new Error('unexpected RPC')
  })
  for (const messageIds of [
    [],
    ['one', 'one'],
    Array.from({ length: 21 }, (_, index) => String(index)),
  ]) {
    await assert.rejects(async () =>
      api.setMessagesRead({
        accountId: 'mail-1',
        folder: 'inbox',
        messageIds,
        isRead: true,
      }),
    )
  }
  assert.equal(calls, 0)
})

test('message lists reject unexpected secret-bearing properties', async () => {
  const api = createEmailApi(async (_id, _cap, _method, _payload, parse) =>
    parse({
      items: [{ ...message, accessToken: 'secret' }],
      total: 1,
      unread: 1,
      nextCursor: null,
    }),
  )
  await assert.rejects(api.listMessages({ accountId: 'mail-1', folder: 'inbox' }))
})

test('email gate rejects wrong capability, grants, state and incomplete method sets', () => {
  const plugin = {
    enabled: true,
    state: 'running',
    capabilities: ['email.provider'],
    granted: ['email.provider'],
    methods: [...EMAIL_METHODS.base] as string[],
  }
  assert.equal(supportsEmailBase(plugin), true)
  for (const patch of [
    { capabilities: ['account.pool'] },
    { granted: [] },
    { enabled: false },
    { state: 'unlicensed' },
  ])
    assert.equal(supportsEmailBase({ ...plugin, ...patch }), false)
  for (const missing of EMAIL_METHODS.base)
    assert.equal(
      supportsEmailBase({
        ...plugin,
        methods: plugin.methods.filter((method) => method !== missing),
      }),
      false,
    )
})

test('linked-mail reader requires every called method independently of target browsing', () => {
  const plugin = {
    enabled: true,
    state: 'running',
    capabilities: ['email.provider'],
    granted: ['email.provider'],
    methods: [
      'email.accounts.get',
      'email.messages.list',
      'email.messages.get',
      'email.messages.read',
    ],
  }
  assert.equal(supportsEmailReader(plugin), true)
  assert.equal(
    supportsEmailReader({ ...plugin, methods: ['email.accounts.targets'] }),
    false,
  )
  for (const missing of plugin.methods)
    assert.equal(
      supportsEmailReader({
        ...plugin,
        methods: plugin.methods.filter((method) => method !== missing),
      }),
      false,
    )
})

test('partial read writes preserve failed identities and reject incomplete confirmations', async () => {
  const input = {
    accountId: 'mail-1',
    folder: 'inbox' as const,
    messageIds: ['one', 'two'],
    isRead: true,
  }
  const partial = createEmailApi(async (_id, _cap, _method, _payload, parse) =>
    parse({
      isRead: true,
      updatedIds: ['one'],
      failures: [{ messageId: 'two', code: 'AUTH_FAILED' }],
    }),
  )
  assert.deepEqual(await partial.setMessagesRead(input), {
    isRead: true,
    updatedIds: ['one'],
    failures: [{ messageId: 'two', code: 'AUTH_FAILED' }],
  })
  const missing = createEmailApi(async (_id, _cap, _method, _payload, parse) =>
    parse({ isRead: true, updatedIds: ['one'], failures: [] }),
  )
  await assert.rejects(missing.setMessagesRead(input))
})

test('explicit export sends only selected identities and validates grouped files', async () => {
  const calls: unknown[] = []
  const api = createEmailApi(async (_id, _cap, _method, payload, parse) => {
    calls.push(payload)
    return parse({
      total: 1,
      files: [
        {
          transport: 'graph',
          filename: 'mailboxes-graph.txt',
          count: 1,
          text: `${mailbox.email}----synthetic-password----client----synthetic-token\n`,
        },
      ],
    })
  })
  const result = await api.exportMailboxes([mailbox])
  assert.deepEqual(calls, [{ mailboxes: [{ id: mailbox.id, email: mailbox.email }] }])
  assert.equal(result.total, 1)
  await assert.rejects(async () => api.exportMailboxes([]))
  const invalid = createEmailApi(async (_id, _cap, _method, _payload, parse) =>
    parse({
      total: 1,
      files: [
        {
          transport: 'graph',
          filename: '../secret.txt',
          count: 1,
          text: 'other@example.test----p----c----t\n',
        },
      ],
    }),
  )
  await assert.rejects(invalid.exportMailboxes([mailbox]))
})

test('export and import errors expose fixed safe feedback only', async () => {
  const api = createEmailApi(async () => {
    throw new Error('password=synthetic-secret refresh_token=private')
  })
  await assert.rejects(
    api.exportMailboxes([mailbox]),
    (cause: unknown) =>
      cause instanceof Error && !/synthetic|private/.test(cause.message),
  )
  const report = createEmailApi(async (_id, _cap, _method, _payload, parse) =>
    parse({
      total: 2,
      inserted: 0,
      skipped: 2,
      errors: [
        { row: 1, message: '邮箱已存在，已保留现有凭据' },
        { row: 2, message: 'password=synthetic-secret' },
      ],
    }),
  )
  const result = await report.importMailboxes('valid', 'graph')
  assert.equal(result.errors[0]?.message, '邮箱已存在，已保留现有凭据')
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/)
})
