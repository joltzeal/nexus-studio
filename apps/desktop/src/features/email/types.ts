// UI contract for email.provider. Never import the plugin's private implementation.
export type MailTransport = 'graph' | 'imap'
export type MailFolder = 'inbox' | 'junkemail'
export type MailReadState = 'all' | 'unread' | 'read'
export type MailboxStatus = 'pending' | 'active' | 'reauth-required' | 'error' | 'paused'
export type MailboxPageSize = 20 | 50
export const MAILBOX_ERROR_CODES = [
  'INVALID_REQUEST',
  'PERMISSION_DENIED',
  'NOT_CONFIGURED',
  'UNAVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
  'CANCELLED',
  'AUTH_FAILED',
  'PROTOCOL_ERROR',
] as const
export type MailboxErrorCode = (typeof MAILBOX_ERROR_CODES)[number]

export interface MailboxView {
  id: string
  provider: string
  transport: MailTransport
  email: string
  clientId: string
  note: string
  enabled: boolean
  status: MailboxStatus
  hasPassword: boolean
  hasRefreshToken: boolean
  refreshing: boolean
  receiving: boolean
  reception: MailReceptionState
  accessExpiresAt: string | null
  lastAttemptAt: string | null
  lastRefreshedAt: string | null
  lastRotatedAt: string | null
  nextRefreshAt: string | null
  lastError: string | null
  lastErrorCode: MailboxErrorCode | null
  createdAt: string
  updatedAt: string
}

export interface MailFolderCounts {
  total: number
  unread: number
}

export interface MailReceptionState {
  lastCheckedAt: string | null
  nextCheckAt: string | null
  latestReceivedAt: string | null
  lastError: string | null
  lastErrorCode: MailboxErrorCode | null
  inbox: MailFolderCounts | null
  junkemail: MailFolderCounts | null
}

export interface MailboxQuery {
  query?: string
  status?: MailboxStatus
  page: number
  pageSize: MailboxPageSize
}

export interface MailboxPage {
  items: MailboxView[]
  total: number
  page: number
  pageSize: MailboxPageSize
  storageDurable: boolean
}

export type MailboxTarget = Pick<MailboxView, 'id' | 'email' | 'enabled' | 'status'>
export interface MailboxTargetQuery {
  query?: string
  page?: number
  pageSize?: number
}
export interface MailboxTargetPage {
  items: MailboxTarget[]
  total: number
  page: number
  pageSize: number
  storageDurable: boolean
}

export interface MailboxInput {
  id?: string
  provider: 'microsoft'
  transport: MailTransport
  email: string
  clientId: string
  password?: string
  refreshToken?: string
  note: string
  enabled: boolean
}

export interface ImportReport {
  total: number
  inserted: number
  skipped: number
  errors: { row: number; message: string }[]
}

export interface EmailSettings {
  autoRefresh: boolean
  intervalMinutes: number
  autoReceive: boolean
  receiveIntervalMinutes: number
}

export interface MailAddress {
  name: string
  address: string
}

export interface MailMessage {
  id: string
  subject: string
  from: MailAddress
  receivedAt: string | null
  isRead: boolean
  hasAttachments: boolean
  preview: string
}

export interface MailMessageDetail extends MailMessage {
  to: MailAddress[]
  body: string
  html: string | null
  truncated: boolean
}

export interface MailMessagePage extends MailFolderCounts {
  items: MailMessage[]
  nextCursor: string | null
}

export interface MessageQuery {
  accountId: string
  expectedEmail?: string
  folder: MailFolder
  cursor?: string
  readState?: MailReadState
}

export type MessageDetailQuery = Pick<
  MessageQuery,
  'accountId' | 'expectedEmail' | 'folder'
> & {
  messageId: string
}

export type MessageReadInput = Pick<
  MessageQuery,
  'accountId' | 'expectedEmail' | 'folder'
> & {
  messageIds: string[]
  isRead: boolean
}

export interface MessageReadResult {
  updatedIds: string[]
  failures: { messageId: string; code: MailboxErrorCode }[]
  isRead: boolean
}

export const MAILBOX_STATUSES: readonly MailboxStatus[] = [
  'pending',
  'active',
  'reauth-required',
  'error',
  'paused',
]

export const STATUS_LABELS: Record<MailboxStatus, string> = {
  pending: '待刷新',
  active: '正常',
  'reauth-required': '需要重新授权',
  error: '刷新失败',
  paused: '已暂停',
}

export function formatMailTime(value: string | null): string {
  if (value === null) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

const mailTags = new Set([
  'p',
  'div',
  'span',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
])

function mailText(value: string): string {
  return value
    .replace(/&(?!(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function mailHtmlDocument(html: string): string {
  // Reconstruct fixed inert tags without attributes. Provider markup never
  // reaches the host DOM, even while parsing, and no URL or navigation survives.
  const fragments: string[] = []
  let offset = 0
  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (start === -1) {
      fragments.push(mailText(html.slice(offset)))
      break
    }
    fragments.push(mailText(html.slice(offset, start)))
    const end = html.indexOf('>', start + 1)
    if (end === -1) {
      fragments.push(mailText(html.slice(start)))
      break
    }
    const token = html.slice(start, end + 1)
    const name = /^<\/?([a-z][a-z\d]*)\b/i.exec(token)?.[1]?.toLowerCase()
    if (name && mailTags.has(name))
      fragments.push(`<${token.startsWith('</') ? '/' : ''}${name}>`)
    offset = end + 1
  }
  const policy = [
    "default-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "style-src 'unsafe-inline'",
  ].join('; ')
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>:root{color-scheme:light dark}body{margin:12px;background:Canvas;color:CanvasText;font:14px/1.6 sans-serif;overflow-wrap:anywhere}pre{white-space:pre-wrap}table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto}td,th{padding:4px 8px;text-align:start}blockquote{margin-inline:12px;padding-inline:12px;border-inline-start:2px solid GrayText}</style></head><body>${fragments.join('')}</body></html>`
}
