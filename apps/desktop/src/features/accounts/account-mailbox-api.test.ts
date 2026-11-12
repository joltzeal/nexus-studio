import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import {
  assignedAccountMailbox,
  assignAccountMailbox,
  listAccountMailboxTargets,
} from './account-mailbox-api'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

const updatedAt = '2026-11-12T10:00:00.000Z'
const mailbox = {
  pluginId: 'studio.email' as const,
  mailboxId: 'mailbox-original',
  email: 'mailbox@example.test',
}
const assigned = { ...mailbox, linkedAt: updatedAt }
const target = {
  id: 'account-1',
  account: 'seller@example.test',
  status: 'active',
  mailbox: assigned,
}
const page = {
  items: [target],
  total: 1,
  page: 1,
  pageSize: 20,
  storageDurable: true,
}

beforeEach(() => vi.resetAllMocks())

describe('account mailbox RPC adapter', () => {
  it('uses the credential-free target RPC with the supplied query and page', async () => {
    const secondPage = { ...page, page: 2, total: 21 }
    vi.mocked(callPlugin).mockResolvedValueOnce(secondPage)
    expect(
      await listAccountMailboxTargets({ query: mailbox.email, page: 2, pageSize: 20 }),
    ).toEqual(secondPage)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.mailbox.targets',
      { query: mailbox.email, page: 2, pageSize: 20 },
    )
  })

  it('sends the default strict input and accepts an unlinked memory-only target', async () => {
    const result = {
      ...page,
      items: [{ ...target, mailbox: null }],
      storageDurable: false,
    }
    vi.mocked(callPlugin).mockResolvedValueOnce(result)
    expect(await listAccountMailboxTargets()).toEqual(result)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.mailbox.targets',
      {},
    )
  })

  it('accepts empty results for an out-of-range requested page without changing page identity', async () => {
    const result = { ...page, items: [], page: 100 }
    vi.mocked(callPlugin).mockResolvedValueOnce(result)
    expect(await listAccountMailboxTargets({ page: 100 })).toEqual(result)
  })

  it.each([null, 'previous-mailbox'])(
    'sends only mailbox identity and the required expected ID %j',
    async (expectedMailboxId) => {
      const result = { mailbox: assigned, updatedAt, storageDurable: true }
      vi.mocked(callPlugin).mockResolvedValueOnce(result)
      const source = { ...assigned, refreshToken: 'synthetic-secret' }
      expect(await assignAccountMailbox('account-1', source, expectedMailboxId)).toEqual(
        result,
      )
      expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
        'studio.vinted-accounts',
        'account.pool',
        'vinted.accounts.mailbox.set',
        { accountId: 'account-1', mailbox, expectedMailboxId },
      )
    },
  )

  it('unlinks using the last observed mailbox ID and accepts memory-only storage', async () => {
    const result = { mailbox: null, updatedAt, storageDurable: false }
    vi.mocked(callPlugin).mockResolvedValueOnce(result)
    expect(await assignAccountMailbox('account-1', null, mailbox.mailboxId)).toEqual(
      result,
    )
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.mailbox.set',
      { accountId: 'account-1', mailbox: null, expectedMailboxId: mailbox.mailboxId },
    )
  })

  it.each([
    null,
    { ...page, extra: 'synthetic-secret' },
    { ...page, items: [{ ...target, password: 'synthetic-secret' }] },
    { ...page, items: [{ ...target, emailOtpUrl: 'https://example.test/private' }] },
    {
      ...page,
      items: [{ ...target, mailbox: { ...assigned, refreshToken: 'synthetic-secret' } }],
    },
    { ...page, items: [{ ...target, mailbox: undefined }] },
    { ...page, items: [{ ...target, mailbox: { ...assigned, linkedAt: 'invalid' } }] },
    {
      ...page,
      items: [{ ...target, mailbox: { ...assigned, pluginId: 'other.plugin' } }],
    },
    { ...page, items: [{ ...target, status: 'ready' }] },
    { ...page, items: [{ ...target, id: '' }] },
    { ...page, items: [{ ...target, account: '' }] },
    { ...page, items: [target, target], total: 2 },
    { ...page, total: 2 },
    { ...page, total: -1 },
    { ...page, total: 2001 },
    { ...page, total: 1.5 },
    { ...page, page: 2 },
    { ...page, pageSize: 50 },
    { ...page, pageSize: 51 },
    { ...page, storageDurable: 'true' },
  ])('rejects inconsistent or credential-bearing target results: %j', async (result) => {
    vi.mocked(callPlugin).mockResolvedValueOnce(result)
    await expect(listAccountMailboxTargets()).rejects.toThrow('数据格式无效')
  })

  it.each([
    null,
    { query: 'x'.repeat(201) },
    { page: 0 },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { pageSize: 51 },
    { password: 'synthetic-secret' },
  ])('rejects invalid target inputs before invoking a plugin: %j', async (input) => {
    await expect(listAccountMailboxTargets(input as never)).rejects.toThrow()
    expect(callPlugin).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { mailbox: assigned, updatedAt, storageDurable: true },
    { mailbox: null, updatedAt: 'invalid', storageDurable: true },
    { mailbox: null, updatedAt },
    { mailbox: null, updatedAt, storageDurable: true, password: 'synthetic-secret' },
  ])('rejects malformed or inconsistent unlink receipts: %j', async (result) => {
    vi.mocked(callPlugin).mockResolvedValueOnce(result)
    await expect(
      assignAccountMailbox('account-1', null, mailbox.mailboxId),
    ).rejects.toThrow('数据格式无效')
  })

  it.each([
    null,
    { ...assigned, mailboxId: 'other-mailbox' },
    { ...assigned, email: 'other@example.test' },
    { ...assigned, linkedAt: 'invalid' },
    { ...assigned, accessToken: 'synthetic-secret' },
  ])(
    'rejects mismatched or credential-bearing assignment receipts: %j',
    async (value) => {
      vi.mocked(callPlugin).mockResolvedValueOnce({
        mailbox: value,
        updatedAt,
        storageDurable: true,
      })
      await expect(assignAccountMailbox('account-1', mailbox, null)).rejects.toThrow(
        '数据格式无效',
      )
    },
  )

  it.each([
    ['', mailbox, null],
    ['account-1', mailbox, undefined],
    ['account-1', mailbox, ''],
    ['account-1', { ...mailbox, pluginId: 'other.plugin' }, null],
    ['account-1', { ...mailbox, mailboxId: '' }, null],
    ['account-1', { ...mailbox, email: 'invalid' }, null],
    ['account-1', {}, null],
  ])(
    'rejects invalid assignments before invoking a plugin: %j',
    async (id, value, expected) => {
      await expect(
        assignAccountMailbox(id as never, value as never, expected as never),
      ).rejects.toThrow()
      expect(callPlugin).not.toHaveBeenCalled()
    },
  )

  it('does not expose arbitrary plugin error text or produce a success receipt on failure', async () => {
    vi.mocked(callPlugin).mockRejectedValue(new Error('refresh_token=synthetic-secret'))
    await expect(assignAccountMailbox('account-1', mailbox, null)).rejects.toThrow(
      /刷新|重试/,
    )
    await expect(assignAccountMailbox('account-1', mailbox, null)).rejects.not.toThrow(
      'synthetic-secret',
    )
    await expect(listAccountMailboxTargets()).rejects.not.toThrow('synthetic-secret')
  })
})

describe('shared assigned mailbox validation', () => {
  it('accepts the persisted reference shape for the general account validator', () => {
    expect(assignedAccountMailbox(assigned)).toBe(true)
    expect(
      assignedAccountMailbox({ ...assigned, linkedAt: '2026-11-12T11:00:00+01:00' }),
    ).toBe(true)
  })

  it.each([
    null,
    mailbox,
    { ...assigned, mailboxId: ' padded ' },
    { ...assigned, mailboxId: 'x'.repeat(65) },
    { ...assigned, pluginId: 'studio.other' },
    { ...assigned, email: 'invalid' },
    { ...assigned, linkedAt: '2026-02-30T10:00:00Z' },
    { ...assigned, password: 'synthetic-secret' },
  ])('rejects malformed or credential-bearing persisted references: %j', (value) => {
    expect(assignedAccountMailbox(value)).toBe(false)
  })
})
