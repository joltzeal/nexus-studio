import type { AccountStatus, ImportRowError, LoginMethod } from './types.js'

/** Column order of the downloadable template; also the positional fallback. */
export const TEMPLATE_HEADERS = [
  '登录方式',
  '账号',
  '密码',
  '手机号',
  '邮箱接码地址',
  '手机接码地址',
  '账号状态',
  '主页链接',
  '备注',
] as const

export type AccountField =
  | 'loginMethod'
  | 'account'
  | 'password'
  | 'phone'
  | 'emailOtpUrl'
  | 'smsOtpUrl'
  | 'status'
  | 'homepageUrl'
  | 'note'

const FIELD_ORDER: readonly AccountField[] = [
  'loginMethod',
  'account',
  'password',
  'phone',
  'emailOtpUrl',
  'smsOtpUrl',
  'status',
  'homepageUrl',
  'note',
]

/** Header aliases, matched after lowercasing and dropping separators. */
const ALIASES: Record<AccountField, readonly string[]> = {
  loginMethod: [
    '登录方式',
    '登录类型',
    '登录',
    '方式',
    'loginmethod',
    'login',
    'method',
    'type',
  ],
  account: [
    '账号',
    '账户',
    '帐户',
    '邮箱',
    '用户名',
    'account',
    'email',
    'username',
    'user',
  ],
  password: ['密码', 'password', 'pass', 'pwd'],
  phone: ['手机号', '手机号码', '手机', '电话', 'phone', 'mobile', 'tel'],
  emailOtpUrl: [
    '邮箱接码地址',
    '邮箱接码链接',
    '邮箱验证码地址',
    '邮箱验证码链接',
    '邮箱otp',
    '邮箱otp地址',
    'emailotp',
    'emailotpurl',
    'emailotpaddress',
  ],
  smsOtpUrl: [
    '手机接码地址',
    '手机接码链接',
    '短信接码地址',
    '短信接码链接',
    '接码地址',
    '接码链接',
    '接码',
    'otp地址',
    'otpurl',
    'smsotp',
    'smsotpurl',
    'smsotpaddress',
  ],
  status: ['账号状态', '账户状态', '状态', 'status', 'state'],
  homepageUrl: [
    '主页链接',
    '主页地址',
    '主页',
    '个人主页',
    '店铺链接',
    'homepage',
    'homepageurl',
    'profile',
    'profileurl',
    'url',
  ],
  note: ['备注', '说明', 'note', 'remark', 'comment', 'memo'],
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_\-·.（）()：:]/g, '')
}

const ALIAS_INDEX = new Map<string, AccountField>()
for (const [field, aliases] of Object.entries(ALIASES) as [AccountField, string[]][]) {
  for (const alias of aliases) ALIAS_INDEX.set(normalizeHeader(alias), field)
}

export function mapHeaders(
  header: readonly string[],
): Partial<Record<AccountField, number>> {
  const mapping: Partial<Record<AccountField, number>> = {}
  header.forEach((cell, index) => {
    const field = ALIAS_INDEX.get(normalizeHeader(cell))
    // First occurrence wins: a duplicated column cannot silently override one.
    if (field !== undefined && mapping[field] === undefined) mapping[field] = index
  })
  return mapping
}

export interface ParsedAccount {
  loginMethod: LoginMethod
  account: string
  password: string
  phone: string
  emailOtpUrl: string
  smsOtpUrl: string
  note: string
  status: AccountStatus
  homepageUrl: string
}

/**
 * A first row is a header only when it maps at least two columns and no cell
 * anywhere in it is credential-shaped. Without the second half, a headerless
 * file starting with `email,user@x.com,pass` would lose its only data row.
 */
function looksLikeHeader(
  row: readonly string[],
  mapping: Partial<Record<AccountField, number>>,
): boolean {
  const mapped = Object.values(mapping).filter((index) => index !== undefined)
  if (mapped.length < 2) return false
  return !row.some((cell) => {
    const value = cell.trim()
    return value.includes('@') || /^https?:\/\//i.test(value)
  })
}

