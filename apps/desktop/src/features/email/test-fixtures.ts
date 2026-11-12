import type { MailboxView, MailMessage } from './types'

export function mailbox(patch: Partial<MailboxView> = {}): MailboxView {
  return {
    id: 'mailbox-1',
    provider: 'microsoft',
    transport: 'graph',
    email: 'reader@example.test',
    clientId: 'synthetic-client',
    note: '',
    enabled: true,
    status: 'active',
    hasPassword: true,
    hasRefreshToken: true,
    refreshing: false,
    accessExpiresAt: '2026-11-12T13:00:00Z',
    lastAttemptAt: '2026-11-12T12:00:00Z',
    lastRefreshedAt: '2026-11-12T12:00:00Z',
    lastRotatedAt: null,
    nextRefreshAt: '2026-11-12T12:55:00Z',
    lastError: null,
    lastErrorCode: null,
    createdAt: '2026-11-12T11:00:00Z',
    updatedAt: '2026-11-12T12:00:00Z',
    ...patch,
  }
}

export function message(patch: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'message-1',
    subject: 'Synthetic subject',
    from: { name: 'Sender', address: 'sender@example.test' },
    receivedAt: '2026-11-12T12:00:00Z',
    isRead: false,
    hasAttachments: false,
    preview: 'Synthetic preview',
    ...patch,
  }
}
