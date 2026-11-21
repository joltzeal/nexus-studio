export type ObservedMoney = {
  amount: string
  currency: string
  observedAt: string
  source: 'official' | 'page' | 'model'
}
export type AccountObservation = {
  platformUserId?: string
  summary?: string
  tags?: string[]
  rating?: number
  wallet?: { available: ObservedMoney | null; pending: ObservedMoney | null }
  bankAccounts?: {
    records: {
      id: string
      name: string
      account_number: string
      routing_number: string
      spending_type: string
      user_id: string
      hide_name: boolean
      is_default: boolean
    }[]
    observedAt: string
    source: 'official'
    windowId: string
    bindingRevision: string
  }
  sessions: Record<
    string,
    {
      accountId: string
      status: 'authenticated' | 'logged_out'
      observedAt: string
      bindingRevision: string
    }
  >
  checks: Record<string, { outcome: 'succeeded' | 'failed'; observedAt: string }>
}
const invalid = () => new Error('账号观察数据无效，请刷新或更新插件。')
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number) {
  if (typeof value !== 'string' || value.length > max) throw invalid()
  return value
}
function time(value: unknown) {
  const result = text(value, 64)
  if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result)))
    throw invalid()
  return result
}
function money(value: unknown): ObservedMoney | null {
  if (value === null) return null
  const row = record(value)
  if (
    !/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/.test(text(row.amount, 18)) ||
    !/^[A-Z]{3}$/.test(text(row.currency, 3)) ||
    !['official', 'page', 'model'].includes(String(row.source))
  )
    throw invalid()
  return {
    amount: row.amount as string,
    currency: row.currency as string,
    observedAt: time(row.observedAt),
    source: row.source as ObservedMoney['source'],
  }
}
export function parseObservation(value: unknown): AccountObservation | undefined {
  if (value === undefined) return undefined
  const row = record(value)
  const result: AccountObservation = { sessions: {}, checks: {} }
  if (row.platformUserId !== undefined) {
    const id = text(row.platformUserId, 32)
    if (!/^[1-9]\d*$/.test(id)) throw invalid()
    result.platformUserId = id
  }
  if (row.summary !== undefined) result.summary = text(row.summary, 160)
  if (row.tags !== undefined) {
    if (!Array.isArray(row.tags) || row.tags.length > 8) throw invalid()
    result.tags = row.tags.map((tag) => text(tag, 24))
  }
  if (row.rating !== undefined) {
    if (
      typeof row.rating !== 'number' ||
      !Number.isFinite(row.rating) ||
      row.rating < 0 ||
      row.rating > 5
    )
      throw invalid()
    result.rating = row.rating
  }
  if (row.wallet !== undefined) {
    const wallet = record(row.wallet)
    result.wallet = { available: money(wallet.available), pending: money(wallet.pending) }
  }
  if (row.bankAccounts !== undefined) {
    const bank = record(row.bankAccounts)
    if (
      !Array.isArray(bank.records) ||
      bank.records.length > 20 ||
      bank.source !== 'official' ||
      !uuid(bank.windowId) ||
      !uuid(bank.bindingRevision)
    )
      throw invalid()
    const records = bank.records.map((entry) => {
      const item = record(entry)
      const accountNumber = text(item.account_number, 64)
      const routingNumber = text(item.routing_number, 9)
      if (
        !/^[*xX\u2022\s-]*[*xX\u2022][*xX\u2022\s-]*\d{1,4}$/.test(accountNumber) ||
        !/^\d{9}$/.test(routingNumber) ||
        typeof item.hide_name !== 'boolean' ||
        typeof item.is_default !== 'boolean'
      )
        throw invalid()
      return {
        id: text(item.id, 32),
        name: text(item.name, 160),
        account_number: accountNumber,
        routing_number: routingNumber,
        spending_type: text(item.spending_type, 64),
        user_id: text(item.user_id, 32),
        hide_name: item.hide_name,
        is_default: item.is_default,
      }
    })
    if (new Set(records.map((item) => item.id)).size !== records.length) throw invalid()
    result.bankAccounts = {
      records,
      observedAt: time(bank.observedAt),
      source: 'official',
      windowId: bank.windowId as string,
      bindingRevision: bank.bindingRevision as string,
    }
  }
  for (const [key, entry] of Object.entries(record(row.sessions))) {
    const item = record(entry)
    if (
      !uuid(key) ||
      !uuid(item.accountId) ||
      !uuid(item.bindingRevision) ||
      !['authenticated', 'logged_out'].includes(String(item.status))
    )
      throw invalid()
    result.sessions[key] = {
      accountId: item.accountId as string,
      status: item.status as 'authenticated' | 'logged_out',
      observedAt: time(item.observedAt),
      bindingRevision: item.bindingRevision as string,
    }
  }
  for (const [key, entry] of Object.entries(record(row.checks))) {
    const item = record(entry)
    if (
      ![
        'identity',
        'session',
        'wallet.available',
        'wallet.pending',
        'bankAccounts',
        'analysis',
      ].includes(key) &&
      !(key.startsWith('session:') && uuid(key.slice(8)))
    )
      throw invalid()
    if (!['succeeded', 'failed'].includes(String(item.outcome))) throw invalid()
    result.checks[key] = {
      outcome: item.outcome as 'succeeded' | 'failed',
      observedAt: time(item.observedAt),
    }
  }
  return result
}