export interface ParseOutcome {
  rows: ParsedAccount[]
  errors: ImportRowError[]
  /** True when the file carried a header row this module recognised. */
  headerRecognized: boolean
}

const LOGIN_ALIASES: Record<LoginMethod, readonly string[]> = {
  email: ['email', 'e-mail', 'mail', '邮箱', '邮件', '密码登录', '账号密码'],
  google: ['google', '谷歌', 'gmail', 'google账号'],
  apple: ['apple', '苹果', 'icloud', 'appleid'],
  facebook: ['facebook', 'fb', '脸书', 'meta'],
}

function parseLoginMethod(raw: string, account: string): LoginMethod | null {
  const value = raw.trim().toLowerCase()
  if (value === '') {
    // An address is unambiguous; anything else must be stated explicitly.
    return account.includes('@') ? 'email' : null
  }
  for (const [method, aliases] of Object.entries(LOGIN_ALIASES) as [
    LoginMethod,
    string[],
  ][]) {
    if (aliases.includes(value)) return method
  }
  return null
}

function parseStatus(raw: string): AccountStatus {
  const value = raw.trim().toLowerCase()
  if (['pending', '待验证', '未验证', '待激活'].includes(value)) return 'pending'
  if (['limited', '受限', '限制', '风控'].includes(value)) return 'limited'
  if (['blocked', 'banned', '封禁', '已封', '禁用'].includes(value)) return 'blocked'
  return 'active'
}

export function normalizeHomepage(raw: string): string {
  const value = raw.trim()
  if (value === '') return ''
  if (/^https?:\/\//i.test(value)) return value
  // A bare `vinted.fr/member/123` is what people paste; assume https.
  return `https://${value.replace(/^\/+/, '')}`
}

/**
 * Turns a parsed spreadsheet into account rows.
 *
 * Only the three fields the product requires (login method, account, password)
 * can reject a row; everything else falls back so one typo cannot drop a
 * hundred usable credentials.
 */
export function parseAccountRows(table: readonly (readonly string[])[]): ParseOutcome {
  const rows = table.filter((row) => row.some((cell) => cell.trim() !== ''))
  if (rows.length === 0) return { rows: [], errors: [], headerRecognized: false }

  const mapping = mapHeaders(rows[0] ?? [])
  const headerRecognized = looksLikeHeader(rows[0] ?? [], mapping)
  const start = headerRecognized ? 1 : 0
  // With a header, an absent column means an absent value. Only a file without
  // a header falls back to the template's column order.
  const columnOf = (field: AccountField): number =>
    headerRecognized ? (mapping[field] ?? -1) : FIELD_ORDER.indexOf(field)

  const parsed: ParsedAccount[] = []
  const errors: ImportRowError[] = []

  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index] ?? []
    const line = index + 1
    const raw = (field: AccountField): string => {
      const column = columnOf(field)
      return column < 0 ? '' : (row[column] ?? '')
    }
    const value = (field: AccountField): string => raw(field).trim()
    const account = value('account')
    const password = raw('password').trim()
    if (account === '' && password === '') continue
    if (account === '') {
      errors.push({ row: line, message: '账号为空' })
      continue
    }
    if (password === '') {
      errors.push({ row: line, message: '密码为空' })
      continue
    }
    const loginMethod = parseLoginMethod(value('loginMethod'), account)
    if (loginMethod === null) {
      errors.push({
        row: line,
        message: `登录方式无法识别：${value('loginMethod') || '未填写'}`,
      })
      continue
    }
    parsed.push({
      loginMethod,
      account,
      password,
      phone: value('phone'),
      emailOtpUrl: value('emailOtpUrl'),
      smsOtpUrl: value('smsOtpUrl'),
      note: value('note'),
      status: parseStatus(value('status')),
      homepageUrl: normalizeHomepage(value('homepageUrl')),
    })
  }

  return { rows: parsed, errors, headerRecognized }
}
