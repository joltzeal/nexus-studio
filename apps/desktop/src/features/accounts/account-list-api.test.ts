import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin, PluginCallError } from '@/lib/platform/native-plugins'
import { listAccounts } from './api'
import type { Account, AccountList, Binding } from './types'

vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  callPlugin: vi.fn(),
}))

const PAGE_SIZE = 16
const revision = 'a'.repeat(64)
const timestamp = '2026-11-12T00:00:00.000Z'
const pageTooLarge = '账号列表单页数据过大，超过消息大小上限，请减少每页账号数后重试。'

interface Page extends AccountList {
  page: number
  pageSize: number
  revision: string
}

function account(index: number): Account {
  return {
    id: `account-${index}`,
    loginMethod: 'email',
    account: `seller-${index}@example.test`,
    password: ' synthetic password ',
    phone: '+33123456789',
    emailOtpUrl: 'https://example.test/mail',
    smsOtpUrl: 'https://example.test/sms',
    note: 'Synthetic account',
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
  }
}

const accounts = Array.from({ length: 35 }, (_, index) => account(index))
const bindings: Binding[] = accounts.flatMap((entry, index) => [
  {
    accountId: entry.id,
    windowId: `window-${index}`,
    revision: '33333333-3333-4333-8333-333333333333',
    boundAt: timestamp,
  },
  {
    accountId: entry.id,
    windowId: `extra-window-${index}`,
    revision: '33333333-3333-4333-8333-333333333333',
    boundAt: timestamp,
  },
])

function page(number: number, total = accounts.length): Page {
  const items = accounts.slice((number - 1) * PAGE_SIZE, number * PAGE_SIZE)
  return {
    page: number,
    pageSize: PAGE_SIZE,
    revision,
    total,
    items: total === 0 ? [] : items,
    bindings:
      total === 0
        ? []
        : bindings.filter((binding) =>
            items.some((entry) => entry.id === binding.accountId),
          ),
    storageDurable: true,
  }
}

beforeEach(() => vi.resetAllMocks())

