import {
  MAILBOX_ERROR_CODES,
  MAILBOX_STATUSES,
  type EmailAuthorizationChallenge,
  type EmailAuthorizationResult,
  type EmailSettings,
  type MailboxInput,
  type MailboxPage,
  type MailboxQuery,
  type MailboxStatus,
  type MailboxView,
  type MailMessage,
  type MailMessageDetail,
  type MailMessagePage,
  type MailReadState,
  type MailTransport,
} from './model.ts'

export const invalidEmailResponse = (
  message = '邮箱插件返回的数据格式无效，请刷新或更新插件后重试。',
) => new Error(message)
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidEmailResponse()
  return value as Record<string, unknown>
}
function exact(row: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(row).length === keys.length &&
    keys.every((key) => Object.hasOwn(row, key))
  )
}
export function string(value: unknown, max = 8192, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    throw invalidEmailResponse()
  return value
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw invalidEmailResponse()
  return value
}
export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidEmailResponse()
  return value
}
export function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d\d-\d\dT/.test(value)
  )
}
function nullableTime(value: unknown): string | null {
  if (value === null) return null
  if (!validTimestamp(value)) throw invalidEmailResponse()
  return value
}
const errorCode = (value: unknown) =>
  value === null
    ? null
    : (MAILBOX_ERROR_CODES.find((entry) => entry === value) ??
      (() => {
        throw invalidEmailResponse()
      })())
function counts(value: unknown) {
  if (value === null) return null
  const row = object(value)
  if (!exact(row, ['total', 'unread'])) throw invalidEmailResponse()
  const total = integer(row.total)
  return { total, unread: integer(row.unread, 0, total) }
}

const MAILBOX_KEYS = [
  'id',
  'provider',
  'transport',
  'email',
  'clientId',
  'note',
  'enabled',
  'status',
  'hasPassword',
  'hasRefreshToken',
  'refreshing',
  'receiving',
  'reception',
  'accessExpiresAt',
  'lastAttemptAt',
  'lastRefreshedAt',
  'lastRotatedAt',
  'nextRefreshAt',
  'lastError',
  'lastErrorCode',
  'createdAt',
  'updatedAt',
]
export function parseMailbox(value: unknown): MailboxView {
  const row = object(value)
  if (
    !exact(row, MAILBOX_KEYS) ||
    row.provider !== 'microsoft' ||
    !['graph', 'imap'].includes(String(row.transport)) ||
    !MAILBOX_STATUSES.includes(row.status as MailboxStatus)
  )
    throw invalidEmailResponse()
  const email = string(row.email, 254, 3)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalidEmailResponse()
  const receptionRow = object(row.reception)
  const receptionKeys = [
    'lastCheckedAt',
    'nextCheckAt',
    'latestReceivedAt',
    'lastError',
    'lastErrorCode',
    'inbox',
    'junkemail',
  ]
  if (!exact(receptionRow, receptionKeys)) throw invalidEmailResponse()
  for (const key of ['lastError', 'lastErrorCode'] as const)
    if (
      receptionRow[key] !== null &&
      (key === 'lastError'
        ? typeof receptionRow[key] !== 'string' ||
          (receptionRow[key] as string).length > 500
        : !MAILBOX_ERROR_CODES.includes(receptionRow[key] as never))
    )
      throw invalidEmailResponse()
  const reception = {
    lastCheckedAt: nullableTime(receptionRow.lastCheckedAt),
    nextCheckAt: nullableTime(receptionRow.nextCheckAt),
    latestReceivedAt: nullableTime(receptionRow.latestReceivedAt),
    lastError: receptionRow.lastError as string | null,
    lastErrorCode: errorCode(receptionRow.lastErrorCode),
    inbox: counts(receptionRow.inbox),
    junkemail: counts(receptionRow.junkemail),
  }
  for (const key of [
    'enabled',
    'hasPassword',
    'hasRefreshToken',
    'refreshing',
    'receiving',
  ] as const)
    bool(row[key])
  const lastError = row.lastError === null ? null : string(row.lastError, 500)
  return {
    id: string(row.id, 64, 1),
    provider: 'microsoft',
    transport: row.transport as MailTransport,
    email,
    clientId: string(row.clientId, 128, 1),
    note: string(row.note, 1000),
    enabled: row.enabled as boolean,
    status: row.status as MailboxStatus,
    hasPassword: row.hasPassword as boolean,
    hasRefreshToken: row.hasRefreshToken as boolean,
    refreshing: row.refreshing as boolean,
    receiving: row.receiving as boolean,
    reception,
    accessExpiresAt: nullableTime(row.accessExpiresAt),
    lastAttemptAt: nullableTime(row.lastAttemptAt),
    lastRefreshedAt: nullableTime(row.lastRefreshedAt),
    lastRotatedAt: nullableTime(row.lastRotatedAt),
    nextRefreshAt: nullableTime(row.nextRefreshAt),
    lastError,
    lastErrorCode: errorCode(row.lastErrorCode),
    createdAt: validTimestamp(row.createdAt)
      ? row.createdAt
      : (() => {
          throw invalidEmailResponse()
        })(),
    updatedAt: validTimestamp(row.updatedAt)
      ? row.updatedAt
      : (() => {
          throw invalidEmailResponse()
        })(),
  }
}

