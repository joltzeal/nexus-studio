import { describe, expect, it } from 'vitest'
import { extractEmailCode, isVintedVerification } from './email-otp'
import type { MailMessage, MailMessageDetail } from '@/features/email/types'

const email: MailMessage = {
  id: 'mail-1',
  subject: 'Verify your email address.',
  from: { name: 'Vinted', address: 'no-reply@vinted.com' },
  receivedAt: '2026-11-16T00:00:02Z',
  isRead: false,
  hasAttachments: false,
  preview: '',
}

describe('Vinted email verification', () => {
  it('accepts a current message from a Vinted domain and extracts exactly six digits', () => {
    expect(isVintedVerification(email, Date.parse('2026-11-16T00:00:00Z'))).toBe(true)
    expect(
      isVintedVerification(
        { ...email, from: { name: '', address: 'no-reply@vinted.co.uk' } },
        Date.parse('2026-11-16T00:00:00Z'),
      ),
    ).toBe(true)
    expect(
      extractEmailCode({
        ...email,
        body: 'Your code: 000001',
        html: null,
        to: [],
        truncated: false,
      } as MailMessageDetail),
    ).toBe('000001')
    expect(
      extractEmailCode({
        ...email,
        body: 'code 1234567',
        html: null,
        to: [],
        truncated: false,
      } as MailMessageDetail),
    ).toBeNull()
  })

  it('rejects unrelated sender, subject and messages predating the wait', () => {
    const start = Date.parse('2026-11-16T00:05:00Z')
    expect(isVintedVerification(email, start)).toBe(false)
    expect(isVintedVerification({ ...email, subject: 'Reset password' }, 0)).toBe(false)
    expect(
      isVintedVerification(
        { ...email, from: { name: '', address: 'no-reply@vinted.com.evil.test' } },
        0,
      ),
    ).toBe(false)
  })
})
