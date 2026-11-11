import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import { listAccounts } from './api'
import type { Account, AccountList, Binding } from './types'

vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  callPlugin: vi.fn(),
}))

const PAGE_SIZE = 16
const revision = 'a'.repeat(64)
const timestamp = '2026-11-12T00:00:00.000Z'

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
  { accountId: entry.id, windowId: `window-${index}`, boundAt: timestamp },
  { accountId: entry.id, windowId: `extra-window-${index}`, boundAt: timestamp },
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
    { bindings: [{ accountId: 'foreign', windowId: 'window', boundAt: timestamp }] },
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
      bindings: [{ accountId: 'account-16', windowId: 'window-0', boundAt: timestamp }],
    },
    {
      bindings: [{ accountId: 'account-0', windowId: 'unexpected', boundAt: timestamp }],
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
