// UI contract for email.provider. Never import the plugin's private implementation.
export type MailTransport = 'graph' | 'imap'
export type MailFolder = 'inbox' | 'junkemail'
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
  truncated: boolean
}

export interface MailMessagePage {
  items: MailMessage[]
  nextCursor: string | null
}

export interface MessageQuery {
  accountId: string
  folder: MailFolder
  cursor?: string
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
