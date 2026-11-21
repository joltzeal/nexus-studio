export const EMAIL_PLUGIN_ID = 'studio.email'
export const EMAIL_CAPABILITY = 'email.provider'
export const EMAIL_METHODS = {
  base: [
    'email.accounts.list',
    'email.accounts.get',
    'email.accounts.save',
    'email.accounts.import',
    'email.accounts.remove',
    'email.refresh.queue',
    'email.receive.queue',
    'email.settings.get',
    'email.settings.save',
    'email.messages.list',
    'email.messages.get',
    'email.messages.read',
    'email.authorization.start',
    'email.authorization.poll',
    'email.authorization.cancel',
  ],
  targets: ['email.accounts.targets'],
  export: ['email.accounts.export'],
} as const
export type MailTransport = 'graph' | 'imap'
export type MailFolder = 'inbox' | 'junkemail'
export type MailReadState = 'all' | 'unread' | 'read'
export type MailboxStatus = 'pending' | 'active' | 'reauth-required' | 'error' | 'paused'
export const MAILBOX_STATUSES: readonly MailboxStatus[] = [
  'pending',
  'active',
  'reauth-required',
  'error',
  'paused',
]
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
export interface MailboxView {
  id: string
  provider: 'microsoft'
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
export interface MailboxQuery {
  query?: string
  status?: MailboxStatus
  page: number
  pageSize: 20 | 50
}
export interface MailboxPage {
  items: MailboxView[]
  total: number
  page: number
  pageSize: 20 | 50
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
export interface MailboxIdentity {
  id: string
  email: string
  enabled: boolean
}
export interface MailboxExportFile {
  filename: string
  transport: MailTransport
  count: number
  text: string
}
export interface EmailSettings {
  autoRefresh: boolean
  intervalMinutes: number
  autoReceive: boolean
  receiveIntervalMinutes: number
}
export const STATUS_LABELS: Record<MailboxStatus, string> = {
  pending: '待刷新',
  active: '正常',
  'reauth-required': '需要重新授权',
  error: '刷新失败',
  paused: '已暂停',
}
export function formatMailTime(value: string | null) {
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
export interface EmailAuthorizationChallenge {
  authorizationId: string
  userCode: string
  verificationUri: string
  expiresAt: string
  intervalSeconds: number
}
export type EmailAuthorizationResult =
  | { status: 'pending'; retryAfterSeconds: number }
  | { status: 'denied' | 'expired' | 'account-mismatch' }
  | { status: 'authorized'; account: MailboxView }
