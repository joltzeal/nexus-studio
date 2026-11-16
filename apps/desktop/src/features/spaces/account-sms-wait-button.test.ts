import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeSmsWaits } from '@/features/accounts/sms-wait-runtime'
import type { Account } from '@/features/accounts/types'
import { AccountSmsWaitButton } from './account-sms-wait-button'

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}))
const account: Account = {
  id: 'account',
  account: 'seller@example.invalid',
  password: '',
  phone: '+447700900123',
  smsOtpUrl: 'https://example.invalid/sms',
  emailOtpUrl: '',
  loginMethod: 'email',
  note: '',
  status: 'active',
  homepageUrl: '',
  mailbox: {
    pluginId: 'studio.email',
    mailboxId: 'mail-one',
    email: 'seller@example.invalid',
    linkedAt: '2026-10-27T00:00:00Z',
  },
  createdAt: '2026-10-27T00:00:00Z',
  updatedAt: '2026-10-27T00:00:00Z',
}
const render = (changes: Partial<Parameters<typeof AccountSmsWaitButton>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AccountSmsWaitButton, {
      account,
      windowId: 'window',
      windowName: 'Shop',
      ready: true,
      emailReady: true,
      ...changes,
    }),
  )
afterEach(() => disposeSmsWaits())

describe('window OTP controls', () => {
  it('renders separate SMS and Email controls', () => {
    const html = render()
    expect(html).toContain('OTP:')
    expect(html).toContain('SMS</button>')
    expect(html).toContain('Email</button>')
    expect(html).not.toContain('disabled=""')
  })

  it('disables only unavailable channels', () => {
    const html = render({ account: { ...account, phone: '', smsOtpUrl: '' } })
    expect(html).toMatch(/SMS<\/button>/)
    expect(html).toContain('请先填写手机号')
    expect(html).toContain('Email</button>')
    const noEmail = render({ account: { ...account, mailbox: null } })
    expect(noEmail).toContain('请先关联邮箱')
  })
})
