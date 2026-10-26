import type { Account, AccountStatus, Binding, LoginMethod } from './types'

export const ACCOUNT_PAGE_SIZES = [20, 50, 100] as const
export type AccountPageSize = (typeof ACCOUNT_PAGE_SIZES)[number]

export interface AccountFilters {
  query: string
  status: 'all' | AccountStatus
  loginMethod: 'all' | LoginMethod
  phone: 'all' | 'with' | 'without'
  binding: 'all' | 'bound' | 'unbound'
}

export const EMPTY_ACCOUNT_FILTERS: AccountFilters = {
  query: '',
  status: 'all',
  loginMethod: 'all',
  phone: 'all',
  binding: 'all',
}

function createdTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

export function filterAccounts(
  accounts: readonly Account[],
  bindings: readonly Binding[],
  filters: AccountFilters,
): Account[] {
  const query = filters.query.trim().toLowerCase()
  const boundIds = new Set(bindings.map((binding) => binding.accountId))
  return accounts
    .filter((account) => {
      const hasPhone = account.phone.trim() !== ''
      const bound = boundIds.has(account.id)
      return (
        `${account.account} ${account.phone} ${account.note}`
          .toLowerCase()
          .includes(query) &&
        (filters.status === 'all' || account.status === filters.status) &&
        (filters.loginMethod === 'all' || account.loginMethod === filters.loginMethod) &&
        (filters.phone === 'all' || hasPhone === (filters.phone === 'with')) &&
        (filters.binding === 'all' || bound === (filters.binding === 'bound'))
      )
    })
    .sort((left, right) => {
      const leftTime = createdTime(left.createdAt)
      const rightTime = createdTime(right.createdAt)
      // Stable ties preserve the source order; invalid dates sort last.
      return leftTime === rightTime ? 0 : leftTime > rightTime ? -1 : 1
    })
}

export function paginateAccounts(
  accounts: readonly Account[],
  requestedPage: number,
  pageSize: AccountPageSize,
) {
  const pageCount = Math.max(1, Math.ceil(accounts.length / pageSize))
  const page = Math.min(
    pageCount,
    Math.max(1, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1),
  )
  return {
    page,
    pageCount,
    total: accounts.length,
    items: accounts.slice((page - 1) * pageSize, page * pageSize),
  }
}

export function formatAccountCreatedAt(value: string): string {
  const timestamp = createdTime(value)
  if (!Number.isFinite(timestamp)) return '—'
  const date = new Date(timestamp)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
