import type { MailMessage, MailMessageDetail } from '@/features/email/types'

export function isVintedVerification(message: MailMessage, startedAt: number): boolean {
  const sender = message.from.address.trim().toLowerCase()
  const subject = message.subject.trim().toLowerCase().replace(/\.$/, '')
  const received = message.receivedAt ? Date.parse(message.receivedAt) : NaN
  return (
    /^no-reply@vinted\.[a-z]{2,10}(?:\.[a-z]{2,3})?$/.test(sender) &&
    subject === 'verify your email address' &&
    Number.isFinite(received) &&
    received >= startedAt - 5 * 60_000
  )
}

export function extractEmailCode(message: MailMessageDetail): string | null {
  return /(?:^|[^\d])(\d{6})(?!\d)/.exec(message.body)?.[1] ?? null
}
