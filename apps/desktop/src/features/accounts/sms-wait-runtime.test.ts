import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToasts, toastSnapshot } from '@/components/ui/toast'
import {
  disposeSmsWaits,
  reconcileSmsWaitPlugin,
  smsWaits,
  startSmsWait,
} from './sms-wait-runtime'
import {
  ACCOUNTS_PLUGIN_ID,
  type Account,
  type AccountList,
  type OtpResult,
} from './types'
import type { SmsWaitTarget } from './sms-wait'

const state = vi.hoisted(() => ({
  account: null as Account | null,
  binding: true,
  read: null as (() => Promise<OtpResult>) | null,
  list: null as (() => Promise<AccountList>) | null,
  calls: [] as string[],
  arm: vi.fn(async () => true),
  play: vi.fn(async () => true),
  close: vi.fn(),
}))
vi.mock('./verification-sound', () => ({
  VerificationSound: class {
    arm = state.arm
    play = state.play
    close = state.close
  },
}))
vi.mock('@/lib/platform/native-plugins', () => ({
  callPlugin: async (
    id: string,
    capability: string,
    method: string,
    payload: unknown,
  ) => {
    expect(id).toBe('studio.vinted-accounts')
    expect(capability).toBe('account.pool')
    state.calls.push(method)
    if (method === 'vinted.accounts.list') {
      return state.list
        ? state.list()
        : {
            items: state.account ? [{ ...state.account }] : [],
            total: state.account ? 1 : 0,
            bindings: state.binding
              ? [
                  {
                    accountId: 'account-one',
                    windowId: 'window-one',
                    boundAt: '2026-10-27T00:00:00Z',
                  },
                ]
              : [],
            storageDurable: true,
          }
    }
    if (method === 'vinted.accounts.otp') {
      expect(payload).toEqual({ accountId: 'account-one', channel: 'sms' })
      return state.read!()
    }
    throw new Error(`Unexpected method: ${method}`)
  },
}))
const target: SmsWaitTarget = {
  accountId: 'account-one',
  accountName: 'seller@example.invalid',
  windowId: 'window-one',
  windowName: 'Shop window',
  phone: '+447700900123',
  smsOtpUrl: 'https://inbox.example.invalid/synthetic-token',
}
const plugin = {
  id: ACCOUNTS_PLUGIN_ID,
  enabled: true,
  state: 'running' as const,
  version: '1.0.0',
  status: { pid: 123 },
}
const result = (code: string | null): OtpResult => ({
  channel: 'sms',
  code,
  body: code ?? 'Waiting',
  truncated: false,
  contentType: 'text/plain',
  fetchedAt: '2026-10-27T00:00:00Z',
})
const flush = () => vi.advanceTimersByTimeAsync(0)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const notices = () =>
  toastSnapshot()
    .map((notice) => notice.message)
    .join('\n')

beforeEach(() => {
  vi.useFakeTimers()
  disposeSmsWaits()
  clearToasts()
  state.account = {
    id: target.accountId,
    account: target.accountName,
    phone: target.phone,
    smsOtpUrl: target.smsOtpUrl,
    emailOtpUrl: '',
    password: 'synthetic',
    loginMethod: 'email',
    note: '',
    status: 'active',
    homepageUrl: '',
    createdAt: '2026-10-27T00:00:00Z',
    updatedAt: '2026-10-27T00:00:00Z',
  }
  state.binding = true
  state.calls = []
  state.list = null
  state.read = async () => result(null)
  vi.clearAllMocks()
  state.play.mockResolvedValue(true)
  reconcileSmsWaitPlugin([plugin])
})
afterEach(() => {
  disposeSmsWaits()
  clearToasts()
  vi.useRealTimers()
})

