import type { SmsRecord } from './types.ts'

type Account = {
  id: string
  loginMethod: 'email' | 'google' | 'apple' | 'facebook'
  account: string
  password: string
  phone: string
  emailOtpUrl: string
  smsOtpUrl: string
  note: string
  status: 'unknown' | 'active' | 'pending' | 'limited' | 'blocked'
  homepageUrl: string
  updatedAt: string
}

export type Sim8AccountTarget = {
  id: string
  account: string
  phone: string
  smsOtpUrl: string
}

type AccountCall = <T>(
  id: string,
  capability: string,
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs?: number,
) => Promise<T>

const PLUGIN_ID = 'studio.vinted-accounts'
const invalid = () => new Error('Vinted 账号池返回的数据格式无效，请刷新后重试。')

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

function parseAccount(value: unknown): Account {
  const row = object(value)
  const required = [
    'id',
    'account',
    'password',
    'phone',
    'emailOtpUrl',
    'smsOtpUrl',
    'note',
    'homepageUrl',
    'updatedAt',
  ] as const
  if (required.some((key) => typeof row[key] !== 'string')) throw invalid()
  if (!['email', 'google', 'apple', 'facebook'].includes(String(row.loginMethod)))
    throw invalid()
  if (!['unknown', 'active', 'pending', 'limited', 'blocked'].includes(String(row.status)))
    throw invalid()
  return {
    id: row.id as string,
    loginMethod: row.loginMethod as Account['loginMethod'],
    account: row.account as string,
    password: row.password as string,
    phone: row.phone as string,
    emailOtpUrl: row.emailOtpUrl as string,
    smsOtpUrl: row.smsOtpUrl as string,
    note: row.note as string,
    status: row.status as Account['status'],
    homepageUrl: row.homepageUrl as string,
    updatedAt: row.updatedAt as string,
  }
}

export function createSim8AccountBridge(call: AccountCall) {
  const readAccounts = async () => {
    const accounts: Account[] = []
    let revision: string | undefined
    let total = 0
    for (let page = 1; accounts.length < total || page === 1; page++) {
      const result = await call(
        PLUGIN_ID,
        'account.pool',
        'vinted.accounts.list',
        {
          page,
          pageSize: 16,
          ...(revision === undefined ? {} : { revision }),
        },
        (value) => {
          const row = object(value)
          if (
            !Array.isArray(row.items) ||
            !Number.isSafeInteger(row.total) ||
            typeof row.revision !== 'string' ||
            row.page !== page ||
            row.pageSize !== 16 ||
            row.items.length > 16
          )
            throw invalid()
          return {
            items: row.items.map(parseAccount),
            total: row.total as number,
            revision: row.revision,
          }
        },
      )
      if (revision !== undefined && revision !== result.revision)
        throw new Error('账号列表已变化，请刷新后重试。')
      revision = result.revision
      total = result.total
      accounts.push(...result.items)
      if (page > Math.ceil(total / 16) + 1) throw invalid()
    }
    if (
      accounts.length !== total ||
      new Set(accounts.map((account) => account.id)).size !== accounts.length
    )
      throw new Error('账号列表读取不完整，请重试')
    return accounts
  }

  return {
    list: async () =>
      (await readAccounts()).map((account) => ({
        id: account.id,
        account: account.account,
        phone: account.phone,
        smsOtpUrl: account.smsOtpUrl,
      })),
    attachTo: async (accountId: string, record: SmsRecord) => {
      if (record.api === '') throw new Error('这个号码没有接码链接，无法写入账号')
      const latest = (await readAccounts()).find((account) => account.id === accountId)
      if (!latest) throw new Error('账号不存在或已被删除，请刷新列表')
      const result = await call(
        PLUGIN_ID,
        'account.pool',
        'vinted.accounts.save',
        {
          id: latest.id,
          expectedUpdatedAt: latest.updatedAt,
          loginMethod: latest.loginMethod,
          account: latest.account,
          password: latest.password,
          phone: record.tel,
          emailOtpUrl: latest.emailOtpUrl,
          smsOtpUrl: record.api,
          note: latest.note,
          status: latest.status,
          homepageUrl: latest.homepageUrl,
        },
        (value) => {
          const row = object(value)
          if (row.created !== false) throw new Error('账号写入未确认，请刷新账号池')
          return parseAccount(row.item)
        },
      )
      if (result.phone !== record.tel || result.smsOtpUrl !== record.api)
        throw new Error('账号写入未确认，请刷新账号池后核对')
      return { id: result.id, updatedAt: result.updatedAt }
    },
  }
}

export function createNativeSim8AccountBridge() {
  return createSim8AccountBridge((id, _capability, method, payload, parse, deadlineMs) =>
    import('../call.ts').then(({ callPlugin }) =>
      callPlugin(id, 'account.pool', method, payload, parse, deadlineMs),
    ),
  )
}

export type { Account as Sim8Account }
