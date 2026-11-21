import type { Account, AccountStatus, LoginMethod } from './model.ts'

export const ACCOUNT_PAGE_SIZES = [20, 50, 100] as const
export type AccountPageSize = (typeof ACCOUNT_PAGE_SIZES)[number]

export type LinkedProfile = {
  id: string
  name: string | null
  connectionId: string | null
}

export function indexAccountProfiles(
  bindings: readonly { accountId: string; windowId: string }[],
  profiles: readonly { id: string; name: string; connectionId: string }[],
) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]))
  const byAccount = new Map<string, LinkedProfile[]>()
  for (const binding of bindings) {
    const profile = byId.get(binding.windowId)
    const linked = byAccount.get(binding.accountId) ?? []
    linked.push({
      id: binding.windowId,
      name: profile?.name ?? null,
      connectionId: profile?.connectionId ?? null,
    })
    byAccount.set(binding.accountId, linked)
  }
  return byAccount
}

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

function createdTime(value: string) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

export function filterAccounts(
  accounts: readonly Account[],
  bindings: readonly { accountId: string }[],
  filters: AccountFilters,
): Account[] {
  const query = filters.query.trim().toLowerCase()
  const bound = new Set(bindings.map((binding) => binding.accountId))
  return accounts
    .filter(
      (account) =>
        `${account.account} ${account.phone} ${account.note} ${account.mailbox?.email ?? ''}`
          .toLowerCase()
          .includes(query) &&
        (filters.status === 'all' || account.status === filters.status) &&
        (filters.loginMethod === 'all' || account.loginMethod === filters.loginMethod) &&
        (filters.phone === 'all' ||
          (account.phone.trim() !== '') === (filters.phone === 'with')) &&
        (filters.binding === 'all' ||
          bound.has(account.id) === (filters.binding === 'bound')),
    )
    .sort((left, right) => {
      const leftTime = createdTime(left.createdAt)
      const rightTime = createdTime(right.createdAt)
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

export function retainAccountSelection(
  selected: ReadonlySet<string>,
  accounts: readonly Pick<Account, 'id'>[],
  completed: readonly string[] = [],
) {
  const available = new Set(accounts.map((account) => account.id))
  const done = new Set(completed)
  return new Set([...selected].filter((id) => available.has(id) && !done.has(id)))
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
const relativeFormat = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'always' })

export function formatAccountCreatedAt(value: string, now: number) {
  const time = createdTime(value)
  if (!Number.isFinite(time)) return { absolute: '—', relative: '' }
  const seconds = (time - now) / 1000
  const age = Math.abs(seconds)
  const [size, unit] =
    age >= 86400
      ? ([86400, 'day'] as const)
      : age >= 3600
        ? ([3600, 'hour'] as const)
        : ([60, 'minute'] as const)
  return {
    absolute: dateFormat.format(time),
    relative: age < 60 ? '刚刚' : relativeFormat.format(Math.trunc(seconds / size), unit),
  }
}
