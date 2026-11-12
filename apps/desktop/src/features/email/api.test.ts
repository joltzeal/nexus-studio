import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin, PluginCallError } from '@/lib/platform/native-plugins'
import {
  getMessage,
  getMailbox,
  getSettings,
  importMailboxes,
  listMailboxTargets,
  listMailboxes,
  listMessages,
  queueReception,
  queueRefresh,
  removeMailbox,
  saveMailbox,
  saveSettings,
  setMessagesRead,
} from './api'
import { mailbox, message } from './test-fixtures'
import { EmailResource } from './async-state'

vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  callPlugin: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(callPlugin).mockReset()
})

describe('email RPC boundary', () => {
  it('reads a single server page with filters instead of loading the entire pool', async () => {
    vi.mocked(callPlugin).mockResolvedValue({
      items: [mailbox()],
      total: 51,
      page: 2,
      pageSize: 20,
      storageDurable: true,
    })
    const result = await listMailboxes({
      query: 'example',
      status: 'active',
      page: 2,
      pageSize: 20,
    })
    expect(result.items[0]?.email).toBe('reader@example.test')
    expect(result.total).toBe(51)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.email',
      'email.provider',
      'email.accounts.list',
      { query: 'example', status: 'active', page: 2, pageSize: 20 },
      undefined,
    )
  })

  it.each([
    { total: -1 },
    { page: 1.5 },
    { pageSize: 100 },
    { storageDurable: 'yes' },
    { items: [mailbox(), mailbox()] },
    { items: [{ ...mailbox(), refreshToken: 'synthetic-secret' }] },
    { items: [{ ...mailbox(), password: 'synthetic-secret' }] },
    { items: [{ ...mailbox(), status: 'ready' }] },
    { items: [{ ...mailbox(), hasRefreshToken: 'true' }] },
    { items: [{ ...mailbox(), lastRefreshedAt: 'yesterday' }] },
  ])('rejects malformed or credential-bearing mailbox summaries: %j', async (patch) => {
    vi.mocked(callPlugin).mockResolvedValue({
      items: [mailbox()],
      total: 2,
      page: 1,
      pageSize: 20,
      storageDurable: true,
      ...patch,
    })
    await expect(listMailboxes({ page: 1, pageSize: 20 })).rejects.toThrow()
  })

  it('omits empty edit credentials and requires a refresh token for new mailboxes', async () => {
    vi.mocked(callPlugin).mockResolvedValue(mailbox())
    const input = {
      provider: 'microsoft' as const,
      transport: 'graph' as const,
      email: 'reader@example.test',
      clientId: 'synthetic-client',
      note: '',
      enabled: true,
      password: '',
      refreshToken: '   ',
    }
    await expect(saveMailbox(input)).rejects.toThrow()
    expect(callPlugin).not.toHaveBeenCalled()
    await saveMailbox({ ...input, id: 'mailbox-1' })
    const payload = vi.mocked(callPlugin).mock.calls[0]![3]
    expect(payload).toEqual({
      id: 'mailbox-1',
      provider: 'microsoft',
      transport: 'graph',
      email: 'reader@example.test',
      clientId: 'synthetic-client',
      note: '',
      enabled: true,
    })
  })

  it('validates every mutation response before reporting success', async () => {
    vi.mocked(callPlugin).mockResolvedValue({ removed: false })
    await expect(removeMailbox('mailbox-1')).rejects.toThrow()
    vi.mocked(callPlugin).mockResolvedValue({ queued: 2, skipped: 0 })
    await expect(queueRefresh(['mailbox-1'])).rejects.toThrow()
    vi.mocked(callPlugin).mockResolvedValue({ autoRefresh: true, intervalMinutes: 4 })
    await expect(getSettings()).rejects.toThrow()
    vi.mocked(callPlugin).mockResolvedValue({
      autoRefresh: true,
      intervalMinutes: 60,
      accessToken: 'synthetic-secret',
    })
    await expect(
      saveSettings({
        autoRefresh: true,
        intervalMinutes: 60,
        autoReceive: true,
        receiveIntervalMinutes: 1,
      }),
    ).rejects.toThrow()
    vi.mocked(callPlugin).mockResolvedValue({ ...mailbox(), refreshing: 1 })
    await expect(
      saveMailbox({
        id: 'mailbox-1',
        provider: 'microsoft',
        transport: 'imap',
        email: 'reader@example.test',
        clientId: 'synthetic-client',
        note: '',
        enabled: true,
      }),
    ).rejects.toThrow()
  })

  it('validates batch totals and never exposes imported row credentials through errors', async () => {
    vi.mocked(callPlugin).mockResolvedValue({
      total: 2,
      inserted: 1,
      skipped: 1,
      errors: [{ row: 2, message: 'invalid synthetic-secret refresh_token' }],
    })
    const report = await importMailboxes('synthetic-import', 'graph')
    expect(report).toMatchObject({ total: 2, inserted: 1, skipped: 1 })
    expect(report.errors[0]?.row).toBe(2)
    expect(report.errors[0]?.message).not.toContain('synthetic-secret')
    vi.mocked(callPlugin).mockResolvedValue({
      total: 1,
      inserted: 2,
      skipped: 0,
      errors: [],
    })
    await expect(importMailboxes('synthetic-import', 'imap')).rejects.toThrow()
  })

  it('enforces the batch limit before sending and accepts only coherent queue counts', async () => {
    await expect(
      queueRefresh(Array.from({ length: 101 }, (_, index) => `mailbox-${index}`)),
    ).rejects.toThrow()
    expect(callPlugin).not.toHaveBeenCalled()
    vi.mocked(callPlugin).mockResolvedValue({ queued: 1, skipped: 1 })
    expect(await queueRefresh(['mailbox-1', 'mailbox-2'])).toEqual({
      queued: 1,
      skipped: 1,
    })
  })

  it('uses 120-second deadlines for both mail reads and keeps folder/cursor scope', async () => {
    vi.mocked(callPlugin)
      .mockResolvedValueOnce({
        items: [message()],
        nextCursor: 'opaque-cursor',
        total: 40,
        unread: 20,
      })
      .mockResolvedValueOnce({
        ...message(),
        to: [],
        body: '<script>text</script>',
        html: null,
        truncated: false,
      })
    await listMessages({ accountId: 'mailbox-1', folder: 'junkemail', cursor: 'page-2' })
    const detail = await getMessage({
      accountId: 'mailbox-1',
      folder: 'junkemail',
      messageId: 'message-1',
    })
    expect(detail.body).toBe('<script>text</script>')
    expect(callPlugin).toHaveBeenNthCalledWith(
      1,
      'studio.email',
      'email.provider',
      'email.messages.list',
      { accountId: 'mailbox-1', folder: 'junkemail', cursor: 'page-2' },
      120_000,
    )
    expect(callPlugin).toHaveBeenNthCalledWith(
      2,
      'studio.email',
      'email.provider',
      'email.messages.get',
      { accountId: 'mailbox-1', folder: 'junkemail', messageId: 'message-1' },
      120_000,
    )
  })

  it.each([
    { items: [message(), message()], nextCursor: null },
    {
      items: Array.from({ length: 21 }, (_, index) =>
        message({ id: `message-${index}` }),
      ),
      nextCursor: null,
    },
    { items: [{ ...message(), isRead: 'false' }], nextCursor: null },
    { items: [message()], nextCursor: 3 },
  ])('rejects malformed mail pages: %j', async (response) => {
    vi.mocked(callPlugin).mockResolvedValue({ total: 25, unread: 12, ...response })
    await expect(
      listMessages({ accountId: 'mailbox-1', folder: 'inbox' }),
    ).rejects.toThrow()
  })

  it('rejects oversized, mismatched and malformed mail details', async () => {
    const input = {
      accountId: 'mailbox-1',
      folder: 'inbox' as const,
      messageId: 'message-1',
    }
    for (const patch of [
      { id: 'message-2' },
      { body: '界'.repeat(24_000) },
      { to: [{ name: '', address: 1 }] },
      { truncated: undefined },
    ]) {
      vi.mocked(callPlugin).mockResolvedValue({
        ...message(),
        to: [],
        body: 'Plain text',
        html: null,
        truncated: false,
        ...patch,
      })
      await expect(getMessage(input)).rejects.toThrow()
    }
  })

  it('never includes upstream messages or rejected response values in displayed errors', async () => {
    vi.mocked(callPlugin).mockRejectedValue(new Error('password=synthetic-secret'))
    await expect(getSettings()).rejects.toThrow(/设置/)
    await expect(getSettings()).rejects.not.toThrow('synthetic-secret')
    vi.mocked(callPlugin).mockResolvedValue({ refreshToken: 'synthetic-secret' })
    await expect(listMailboxes({ page: 1, pageSize: 20 })).rejects.not.toThrow(
      'synthetic-secret',
    )
  })

  it.each([
    ['AUTH_FAILED', '邮箱授权已失效或被撤销，请编辑邮箱并更新授权凭据。'],
    ['PERMISSION_DENIED', '缺少所选通道的收信权限，请重新授权，或改用已获授权的通道。'],
  ])(
    'keeps safe %s guidance through the mail reader resource',
    async (code, guidance) => {
      vi.mocked(callPlugin).mockRejectedValue(
        new PluginCallError(code, 'refresh_token=synthetic-secret', false),
      )
      const resource = new EmailResource(
        { accountId: 'mailbox-1', folder: 'inbox' as const },
        listMessages,
        '邮件列表读取失败，请检查授权或应用代理后重试。',
      )
      resource.start()
      try {
        await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false))
        expect(resource.getSnapshot().error).toBe(guidance)
        expect(resource.getSnapshot().error).not.toContain('synthetic-secret')
      } finally {
        resource.dispose()
      }
    },
  )

  it('shows a missing-permission refresh result without returning upstream details', async () => {
    vi.mocked(callPlugin).mockResolvedValue({
      items: [
        mailbox({
          status: 'reauth-required',
          lastErrorCode: 'PERMISSION_DENIED',
          lastError: 'refresh_token=synthetic-secret',
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      storageDurable: true,
    })
    const result = await listMailboxes({ page: 1, pageSize: 20 })
    expect(result.items[0]?.lastError).toContain('收信权限')
    expect(result.items[0]?.lastError).not.toContain('synthetic-secret')
  })

  it('validates reception counts and replaces reception error text with safe guidance', async () => {
    const account = mailbox({
      receiving: true,
      reception: {
        lastCheckedAt: '2026-11-12T12:00:00Z',
        nextCheckAt: '2026-11-12T12:01:00Z',
        latestReceivedAt: null,
        inbox: { total: 40, unread: 3 },
        junkemail: { total: 1, unread: 1 },
        lastError: 'password=synthetic-secret',
        lastErrorCode: 'TIMEOUT',
      },
    })
    vi.mocked(callPlugin).mockResolvedValue(account)
    const result = await getMailbox('mailbox-1')
    expect(result.reception.inbox).toEqual({ total: 40, unread: 3 })
    expect(result.reception.lastError).toContain('收信')
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.email',
      'email.provider',
      'email.accounts.get',
      { id: 'mailbox-1' },
      undefined,
    )
    for (const patch of [
      { receiving: 1 },
      { id: 'other' },
      { reception: { ...account.reception, inbox: { total: 2, unread: 3 } } },
      { reception: { ...account.reception, nextCheckAt: 'tomorrow' } },
      { reception: { ...account.reception, accessToken: 'synthetic-secret' } },
    ]) {
      vi.mocked(callPlugin).mockResolvedValue({ ...account, ...patch })
      await expect(getMailbox('mailbox-1')).rejects.toThrow()
    }
  })

  it('projects only bounded credential-free mailbox targets on the requested page', async () => {
    const target = {
      id: 'mailbox-1',
      email: 'reader@example.test',
      enabled: true,
      status: 'active',
    }
    const page = {
      items: [target],
      total: 51,
      page: 2,
      pageSize: 50,
      storageDurable: true,
    }
    vi.mocked(callPlugin).mockResolvedValue(page)
    expect(await listMailboxTargets({ query: 'reader', page: 2, pageSize: 50 })).toEqual(
      page,
    )
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.email',
      'email.provider',
      'email.accounts.targets',
      { query: 'reader', page: 2, pageSize: 50 },
      undefined,
    )
    for (const patch of [
      { items: [{ ...target, password: 'synthetic-secret' }] },
      { items: [target, target] },
      { items: [{ ...target, status: 'ready' }] },
      { page: 1 },
      { pageSize: 100 },
      { storageDurable: 'yes' },
    ]) {
      vi.mocked(callPlugin).mockResolvedValue({ ...page, ...patch })
      await expect(listMailboxTargets({ page: 2, pageSize: 50 })).rejects.toThrow()
    }
  })

  it('keeps reception scheduling independent from token refresh and validates both intervals', async () => {
    const value = {
      autoRefresh: false,
      intervalMinutes: 120,
      autoReceive: true,
      receiveIntervalMinutes: 1,
    }
    vi.mocked(callPlugin).mockResolvedValue(value)
    expect(await saveSettings(value)).toEqual(value)
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.email',
      'email.provider',
      'email.settings.save',
      value,
      undefined,
    )
    for (const patch of [
      { autoReceive: undefined },
      { receiveIntervalMinutes: 0 },
      { receiveIntervalMinutes: 61 },
      { receiveIntervalMinutes: 1.5 },
    ]) {
      vi.mocked(callPlugin).mockResolvedValue({ ...value, ...patch })
      await expect(getSettings()).rejects.toThrow()
      await expect(saveSettings({ ...value, ...patch } as typeof value)).rejects.toThrow()
    }
    vi.mocked(callPlugin).mockResolvedValue({ queued: 1, skipped: 0 })
    expect(await queueReception(['mailbox-1'])).toEqual({ queued: 1, skipped: 0 })
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.email',
      'email.provider',
      'email.receive.queue',
      { ids: ['mailbox-1'] },
      undefined,
    )
    vi.mocked(callPlugin).mockClear()
    for (const ids of [
      [],
      ['mailbox-1', 'mailbox-1'],
      Array.from({ length: 101 }, (_, i) => `mailbox-${i}`),
    ]) {
      await expect(queueReception(ids)).rejects.toThrow()
    }
    expect(callPlugin).not.toHaveBeenCalled()
  })

  it('validates filtered folder totals, unread counts and HTML byte bounds', async () => {
    const input = {
      accountId: 'mailbox-1',
      folder: 'inbox' as const,
      readState: 'unread' as const,
    }
    const page = { items: [message()], nextCursor: null, total: 5, unread: 2 }
    vi.mocked(callPlugin).mockResolvedValue(page)
    expect(await listMessages(input)).toEqual(page)
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.email',
      'email.provider',
      'email.messages.list',
      input,
      120_000,
    )
    for (const patch of [
      { total: -1 },
      { total: 1.5 },
      { total: '5' },
      { unread: 6 },
      { unread: -1 },
      { unread: 1.5 },
      { unread: '2' },
      { items: [message({ isRead: true })] },
      { items: [{ ...message(), accessToken: 'synthetic-secret' }] },
    ]) {
      vi.mocked(callPlugin).mockResolvedValue({ ...page, ...patch })
      await expect(listMessages(input)).rejects.toThrow()
    }
    const detailInput = {
      accountId: 'mailbox-1',
      folder: 'inbox' as const,
      messageId: 'message-1',
    }
    const detail = {
      ...message(),
      to: [],
      body: 'Plain',
      html: '<p>Hello</p>',
      truncated: false,
    }
    vi.mocked(callPlugin).mockResolvedValue(detail)
    expect((await getMessage(detailInput)).html).toBe('<p>Hello</p>')
    for (const html of [undefined, 1, '界'.repeat(44_000)]) {
      vi.mocked(callPlugin).mockResolvedValue({ ...detail, html })
      await expect(getMessage(detailInput)).rejects.toThrow()
    }
  })

  it.each([
    {
      change: 'another client marks a fetched unread message read before folder recount',
      readState: 'all' as const,
      items: [message(), message({ id: 'message-2' })],
      total: 2,
      unread: 1,
    },
    {
      change:
        'another client marks the fetched read message unread before folder recount',
      readState: 'all' as const,
      items: [message({ isRead: true })],
      total: 1,
      unread: 1,
    },
    {
      change: 'unread counts shrink after the filtered page was fetched',
      readState: 'unread' as const,
      items: [message(), message({ id: 'message-2' })],
      total: 2,
      unread: 1,
    },
    {
      change: 'read counts shrink after the filtered page was fetched',
      readState: 'read' as const,
      items: [message({ isRead: true }), message({ id: 'message-2', isRead: true })],
      total: 2,
      unread: 2,
    },
    {
      change: 'every fetched unread message is deleted before folder recount',
      readState: 'unread' as const,
      items: [message(), message({ id: 'message-2' })],
      total: 0,
      unread: 0,
    },
    {
      change: 'a fetched read message is deleted before folder recount',
      readState: 'read' as const,
      items: [message({ isRead: true }), message({ id: 'message-2', isRead: true })],
      total: 1,
      unread: 0,
    },
    {
      change: 'messages arrive after IMAP STATUS but before the page fetch',
      readState: 'all' as const,
      items: [message(), message({ id: 'message-2' })],
      total: 0,
      unread: 0,
    },
  ])(
    'accepts separately valid page/count snapshots when $change',
    async ({ readState, items, total, unread }) => {
      const response = { items, nextCursor: null, total, unread }
      vi.mocked(callPlugin).mockResolvedValue(response)
      await expect(
        listMessages({
          accountId: 'mailbox-1',
          expectedEmail: 'reader@example.test',
          folder: 'inbox',
          readState,
        }),
      ).resolves.toEqual(response)
    },
  )

  it.each([
    { readState: 'unread' as const, isRead: true },
    { readState: 'read' as const, isRead: false },
  ])(
    'rejects $readState pages containing a message outside the requested filter',
    async ({ readState, isRead }) => {
      vi.mocked(callPlugin).mockResolvedValue({
        items: [message({ isRead })],
        nextCursor: null,
        total: 10,
        unread: 5,
      })
      await expect(
        listMessages({
          accountId: 'mailbox-1',
          folder: 'inbox',
          readState,
        }),
      ).rejects.toThrow('邮件列表返回的数据格式无效')
    },
  )

  it('accepts confirmed partial read-state results and rejects incomplete or invented results', async () => {
    const input = {
      accountId: 'mailbox-1',
      folder: 'inbox' as const,
      messageIds: ['message-1', 'message-2'],
      isRead: true,
    }
    const result = {
      updatedIds: ['message-1'],
      failures: [{ messageId: 'message-2', code: 'PERMISSION_DENIED' }],
      isRead: true,
    }
    vi.mocked(callPlugin).mockResolvedValue(result)
    expect(await setMessagesRead(input)).toEqual(result)
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.email',
      'email.provider',
      'email.messages.read',
      input,
      120_000,
    )
    for (const patch of [
      { isRead: false },
      { updatedIds: ['message-1', 'message-1'] },
      { updatedIds: ['unknown-message'] },
      { failures: [] },
      { failures: [{ messageId: 'message-1', code: 'TIMEOUT' }] },
      { failures: [{ messageId: 'message-2', code: 'UNKNOWN' }] },
      {
        failures: [
          { messageId: 'message-2', code: 'TIMEOUT', message: 'synthetic-secret' },
        ],
      },
    ]) {
      vi.mocked(callPlugin).mockResolvedValue({ ...result, ...patch })
      await expect(setMessagesRead(input)).rejects.toThrow()
    }
    vi.mocked(callPlugin).mockClear()
    for (const messageIds of [
      [],
      ['message-1', 'message-1'],
      Array.from({ length: 21 }, (_, i) => `message-${i}`),
    ]) {
      await expect(setMessagesRead({ ...input, messageIds })).rejects.toThrow()
    }
    expect(callPlugin).not.toHaveBeenCalled()
  })
})
