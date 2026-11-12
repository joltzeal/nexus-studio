import type { PluginErrorCode } from './errors.js'

export type MailTransport = 'graph' | 'imap'
export type MailFolder = 'inbox' | 'junkemail'
export type MailReadState = 'all' | 'unread' | 'read'
export type MailboxStatus = 'pending' | 'active' | 'reauth-required' | 'error' | 'paused'

export interface MailCredentials {
  email: string
  clientId: string
  refreshToken: string
}

export interface TokenSet {
  accessToken: string
  /** Absent means keep the current refresh token. */
  refreshToken?: string
  expiresIn: number
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

export interface MailMessagePage {
  items: MailMessage[]
  /** Opaque cursor validated by the producing client, never an arbitrary URL. */
  nextCursor: string | null
  total: number
  unread: number
}

export interface MailSession {
  email: string
  accessToken: string
}

export interface MailListInput {
  folder: MailFolder
  cursor?: string
  readState?: MailReadState
}

export interface MailGetInput {
  folder: MailFolder
  messageId: string
}

export interface MailReadInput extends MailGetInput {
  isRead: boolean
}

export interface TokenRefresher {
  refresh(credentials: MailCredentials, signal: AbortSignal): Promise<TokenSet>
}

export interface MailboxClient {
  list(
    session: MailSession,
    input: MailListInput,
    signal: AbortSignal,
  ): Promise<MailMessagePage>
  get(
    session: MailSession,
    input: MailGetInput,
    signal: AbortSignal,
  ): Promise<MailMessageDetail>
  setRead(session: MailSession, input: MailReadInput, signal: AbortSignal): Promise<void>
}

export interface EmailProvider {
  tokens: TokenRefresher
  mailbox: MailboxClient
}

/** A provider owns its matching authentication and mailbox clients. */
export abstract class EmailProviderFactory {
  abstract readonly id: string
  abstract create(transport: MailTransport): EmailProvider
}

export interface MailboxRecord {
  id: string
  provider: string
  transport: MailTransport
  email: string
  password: string
  clientId: string
  refreshToken: string
  accessToken: string | null
  accessExpiresAt: string | null
  credentialRevision: string
  note: string
  enabled: boolean
  status: MailboxStatus
  lastAttemptAt: string | null
  lastRefreshedAt: string | null
  lastRotatedAt: string | null
  nextRefreshAt: string | null
  refreshRequested: boolean
  consecutiveFailures: number
  lastError: string | null
  lastErrorCode: PluginErrorCode | null
  reception: MailReceptionState
  receiveRequested: boolean
  receiveFailures: number
  createdAt: string
  updatedAt: string
}

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
  lastErrorCode: PluginErrorCode | null
  createdAt: string
  updatedAt: string
}

export interface EmailSettings {
  autoRefresh: boolean
  intervalMinutes: number
  autoReceive: boolean
  receiveIntervalMinutes: number
}

export interface MailReceptionState {
  lastCheckedAt: string | null
  nextCheckAt: string | null
  latestReceivedAt: string | null
  lastError: string | null
  lastErrorCode: PluginErrorCode | null
  inbox: { total: number; unread: number } | null
  junkemail: { total: number; unread: number } | null
}

export interface ImportReport {
  total: number
  inserted: number
  skipped: number
  errors: { row: number; message: string }[]
}