describe('complete account list adapter', () => {
  it('reads an unknown account without promoting it to active', async () => {
    vi.mocked(callPlugin).mockResolvedValue({ ...page(1, 1), items: [{ ...account(0), status: 'unknown' }], bindings: [] })
    expect((await listAccounts()).items[0]?.status).toBe('unknown')
  })

  it.each([
    { firstHeavy: 0, sessionCount: 0 },
    { firstHeavy: 16, sessionCount: 0 },
    { firstHeavy: 0, sessionCount: 200 },
  ])(
    'restarts an oversized complete bank list without skipping accounts (%j)',
    async ({ firstHeavy, sessionCount }) => {
      const complete = accounts.map((item, index): Account => {
        const accountId = `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
        if (index < firstHeavy) return { ...item, id: accountId }
        const sessions: NonNullable<Account['observation']>['sessions'] = {}
        const checks: NonNullable<Account['observation']>['checks'] = {}
        for (let window = 0; window < sessionCount; window += 1) {
          const windowId = `${(index * sessionCount + window).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`
          sessions[windowId] = {
            windowId,
            accountId,
            bindingRevision: '33333333-3333-4333-8333-333333333333',
            status: 'authenticated',
            reason: 'current_user',
            platformUserId: '123',
            observedAt: timestamp,
            source: 'official',
          }
          checks[`session:${windowId}`] = {
            sequence: window + 1,
            operationId: '44444444-4444-4444-8444-444444444444',
            observedAt: timestamp,
            source: 'official',
            outcome: 'succeeded',
          }
        }
        return {
          ...item,
          id: accountId,
          password: '\u0000'.repeat(190),
          emailOtpUrl: '\u0000'.repeat(2048),
          smsOtpUrl: '\u0000'.repeat(2048),
          homepageUrl: '\u0000'.repeat(2048),
          address: { ...item.address!, sourceUrl: '\u0000'.repeat(2048) },
          observation: {
            sessions,
            checks,
            bankAccounts: {
              records: Array.from({ length: 20 }, (_, bank) => ({
                id: `9${bank.toString().padStart(31, '0')}`,
                user_id: '123',
                name: '\u6c49'.repeat(160),
                account_number: `${'\u2022'.repeat(60)}4321`,
                routing_number: '012345678',
                spending_type: '\u6c49'.repeat(64),
                hide_name: false,
                is_default: bank === 0,
              })),
              observedAt: timestamp,
              source: 'official',
              windowId: '22222222-2222-4222-8222-222222222222',
              bindingRevision: '33333333-3333-4333-8333-333333333333',
            },
          },
        }
      })
      const completeBindings: Binding[] = complete.flatMap((item, index) => [
        ...bindings
          .filter((binding) => binding.accountId === accounts[index]!.id)
          .map((binding) => ({ ...binding, accountId: item.id })),
        ...Object.values(item.observation?.sessions ?? {}).map((session) => ({
          windowId: session.windowId,
          accountId: item.id,
          revision: session.bindingRevision,
          boundAt: timestamp,
        })),
      ])
      const successfulBytes: number[] = []
      const requests: { page: number; pageSize: number; revision?: string }[] = []
      vi.mocked(callPlugin).mockImplementation(
        async (_id, _capability, _method, input) => {
          const request = input as (typeof requests)[number]
          requests.push(request)
          const items = complete.slice(
            (request.page - 1) * request.pageSize,
            request.page * request.pageSize,
          )
          const result = {
            page: request.page,
            pageSize: request.pageSize,
            revision,
            total: complete.length,
            items,
            bindings: completeBindings.filter((binding) =>
              items.some((entry) => entry.id === binding.accountId),
            ),
            storageDurable: true,
          }
          const bytes = new TextEncoder().encode(
            `${JSON.stringify({
              protocolVersion: 1,
              requestId: '\u0000'.repeat(128),
              ok: true,
              result,
            })}\n`,
          ).byteLength
          if (bytes >= 1024 * 1024) {
            throw new PluginCallError('UNAVAILABLE', pageTooLarge, true)
          }
          successfulBytes.push(bytes)
          return result
        },
      )

      const result = await listAccounts()
      expect(result).toEqual({
        items: complete,
        bindings: completeBindings,
        total: 35,
        storageDurable: true,
      })
      expect(
        result.items[result.items.length - 1]?.observation?.bankAccounts?.records,
      ).toHaveLength(20)
      expect(successfulBytes.every((bytes) => bytes < 1024 * 1024)).toBe(true)
      expect(
        requests.filter((request) => request.page === 1).map((r) => r.pageSize),
      ).toEqual(sessionCount === 0 ? [16, 8] : [16, 8, 4])
      const finalSize = sessionCount === 0 ? 8 : 4
      const finalRequests = requests.slice(-Math.ceil(35 / finalSize))
      expect(finalRequests.map((request) => request.page)).toEqual(
        finalSize === 8 ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 7, 8, 9],
      )
      expect(finalRequests.slice(1).every((r) => r.revision === revision)).toBe(true)
    },
  )

  it('reports a single-account overflow after bounded size recovery attempts', async () => {
    vi.mocked(callPlugin).mockRejectedValue(
      new PluginCallError('UNAVAILABLE', pageTooLarge, true),
    )
    await expect(listAccounts()).rejects.toThrow(pageTooLarge)
    expect(vi.mocked(callPlugin).mock.calls.map((call) => call[3])).toEqual(
      [16, 8, 4, 2, 1].map((pageSize) => ({ page: 1, pageSize })),
    )
  })

  it('does not retry an unrelated unavailable error as a page overflow', async () => {
    vi.mocked(callPlugin).mockRejectedValue(
      new PluginCallError('UNAVAILABLE', '账号存储读取失败', true),
    )
    await expect(listAccounts()).rejects.toThrow('账号存储读取失败')
    expect(callPlugin).toHaveBeenCalledOnce()
  })

  it.each([
    {
      pluginId: 'other.plugin',
      mailboxId: 'mailbox-1',
      email: 'mail@example.test',
      linkedAt: timestamp,
    },
    {
      pluginId: 'studio.email',
      mailboxId: '',
      email: 'mail@example.test',
      linkedAt: timestamp,
    },
    {
      pluginId: 'studio.email',
      mailboxId: 'mailbox-1',
      email: 'invalid',
      linkedAt: timestamp,
    },
    {
      pluginId: 'studio.email',
      mailboxId: 'mailbox-1',
      email: 'mail@example.test',
      linkedAt: 'invalid',
    },
    {
      pluginId: 'studio.email',
      mailboxId: 'mailbox-1',
      email: 'mail@example.test',
      linkedAt: timestamp,
      password: 'synthetic-secret',
    },
  ])(
    'rejects malformed mailbox relationships before exposing the account: %j',
    async (mailbox) => {
      vi.mocked(callPlugin).mockResolvedValueOnce({
        ...page(1, 1),
        items: [{ ...accounts[0], mailbox }],
        bindings: [],
      })
      await expect(listAccounts()).rejects.toThrow()
    },
  )

  it('reads pages sequentially with the initial revision and returns all accounts and page-owned bindings together', async () => {
    let finishSecond!: (value: Page) => void
    const second = new Promise<Page>((resolve) => {
      finishSecond = resolve
    })
    vi.mocked(callPlugin)
      .mockResolvedValueOnce(page(1))
      .mockReturnValueOnce(second)
      .mockResolvedValueOnce(page(3))
    const result = listAccounts()
    await vi.waitFor(() => expect(callPlugin).toHaveBeenCalledTimes(2))
    let resolved = false
    void result.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(callPlugin).toHaveBeenNthCalledWith(
      2,
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.list',
      { page: 2, pageSize: PAGE_SIZE, revision },
    )
    finishSecond(page(2))
    await expect(result).resolves.toEqual({
      items: accounts,
      total: 35,
      bindings,
      storageDurable: true,
    })
    expect(callPlugin).toHaveBeenNthCalledWith(
      1,
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.list',
      { page: 1, pageSize: PAGE_SIZE },
    )
    expect(callPlugin).toHaveBeenCalledTimes(3)
  })

  it('accepts an empty paginated list without fetching another page', async () => {
    vi.mocked(callPlugin).mockResolvedValueOnce(page(1, 0))
    await expect(listAccounts()).resolves.toEqual({
      items: [],
      total: 0,
      bindings: [],
      storageDurable: true,
    })
    expect(callPlugin).toHaveBeenCalledOnce()
  })

  it('rejects old unpaginated responses with an update hint instead of assuming a complete list', async () => {
    vi.mocked(callPlugin).mockResolvedValueOnce({
      items: accounts,
      bindings,
      total: accounts.length,
      storageDurable: true,
    })
    await expect(listAccounts()).rejects.toThrow(/更新.*账号.*插件/)
    expect(callPlugin).toHaveBeenCalledOnce()
  })

  it.each([{ page: undefined }, { pageSize: undefined }, { revision: undefined }])(
    'requires every pagination marker (case %#)',
    async (patch) => {
      const legacy = { ...page(1), ...patch }
      vi.mocked(callPlugin).mockResolvedValueOnce(legacy)
      await expect(listAccounts()).rejects.toThrow(/更新.*账号.*插件/)
    },
  )

  it.each([
    { page: 0 },
    { page: 2 },
    { pageSize: 0 },
    { pageSize: 50 },
    { total: -1 },
    { total: 2001 },
    { total: 1.5 },
    { revision: '' },
    { revision: 'x'.repeat(129) },
    { storageDurable: 'true' },
    { items: accounts.slice(0, 15) },
    { items: accounts.slice(0, 17) },
    { items: [account(0), account(0), ...accounts.slice(2, 16)] },
    { bindings: [bindings[0], bindings[0]] },
    {
      bindings: [
        {
          accountId: 'foreign',
          windowId: 'window',
          revision: '33333333-3333-4333-8333-333333333333',
          boundAt: timestamp,
        },
      ],
    },
    { items: [{ ...account(0), password: 123 }, ...accounts.slice(1, 16)] },
    {
      items: [
        { ...account(0), address: { ...account(0).address, latitude: 91 } },
        ...accounts.slice(1, 16),
      ],
    },
  ])(
    'refuses malformed, incomplete or duplicate first-page data (case %#)',
    async (patch) => {
      vi.mocked(callPlugin).mockResolvedValueOnce({ ...page(1), ...patch })
      await expect(listAccounts()).rejects.toThrow()
      expect(callPlugin).toHaveBeenCalledOnce()
    },
  )

  it.each([
    { page: 1 },
    { pageSize: 8 },
    { total: 36 },
    { storageDurable: false },
    { revision: 'b'.repeat(64) },
    { items: [account(0), ...accounts.slice(17, 32)] },
    { items: accounts.slice(16, 31) },
    {
      bindings: [
        {
          accountId: 'account-16',
          windowId: 'window-0',
          revision: '33333333-3333-4333-8333-333333333333',
          boundAt: timestamp,
        },
      ],
    },
    {
      bindings: [
        {
          accountId: 'account-0',
          windowId: 'unexpected',
          revision: '33333333-3333-4333-8333-333333333333',
          boundAt: timestamp,
        },
      ],
    },
  ])(
    'discards every collected page when later page data is inconsistent (case %#)',
    async (patch) => {
      vi.mocked(callPlugin)
        .mockResolvedValueOnce(page(1))
        .mockResolvedValueOnce({ ...page(2), ...patch })
      await expect(listAccounts()).rejects.toThrow()
      expect(callPlugin).toHaveBeenCalledTimes(2)
    },
  )

  it('propagates a stale-revision rejection without returning or retrying partial results', async () => {
    vi.mocked(callPlugin)
      .mockResolvedValueOnce(page(1))
      .mockRejectedValueOnce(new Error('账号列表已变化，请刷新后重试。'))
    await expect(listAccounts()).rejects.toThrow('账号列表已变化')
    expect(callPlugin).toHaveBeenCalledTimes(2)
  })

  it('propagates a failed later read without returning the successful first page', async () => {
    vi.mocked(callPlugin)
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2))
      .mockRejectedValueOnce(new Error('controlled read failure'))
    await expect(listAccounts()).rejects.toThrow('controlled read failure')
    expect(callPlugin).toHaveBeenCalledTimes(3)
  })
})
