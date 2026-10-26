import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_ACCOUNT_FILTERS,
  filterAccounts,
  formatAccountCreatedAt,
  paginateAccounts,
  type AccountFilters,
} from './account-table'
import { ACCOUNT_STATUSES, EMPTY_ACCOUNT, LOGIN_METHODS, type Account } from './types'

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    ...EMPTY_ACCOUNT,
    id,
    account: `${id}@example.com`,
    createdAt: '2026-10-26T08:00:00Z',
    updatedAt: '2026-10-26T08:00:00Z',
    ...overrides,
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('account table filtering and pagination', () => {
  it('sorts newest first, keeps ties stable and does not mutate the source list', () => {
    const items = [
      account('old', { createdAt: '2026-10-20T08:00:00Z' }),
      account('tie-b'),
      account('invalid', { createdAt: 'invalid' }),
      account('tie-a'),
      account('future', { createdAt: '2099-01-01T08:00:00Z' }),
    ]
    expect(
      filterAccounts(items, [], EMPTY_ACCOUNT_FILTERS).map((item) => item.id),
    ).toEqual(['future', 'tie-b', 'tie-a', 'old', 'invalid'])
    expect(items.map((item) => item.id)).toEqual([
      'old',
      'tie-b',
      'invalid',
      'tie-a',
      'future',
    ])
  })

  it.each(ACCOUNT_STATUSES)('filters status %s', (status) => {
    const items = ACCOUNT_STATUSES.map((value) => account(value, { status: value }))
    expect(
      filterAccounts(items, [], { ...EMPTY_ACCOUNT_FILTERS, status }).map(
        (item) => item.id,
      ),
    ).toEqual([status])
  })

  it.each(LOGIN_METHODS)('filters login method %s', (loginMethod) => {
    const items = LOGIN_METHODS.map((value) => account(value, { loginMethod: value }))
    expect(
      filterAccounts(items, [], { ...EMPTY_ACCOUNT_FILTERS, loginMethod }).map(
        (item) => item.id,
      ),
    ).toEqual([loginMethod])
  })

  it.each([' SELLER ', '415555', 'priority'])(
    'searches account, phone and note for %j',
    (query) => {
      const items = [
        account('target', {
          account: 'Seller@example.com',
          phone: '+14155550100',
          note: 'Priority shop',
        }),
        account('other'),
      ]
      expect(
        filterAccounts(items, [], { ...EMPTY_ACCOUNT_FILTERS, query }).map(
          (item) => item.id,
        ),
      ).toEqual(['target'])
    },
  )

  it('combines filters with AND and treats whitespace-only phones as absent', () => {
    const items = [
      account('target', {
        status: 'blocked',
        loginMethod: 'apple',
        phone: '+14155550100',
        note: 'shop',
      }),
      account('unbound', {
        status: 'blocked',
        loginMethod: 'apple',
        phone: '+14155550101',
        note: 'shop',
      }),
      account('no-phone', { phone: '   ' }),
      account('other'),
    ]
    const bindings = [{ accountId: 'target', windowId: 'one', boundAt: '' }]
    const filters: AccountFilters = {
      query: 'shop',
      status: 'blocked',
      loginMethod: 'apple',
      phone: 'with',
      binding: 'bound',
    }
    expect(filterAccounts(items, bindings, filters).map((item) => item.id)).toEqual([
      'target',
    ])
    expect(
      filterAccounts(items, bindings, { ...filters, binding: 'unbound' }).map(
        (item) => item.id,
      ),
    ).toEqual(['unbound'])
    expect(
      filterAccounts(items, bindings, { ...EMPTY_ACCOUNT_FILTERS, phone: 'without' }).map(
        (item) => item.id,
      ),
    ).toEqual(['no-phone', 'other'])
  })

  it('paginates the full filtered inventory and clamps empty or shortened pages', () => {
    const items = Array.from({ length: 55 }, (_, index) => account(String(index)))
    expect(paginateAccounts(items, 1, 20)).toMatchObject({
      page: 1,
      pageCount: 3,
      total: 55,
    })
    expect(paginateAccounts(items, 1, 20).items).toHaveLength(20)
    expect(paginateAccounts(items, 2, 20).items[0]!.id).toBe('20')
    expect(paginateAccounts(items, 3, 20).items).toHaveLength(15)
    expect(paginateAccounts(items, 3, 50)).toMatchObject({ page: 2, pageCount: 2 })
    expect(paginateAccounts(items, 3, 100).items).toHaveLength(55)
    expect(paginateAccounts(items.slice(0, 20), 3, 20).page).toBe(1)
    expect(paginateAccounts([], 3, 20)).toEqual({
      page: 1,
      pageCount: 1,
      total: 0,
      items: [],
    })
  })
})

describe('account creation timestamps', () => {
  it('shows full local time including valid future dates and timezone offsets', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai')
    expect(formatAccountCreatedAt('2099-01-02T03:04:05Z')).toBe('2099-01-02 11:04:05')
    expect(formatAccountCreatedAt('2026-10-26T10:20:30+02:00')).toBe(
      '2026-10-26 16:20:30',
    )
  })

  it.each(['', 'invalid', '2026-13-40T99:00:00Z'])('uses a safe dash for %j', (value) => {
    expect(formatAccountCreatedAt(value)).toBe('—')
  })
})