export function parseMailboxPage(value: unknown, input: MailboxQuery): MailboxPage {
  const row = object(value)
  if (!Array.isArray(row.items) || typeof row.storageDurable !== 'boolean')
    throw invalidEmailResponse()
  const items = row.items.map(parseMailbox)
  const total = integer(row.total)
  const page = integer(row.page, 1)
  if (
    row.pageSize !== input.pageSize ||
    page !== Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize))) ||
    items.length > input.pageSize ||
    items.length > total ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw invalidEmailResponse()
  return {
    items: items.map(sanitizeMailbox),
    total,
    page,
    pageSize: input.pageSize,
    storageDurable: row.storageDurable,
  }
}

export function sanitizeMailbox(item: MailboxView): MailboxView {
  const safeMessage = '刷新未成功，请检查授权和应用代理后重试。'
  return {
    ...item,
    lastError: item.lastError === null ? null : safeMessage,
    reception: {
      ...item.reception,
      lastError:
        item.reception.lastError === null
          ? null
          : '收信未成功，请检查授权和应用代理后重试。',
    },
  }
}
function mailAddress(value: unknown) {
  const row = object(value)
  if (!exact(row, ['name', 'address'])) throw invalidEmailResponse()
  return { name: string(row.name, 2048), address: string(row.address, 2048) }
}
const MESSAGE_KEYS = [
  'id',
  'subject',
  'from',
  'receivedAt',
  'isRead',
  'hasAttachments',
  'preview',
]
function parseMessage(value: unknown, detail = false): MailMessage {
  const row = object(value)
  if (
    !exact(
      row,
      detail ? [...MESSAGE_KEYS, 'to', 'body', 'html', 'truncated'] : MESSAGE_KEYS,
    )
  )
    throw invalidEmailResponse()
  return {
    id: string(row.id, 2048, 1),
    subject: string(row.subject, 4096),
    from: mailAddress(row.from),
    receivedAt: nullableTime(row.receivedAt),
    isRead: bool(row.isRead),
    hasAttachments: bool(row.hasAttachments),
    preview: string(row.preview, 4096),
  }
}
export function parseMessagePage(
  value: unknown,
  readState?: MailReadState,
): MailMessagePage {
  const row = object(value)
  if (!Array.isArray(row.items)) throw invalidEmailResponse()
  const items = row.items.map((item) => parseMessage(item))
  const total = integer(row.total)
  const unread = integer(row.unread, 0, total)
  if (
    items.length > 20 ||
    new Set(items.map((item) => item.id)).size !== items.length ||
    (readState === 'unread' && items.some((item) => item.isRead)) ||
    (readState === 'read' && items.some((item) => !item.isRead)) ||
    !(
      row.nextCursor === null ||
      (typeof row.nextCursor === 'string' &&
        row.nextCursor.length > 0 &&
        row.nextCursor.length <= 16_384)
    )
  )
    throw invalidEmailResponse()
  return { items, total, unread, nextCursor: row.nextCursor as string | null }
}
export function parseMessageDetail(
  value: unknown,
  expectedId: string,
): MailMessageDetail {
  const row = object(value)
  const message = parseMessage(row, true)
  if (
    message.id !== expectedId ||
    !Array.isArray(row.to) ||
    row.to.length > 100 ||
    typeof row.body !== 'string' ||
    new TextEncoder().encode(row.body).byteLength > 64 * 1024 ||
    !(
      row.html === null ||
      (typeof row.html === 'string' &&
        new TextEncoder().encode(row.html).byteLength <= 128 * 1024)
    )
  )
    throw invalidEmailResponse()
  return {
    ...message,
    to: row.to.map(mailAddress),
    body: row.body,
    html: row.html as string | null,
    truncated: bool(row.truncated),
  }
}
export function parseSettings(value: unknown): EmailSettings {
  const row = object(value)
  if (
    !exact(row, [
      'autoRefresh',
      'intervalMinutes',
      'autoReceive',
      'receiveIntervalMinutes',
    ])
  )
    throw invalidEmailResponse()
  return {
    autoRefresh: bool(row.autoRefresh),
    intervalMinutes: integer(row.intervalMinutes, 5, 1440),
    autoReceive: bool(row.autoReceive),
    receiveIntervalMinutes: integer(row.receiveIntervalMinutes, 1, 60),
  }
}
export function parseAuthorizationChallenge(value: unknown): EmailAuthorizationChallenge {
  const row = object(value)
  const verificationUri = string(row.verificationUri, 256)
  if (
    ![
      'https://microsoft.com/devicelogin',
      'https://www.microsoft.com/devicelogin',
      'https://login.microsoftonline.com/common/oauth2/deviceauth',
    ].includes(verificationUri) ||
    !/^[A-Z0-9-]+$/i.test(string(row.userCode, 32, 1)) ||
    !validTimestamp(row.expiresAt)
  )
    throw invalidEmailResponse('微软授权响应无效，请更新邮箱插件后重试。')
  return {
    authorizationId: string(row.authorizationId, 64, 1),
    userCode: row.userCode as string,
    verificationUri,
    expiresAt: row.expiresAt,
    intervalSeconds: integer(row.intervalSeconds, 1, 60),
  }
}
export function parseAuthorizationResult(
  value: unknown,
  expectedMailboxId: string,
): EmailAuthorizationResult {
  const row = object(value)
  if (row.status === 'pending')
    return {
      status: 'pending',
      retryAfterSeconds: integer(row.retryAfterSeconds, 1, 300),
    }
  if (['denied', 'expired', 'account-mismatch'].includes(String(row.status)))
    return { status: row.status as 'denied' | 'expired' | 'account-mismatch' }
  if (row.status === 'authorized') {
    const account = parseMailbox(row.account)
    if (account.id !== expectedMailboxId || account.transport !== 'graph')
      throw invalidEmailResponse('授权邮箱与当前邮箱不一致')
    return { status: 'authorized', account: sanitizeMailbox(account) }
  }
  throw invalidEmailResponse('授权状态无效')
}
export function validateMailboxInput(input: MailboxInput) {
  if (
    input.provider !== 'microsoft' ||
    !['graph', 'imap'].includes(input.transport) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.clientId) ||
    (input.password?.length ?? 0) > 512 ||
    (input.refreshToken &&
      (input.refreshToken.length > 16_384 || /\s/.test(input.refreshToken))) ||
    input.note.length > 1000
  )
    throw invalidEmailResponse('邮箱资料格式无效')
  if (!input.id && !input.refreshToken?.trim())
    throw invalidEmailResponse('新增邮箱需要填写 Refresh token')
  return {
    ...input,
    email: input.email.trim(),
    clientId: input.clientId.trim(),
    note: input.note.trim(),
  }
}
