import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listPlugins, type PluginView } from '@/lib/platform/native-plugins'
import {
  assignAccountMailbox,
  listAccountMailboxTargets,
} from '@/features/accounts/account-mailbox-api'
import { getMailbox, listMailboxTargets } from './api'
import {
  linkMailboxToAccount,
  loadAccountLinkTargets,
  loadMailboxLinkTargets,
  resolveLinkedMailbox,
  unlinkMailboxFromAccount,
} from './accounts-link'
import { mailbox } from './test-fixtures'

vi.mock('@/lib/platform/native-plugins', async (original) => ({
  ...(await original<typeof import('@/lib/platform/native-plugins')>()),
  listPlugins: vi.fn(),
}))
vi.mock('@/features/accounts/account-mailbox-api', () => ({
  assignAccountMailbox: vi.fn(),
  listAccountMailboxTargets: vi.fn(),
}))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  getMailbox: vi.fn(),
  listMailboxTargets: vi.fn(),
}))

const accountId = 'account-1'
const linkedAt = '2026-11-12T10:00:00.000Z'
const link = {
  pluginId: 'studio.email' as const,
  mailboxId: mailbox().id,
  email: mailbox().email,
  linkedAt,
}
const receipt = { mailbox: link, updatedAt: linkedAt, storageDurable: true }
const identity = (id: string, capability: string, methods: string[]): PluginView => ({
  id,
  name: id,
  version: '1.0.0',
  apiVersion: 1,
  minCoreVersion: '0.1.27',
  capabilities: [capability],
  granted: [capability],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
  source: 'installed',
  state: 'running',
  enabled: true,
  methods,
  status: { pid: id === 'studio.email' ? 123 : 456 },
  lastError: null,
  storageDurable: true,
  secretSlots: [],
  sourceDirectory: null,
})
const emailPlugin = identity('studio.email', 'email.provider', [
  'email.accounts.get',
  'email.accounts.targets',
  'email.messages.list',
  'email.messages.get',
])
const accountPlugin = identity('studio.vinted-accounts', 'account.pool', [
  'vinted.accounts.mailbox.targets',
  'vinted.accounts.mailbox.set',
])
const plugins = [emailPlugin, accountPlugin]

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(listPlugins).mockResolvedValue(plugins)
  vi.mocked(getMailbox).mockResolvedValue(mailbox())
  vi.mocked(assignAccountMailbox).mockResolvedValue(receipt)
})

describe('mailbox and account composition', () => {
  it('links a validated mailbox by ID with a relation-only compare-and-set', async () => {
    expect(await linkMailboxToAccount(accountId, mailbox(), null)).toEqual(receipt)
    expect(assignAccountMailbox).toHaveBeenCalledExactlyOnceWith(
      accountId,
      { pluginId: 'studio.email', mailboxId: mailbox().id, email: mailbox().email },
      null,
    )
  })

  it.each([{ id: 'different-mailbox' }, { email: 'different@example.test' }])(
    'does not link a mailbox whose current identity changed: %j',
    async (patch) => {
      vi.mocked(getMailbox).mockResolvedValueOnce(mailbox(patch))
      await expect(linkMailboxToAccount(accountId, mailbox(), null)).rejects.toThrow(
        '邮箱资料已变化',
      )
      expect(assignAccountMailbox).not.toHaveBeenCalled()
    },
  )

  it('requires both enabled capabilities and methods before a write', async () => {
    vi.mocked(listPlugins).mockResolvedValueOnce([
      { ...emailPlugin, granted: [] },
      accountPlugin,
    ])
    await expect(linkMailboxToAccount(accountId, mailbox(), null)).rejects.toThrow(
      '邮箱插件',
    )
    expect(getMailbox).not.toHaveBeenCalled()
    expect(assignAccountMailbox).not.toHaveBeenCalled()
  })

  it('rejects a provider process replacement between validation and write', async () => {
    vi.mocked(listPlugins)
      .mockResolvedValueOnce(plugins)
      .mockResolvedValueOnce([{ ...emailPlugin, status: { pid: 999 } }, accountPlugin])
    await expect(linkMailboxToAccount(accountId, mailbox(), null)).rejects.toThrow(
      '插件状态已变化',
    )
    expect(assignAccountMailbox).not.toHaveBeenCalled()
  })

  it('does not claim a successful save when the account process changed after writing', async () => {
    vi.mocked(listPlugins)
      .mockResolvedValueOnce(plugins)
      .mockResolvedValueOnce(plugins)
      .mockResolvedValueOnce([emailPlugin, { ...accountPlugin, status: { pid: 999 } }])
    await expect(linkMailboxToAccount(accountId, mailbox(), null)).rejects.toThrow(
      '请刷新核对关联结果',
    )
    expect(assignAccountMailbox).toHaveBeenCalledTimes(1)
  })

  it('unlinks using only the account plugin even if the mailbox plugin was removed', async () => {
    vi.mocked(listPlugins).mockResolvedValue([accountPlugin])
    const unlinked = { ...receipt, mailbox: null }
    vi.mocked(assignAccountMailbox).mockResolvedValueOnce(unlinked)
    expect(await unlinkMailboxFromAccount(accountId, link.mailboxId)).toEqual(unlinked)
    expect(assignAccountMailbox).toHaveBeenCalledExactlyOnceWith(
      accountId,
      null,
      link.mailboxId,
    )
    expect(getMailbox).not.toHaveBeenCalled()
  })

  it('resolves the bound mailbox without guessing by email', async () => {
    expect(await resolveLinkedMailbox(link)).toEqual(mailbox())
    expect(getMailbox).toHaveBeenCalledExactlyOnceWith(link.mailboxId)
    expect(listMailboxTargets).not.toHaveBeenCalled()
  })

  it('keeps a deleted or renamed binding unavailable instead of opening a different mailbox', async () => {
    vi.mocked(getMailbox).mockResolvedValueOnce(
      mailbox({ email: 'renamed@example.test' }),
    )
    await expect(resolveLinkedMailbox(link)).rejects.toThrow('邮箱资料已变化')
    expect(listMailboxTargets).not.toHaveBeenCalled()
  })

  it('does not open a paused mailbox', async () => {
    vi.mocked(getMailbox).mockResolvedValueOnce(
      mailbox({ enabled: false, status: 'paused' }),
    )
    await expect(resolveLinkedMailbox(link)).rejects.toThrow('已暂停')
  })

  it('uses the credential-free account and mailbox pickers', async () => {
    const empty = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      storageDurable: true,
    }
    vi.mocked(listAccountMailboxTargets).mockResolvedValueOnce(empty)
    vi.mocked(listMailboxTargets).mockResolvedValueOnce(empty)
    expect(await loadAccountLinkTargets({ query: link.email, page: 1 })).toEqual(empty)
    expect(await loadMailboxLinkTargets({ query: 'seller', page: 1 })).toEqual(empty)
    expect(listAccountMailboxTargets).toHaveBeenCalledWith({
      query: link.email,
      page: 1,
      pageSize: 10,
    })
    expect(listMailboxTargets).toHaveBeenCalledWith({
      query: 'seller',
      page: 1,
      pageSize: 10,
    })
  })

  it('suppresses arbitrary upstream failures without retaining a credential-bearing cause', async () => {
    vi.mocked(getMailbox).mockRejectedValueOnce(
      new Error('synthetic-secret-token-in-provider-response'),
    )
    const failure = await resolveLinkedMailbox(link).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('synthetic-secret')
    expect(Object.getOwnPropertyDescriptor(failure as Error, 'cause')).toBeUndefined()
  })
})