describe('SMS wait integration', () => {
  it('uses the saved account SMS link, unlocks sound on the click, then toasts and plays once on a code', async () => {
    state.read = async () => result('654321')
    startSmsWait(target)
    expect(state.arm).toHaveBeenCalledOnce()
    await flush()
    expect(state.calls).toEqual([
      'vinted.accounts.list',
      'vinted.accounts.otp',
      'vinted.accounts.list',
    ])
    expect(notices()).toContain('654321')
    expect(notices()).toContain(target.phone)
    expect(notices()).toContain(target.windowName)
    expect(notices()).not.toContain(target.smsOtpUrl)
    expect(toastSnapshot()[0]?.action?.label).toBe('复制验证码')
    expect(state.play).toHaveBeenCalledOnce()
    expect(smsWaits.getSnapshot()).toEqual([])
    await vi.advanceTimersByTimeAsync(20000)
    expect(state.calls).toHaveLength(3)
    expect(notices()).toContain('654321')
  })

  it.each(['phone', 'smsOtpUrl', 'account', 'binding'] as const)(
    'rejects changed %s before requesting SMS',
    async (field) => {
      if (field === 'phone') state.account!.phone = '+447700900999'
      if (field === 'smsOtpUrl')
        state.account!.smsOtpUrl = 'https://other.example.invalid'
      if (field === 'account') state.account = null
      if (field === 'binding') state.binding = false
      startSmsWait(target)
      await flush()
      expect(state.calls).toEqual(['vinted.accounts.list'])
      expect(smsWaits.getSnapshot()).toEqual([])
      expect(state.play).not.toHaveBeenCalled()
      expect(notices()).toContain('停止等待')
    },
  )

  it('discards a code when the contact changes during the request', async () => {
    const pending = deferred<OtpResult>()
    state.read = () => pending.promise
    startSmsWait(target)
    await flush()
    state.account!.smsOtpUrl = 'https://other.example.invalid'
    pending.resolve(result('654321'))
    await flush()
    expect(notices()).not.toContain('654321')
    expect(state.play).not.toHaveBeenCalled()
    expect(smsWaits.getSnapshot()).toEqual([])
  })

  it('does not initiate an SMS request after cancellation while the account snapshot is still loading', async () => {
    const pending = deferred<AccountList>()
    state.list = () => pending.promise
    startSmsWait(target)
    await flush()
    smsWaits.stop(target.accountId)
    pending.resolve({
      items: [state.account!],
      total: 1,
      bindings: [{ accountId: target.accountId, windowId: target.windowId, boundAt: '' }],
      storageDurable: true,
    })
    await flush()
    expect(state.calls).toEqual(['vinted.accounts.list'])
    expect(state.play).not.toHaveBeenCalled()
  })

  it('keeps the code toast even when sound cannot play', async () => {
    state.read = async () => result('1234')
    state.play.mockResolvedValue(false)
    startSmsWait(target)
    await flush()
    expect(notices()).toContain('1234')
    expect(notices()).toContain('提示音')
    expect(smsWaits.getSnapshot()).toEqual([])
  })

  it.each([
    { catalog: [] },
    { catalog: [{ ...plugin, enabled: false }] },
    { catalog: [{ ...plugin, state: 'retrying' as const }] },
    { catalog: [{ ...plugin, status: { pid: 456 } }] },
    { catalog: [{ ...plugin, version: '1.0.1' }] },
  ])(
    'stops waits when the account plugin is replaced or unavailable',
    async ({ catalog }) => {
      const pending = deferred<OtpResult>()
      state.read = () => pending.promise
      startSmsWait(target)
      await flush()
      try {
        reconcileSmsWaitPlugin(catalog)
        expect(smsWaits.getSnapshot()).toEqual([])
      } finally {
        pending.resolve(result('1234'))
        await flush()
      }
      expect(notices()).not.toContain('1234')
      expect(state.play).not.toHaveBeenCalled()
    },
  )

  it('reports expiry once and app disposal closes sound without restarting waits', async () => {
    startSmsWait(target)
    await vi.advanceTimersByTimeAsync(300000)
    expect(notices()).toContain('5 分钟')
    expect(smsWaits.getSnapshot()).toEqual([])
    disposeSmsWaits()
    expect(state.close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(300000)
    expect(state.calls.filter((method) => method.endsWith('.otp'))).toHaveLength(60)
    expect(state.play).not.toHaveBeenCalled()
  })
})
