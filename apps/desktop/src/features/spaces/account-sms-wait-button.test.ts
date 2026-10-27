import { createElement, type MouseEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeSmsWaits, smsWaits } from '@/features/accounts/sms-wait-runtime'
import type { Account } from '@/features/accounts/types'
import { AccountSmsWaitButton } from './account-sms-wait-button'

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}))
vi.mock('@/features/accounts/api', () => ({
  listAccounts: async () => ({ items: [], bindings: [], total: 0, storageDurable: true }),
  readOtp: async () => {
    throw new Error('No SMS request expected')
  },
}))

const account: Account = {
  id: 'account',
  account: 'seller@example.invalid',
  password: 'synthetic',
  phone: '+447700900123',
  smsOtpUrl: 'https://inbox.example.invalid/synthetic',
  emailOtpUrl: '',
  loginMethod: 'email',
  note: '',
  status: 'active',
  homepageUrl: '',
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
      ...changes,
    }),
  )
afterEach(() => disposeSmsWaits())

describe('window row SMS wait button', () => {
  it('provides an enabled wait action when the saved phone and SMS link exist', () => {
    const html = render()
    expect(html).toContain('等待验证码')
    expect(html).not.toContain('disabled=""')
    expect(smsWaits.getSnapshot()).toEqual([])
  })
  it('hides the action for accounts without a phone', () => {
    expect(render({ account: { ...account, phone: '' } })).toBe('')
  })
  it('explains a missing SMS link and blocks starting', () => {
    const html = render({ account: { ...account, smsOtpUrl: '' } })
    expect(html).toContain('短信接码链接')
    expect(html).toContain('disabled=""')
  })
  it('blocks a new wait while the account plugin or phone write is unavailable', () => {
    expect(render({ ready: false })).toContain('disabled=""')
  })
  it('shows one shared waiting state and keeps the stop action available', () => {
    smsWaits.start({
      accountId: account.id,
      accountName: account.account,
      phone: account.phone,
      smsOtpUrl: account.smsOtpUrl,
      windowId: 'window',
      windowName: 'Shop',
    })
    const html = render({ ready: false })
    expect(html).toContain('停止等待')
    expect(html).toContain('等待中')
    expect(html).not.toContain('disabled=""')
    expect(render({ windowId: 'other-window' })).toContain('等待中')
  })
  it('ignores a second click before repaint instead of cancelling the newly started wait', () => {
    const button = AccountSmsWaitButton({
      account,
      windowId: 'window',
      windowName: 'Shop',
      ready: true,
    })!
    const click = button.props.onClick as (event: MouseEvent<HTMLButtonElement>) => void
    click({} as MouseEvent<HTMLButtonElement>)
    click({} as MouseEvent<HTMLButtonElement>)
    expect(smsWaits.getSnapshot()).toHaveLength(1)
    const waiting = AccountSmsWaitButton({
      account,
      windowId: 'window',
      windowName: 'Shop',
      ready: true,
    })!
    const stop = waiting.props.onClick as (event: MouseEvent<HTMLButtonElement>) => void
    stop({} as MouseEvent<HTMLButtonElement>)
    expect(smsWaits.getSnapshot()).toEqual([])
  })
})
