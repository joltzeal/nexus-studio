import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin, PluginCallError } from '@/lib/platform/native-plugins'
import {
  getMessage,
  getSettings,
  importMailboxes,
  listMailboxes,
  listMessages,
  queueRefresh,
  removeMailbox,
  saveMailbox,
  saveSettings,
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
      saveSettings({ autoRefresh: true, intervalMinutes: 60 }),
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
      .mockResolvedValueOnce({ items: [message()], nextCursor: 'opaque-cursor' })
      .mockResolvedValueOnce({
        ...message(),
        to: [],
        body: '<script>text</script>',
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
    vi.mocked(callPlugin).mockResolvedValue(response)
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
})
