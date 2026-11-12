import { callPlugin, PluginCallError } from '@/lib/platform/native-plugins'
import { authorizationFailureMessage, EmailRequestError } from './errors'
import {
  MAILBOX_ERROR_CODES,
  MAILBOX_STATUSES,
  type EmailSettings,
  type ImportReport,
  type MailboxInput,
  type MailboxPage,
  type MailboxQuery,
  type MailboxView,
  type MailMessageDetail,
  type MailMessagePage,
  type MailTransport,
  type MessageQuery,
} from './types'

const encoder = new TextEncoder()
const MAX_IMPORT_BYTES = 512 * 1024
const mailboxKeys = [
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
  'accessExpiresAt',
  'lastAttemptAt',
  'lastRefreshedAt',
  'lastRotatedAt',
  'nextRefreshAt',
  'lastError',
  'lastErrorCode',
  'createdAt',
  'updatedAt',
] as const
const messageKeys = [
  'id',
  'subject',
  'from',
  'receivedAt',
  'isRead',
  'hasAttachments',
  'preview',
] as const

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function shape(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function text(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  )
}

function timestamp(value: unknown): value is string {
  return (
    text(value, 64, 1) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function nullableTimestamp(value: unknown): boolean {
  return value === null || timestamp(value)
}

function mailbox(value: unknown): value is MailboxView {
  return (
    shape(value, mailboxKeys) &&
    text(value.id, 64, 1) &&
    value.provider === 'microsoft' &&
    (value.transport === 'graph' || value.transport === 'imap') &&
    text(value.email, 254, 3) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) &&
    text(value.clientId, 128, 1) &&
    text(value.note, 1000) &&
    MAILBOX_STATUSES.some((status) => status === value.status) &&
    ['enabled', 'hasPassword', 'hasRefreshToken', 'refreshing'].every(
      (key) => typeof value[key] === 'boolean',
    ) &&
    [
      'accessExpiresAt',
      'lastAttemptAt',
      'lastRefreshedAt',
      'lastRotatedAt',
      'nextRefreshAt',
    ].every((key) => nullableTimestamp(value[key])) &&
    (value.lastError === null || text(value.lastError, 500)) &&
    (value.lastErrorCode === null ||
      MAILBOX_ERROR_CODES.some((code) => code === value.lastErrorCode)) &&
    timestamp(value.createdAt) &&
    timestamp(value.updatedAt)
  )
}

function address(value: unknown): boolean {
  return (
    shape(value, ['name', 'address']) &&
    text(value.name, 2048) &&
    text(value.address, 2048)
  )
}

function message(value: Record<string, unknown>): boolean {
  return (
    text(value.id, 2048, 1) &&
    text(value.subject, 4096) &&
    address(value.from) &&
    nullableTimestamp(value.receivedAt) &&
    typeof value.isRead === 'boolean' &&
    typeof value.hasAttachments === 'boolean' &&
    text(value.preview, 4096)
  )
}

function settings(value: unknown): value is EmailSettings {
  return (
    shape(value, ['autoRefresh', 'intervalMinutes']) &&
    typeof value.autoRefresh === 'boolean' &&
    integer(value.intervalMinutes, 5, 1440)
  )
}

function uniqueIds(items: { id: string }[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length
}

function safeMailbox(item: MailboxView): MailboxView {
  return {
    ...item,
    // Even a provider error must never echo credential-bearing upstream text.
    lastError:
      item.lastError === null
        ? null
        : (authorizationFailureMessage(item.lastErrorCode) ??
          '刷新未成功，请检查授权和应用代理后重试。'),
  }
}

async function call(
  method: string,
  payload: unknown,
  failure: string,
  deadlineMs?: number,
): Promise<unknown> {
  try {
    return await callPlugin<unknown>(
      'studio.email',
      'email.provider',
      method,
      payload,
      deadlineMs,
    )
  } catch (error) {
    if (
      error instanceof PluginCallError &&
      (error.code === 'AUTH_FAILED' || error.code === 'PERMISSION_DENIED')
    )
      throw new EmailRequestError(error.code)
    // eslint-disable-next-line preserve-caught-error -- Upstream failures may contain credentials.
    throw new Error(failure)
  }
}

export async function listMailboxes(input: MailboxQuery): Promise<MailboxPage> {
  const result = await call('email.accounts.list', input, '邮箱列表读取失败，请重试。')
  if (
    !shape(result, ['items', 'total', 'page', 'pageSize', 'storageDurable']) ||
    !Array.isArray(result.items) ||
    !result.items.every(mailbox) ||
    !integer(result.total) ||
    !integer(result.page, 1) ||
    result.pageSize !== input.pageSize ||
    typeof result.storageDurable !== 'boolean' ||
    result.page !==
      Math.min(input.page, Math.max(1, Math.ceil(result.total / input.pageSize))) ||
    result.items.length > input.pageSize ||
    result.items.length > result.total ||
    !uniqueIds(result.items)
  ) {
    throw new Error('邮箱列表返回的数据格式无效，请更新插件后重试。')
  }
  return {
    items: result.items.map(safeMailbox),
    total: result.total,
    page: result.page,
    pageSize: input.pageSize,
    storageDurable: result.storageDurable,
  }
}

export async function saveMailbox(input: MailboxInput): Promise<MailboxView> {
  const { password, refreshToken: tokenInput, ...fields } = input
  const refreshToken = tokenInput?.trim()
  if (!input.id && !refreshToken) throw new Error('新增邮箱需要 Refresh token。')
  const result = await call(
    'email.accounts.save',
    {
      ...fields,
      ...(password?.trim() ? { password } : {}),
      ...(refreshToken ? { refreshToken } : {}),
    },
    '邮箱保存失败，请检查资料或插件状态后重试。',
  )
  if (!mailbox(result) || (input.id !== undefined && result.id !== input.id)) {
    throw new Error('邮箱保存返回的数据格式无效，请刷新列表核对结果。')
  }
  return safeMailbox(result)
}

export async function importMailboxes(
  textInput: string,
  transport: MailTransport,
): Promise<ImportReport> {
  if (!textInput.trim() || encoder.encode(textInput).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('请输入导入内容，每批不超过 512 KiB。')
  }
  const result = await call(
    'email.accounts.import',
    { text: textInput, transport },
    '邮箱导入失败，请检查格式后重试。',
  )
  if (
    !shape(result, ['total', 'inserted', 'skipped', 'errors']) ||
    !integer(result.total, 0, 500) ||
    !integer(result.inserted) ||
    !integer(result.skipped) ||
    result.inserted + result.skipped !== result.total ||
    !Array.isArray(result.errors) ||
    result.errors.length > 50 ||
    !result.errors.every(
      (entry: unknown) =>
        shape(entry, ['row', 'message']) &&
        integer(entry.row, 1) &&
        text(entry.message, 1000),
    )
  ) {
    throw new Error('邮箱导入返回的数据格式无效，请刷新列表核对结果。')
  }
  return {
    total: result.total,
    inserted: result.inserted,
    skipped: result.skipped,
    errors: result.errors.map((entry: { row: number }) => ({
      row: entry.row,
      message: '该行未导入，请检查四段资料或邮箱是否已存在。',
    })),
  }
}

export async function removeMailbox(id: string): Promise<{ removed: true }> {
  const result = await call('email.accounts.remove', { id }, '邮箱删除失败，请重试。')
  if (!shape(result, ['removed']) || result.removed !== true) {
    throw new Error('邮箱删除结果无效，请刷新列表核对。')
  }
  return { removed: true }
}

export async function queueRefresh(
  ids: string[],
): Promise<{ queued: number; skipped: number }> {
  if (ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) {
    throw new Error('每批请选择 1–100 个邮箱。')
  }
  const result = await call('email.refresh.queue', { ids }, '刷新任务排队失败，请重试。')
  if (
    !shape(result, ['queued', 'skipped']) ||
    !integer(result.queued) ||
    !integer(result.skipped) ||
    result.queued + result.skipped !== ids.length
  ) {
    throw new Error('刷新任务返回的数据格式无效，请刷新列表核对。')
  }
  return { queued: result.queued, skipped: result.skipped }
}

export async function getSettings(): Promise<EmailSettings> {
  const result = await call('email.settings.get', {}, '刷新设置读取失败，请重试。')
  if (!settings(result)) throw new Error('刷新设置返回的数据格式无效。')
  return result
}

export async function saveSettings(input: EmailSettings): Promise<EmailSettings> {
  if (!settings(input)) throw new Error('刷新间隔须为 5–1440 分钟的整数。')
  const result = await call('email.settings.save', input, '刷新设置保存失败，请重试。')
  if (!settings(result)) throw new Error('刷新设置保存结果无效，请重新读取设置核对。')
  return result
}

export async function listMessages(input: MessageQuery): Promise<MailMessagePage> {
  const result = await call(
    'email.messages.list',
    input,
    '邮件列表读取失败，请检查邮箱授权和应用代理后重试。',
    120_000,
  )
  if (
    !shape(result, ['items', 'nextCursor']) ||
    !Array.isArray(result.items) ||
    result.items.length > 20 ||
    !result.items.every((item: unknown) => shape(item, messageKeys) && message(item)) ||
    !(result.nextCursor === null || text(result.nextCursor, 16 * 1024, 1)) ||
    !uniqueIds(result.items)
  ) {
    throw new Error('邮件列表返回的数据格式无效，请更新插件后重试。')
  }
  return result as unknown as MailMessagePage
}

export async function getMessage(
  input: Omit<MessageQuery, 'cursor'> & { messageId: string },
): Promise<MailMessageDetail> {
  const result = await call(
    'email.messages.get',
    input,
    '邮件详情读取失败，请检查邮箱授权和应用代理后重试。',
    120_000,
  )
  if (
    !shape(result, [...messageKeys, 'to', 'body', 'truncated']) ||
    !message(result) ||
    result.id !== input.messageId ||
    !Array.isArray(result.to) ||
    result.to.length > 100 ||
    !result.to.every(address) ||
    !text(result.body, 64 * 1024) ||
    encoder.encode(result.body).byteLength > 64 * 1024 ||
    typeof result.truncated !== 'boolean'
  ) {
    throw new Error('邮件详情返回的数据格式无效，请更新插件后重试。')
  }
  return result as unknown as MailMessageDetail
}
