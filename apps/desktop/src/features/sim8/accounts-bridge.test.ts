import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Account } from '@/features/accounts/types'
import { attachNumber, mergeAccountNumber, updateContact } from './accounts-bridge'

const state = vi.hoisted(() => ({
  calls: [] as { method: string; payload: unknown }[],
  items: [] as Account[],
}))

vi.mock('@/lib/platform/native-plugins', () => ({
  callPlugin: (
    _id: string,
    _capability: string,
    method: string,
    payload: unknown,
  ): Promise<unknown> => {
    state.calls.push({ method, payload })
    if (method === 'vinted.accounts.list') {
      return Promise.resolve({ items: state.items })
    }
    return Promise.resolve({})
  },
}))

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    loginMethod: 'email',
    account: 'alice@shop.com',
    password: 'p@ss word ',
    phone: '',
    emailOtpUrl: 'https://mail.example.com/a',
    smsOtpUrl: '',
    note: '主号',
    status: 'active',
    homepageUrl: 'https://vinted.fr',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

describe('account number bridge', () => {
  it('writes the number and its record link onto the account', () => {
    const input = mergeAccountNumber(
      account(),
      '+14155550100',
      'https://api.cc/r?token=t',
    )
    expect(input.phone).toBe('+14155550100')
    expect(input.smsOtpUrl).toBe('https://api.cc/r?token=t')
    expect(input.id).toBe('acc-1')
  })

  it('keeps every field the save method requires', () => {
    const input = mergeAccountNumber(account(), '+14155550100', 'https://api.cc/r')
    // The plugin's save schema is strict: exactly these keys, nothing else.
    expect(Object.keys(input).sort()).toEqual(
      [
        'account',
        'emailOtpUrl',
        'homepageUrl',
        'id',
        'loginMethod',
        'note',
        'password',
        'phone',
        'smsOtpUrl',
        'status',
      ].sort(),
    )
  })

  it('does not carry bookkeeping fields into the request', () => {
    const input = mergeAccountNumber(account(), '+14155550100', 'https://api.cc/r')
    expect('createdAt' in input).toBe(false)
    expect('updatedAt' in input).toBe(false)
  })

  it('preserves a password with trailing spaces', () => {
    const input = mergeAccountNumber(account(), '+1', 'https://api.cc/r')
    expect(input.password).toBe('p@ss word ')
  })

  it('replaces a previous record link rather than keeping both', () => {
    const input = mergeAccountNumber(
      account({ smsOtpUrl: 'https://old.example.com/r', phone: '+100' }),
      '+14155550100',
      'https://api.cc/r?token=new',
    )
    expect(input.smsOtpUrl).toBe('https://api.cc/r?token=new')
    expect(input.phone).toBe('+14155550100')
  })
})

describe('contact updates', () => {
  beforeEach(() => {
    state.calls.length = 0
    state.items = [account()]
  })

  it('writes the link alone and leaves the number in place', async () => {
    await updateContact('acc-1', { smsOtpUrl: 'https://api.cc/r?token=t' })
    const save = state.calls.find((entry) => entry.method === 'vinted.accounts.save')
    expect(save?.payload).toMatchObject({
      id: 'acc-1',
      phone: '',
      smsOtpUrl: 'https://api.cc/r?token=t',
    })
  })

  it('keeps an existing number when only the link changes', async () => {
    state.items = [account({ phone: '+14155550100' })]
    await updateContact('acc-1', { smsOtpUrl: 'https://api.cc/r?token=t' })
    const save = state.calls.find((entry) => entry.method === 'vinted.accounts.save')
    expect(save?.payload).toMatchObject({ phone: '+14155550100' })
  })

  it('does not spend a save on an unchanged record', async () => {
    await updateContact('acc-1', { smsOtpUrl: '' })
    expect(state.calls.map((entry) => entry.method)).toEqual(['vinted.accounts.list'])
  })

  it('refuses an account that no longer exists', async () => {
    await expect(updateContact('gone', { smsOtpUrl: 'https://x' })).rejects.toThrow(
      '账号不存在',
    )
    expect(state.calls.map((entry) => entry.method)).toEqual(['vinted.accounts.list'])
  })

  it('writes both fields when a number is attached', async () => {
    await attachNumber('acc-1', '+14155550100', 'https://api.cc/r?token=t')
    const save = state.calls.find((entry) => entry.method === 'vinted.accounts.save')
    expect(save?.payload).toMatchObject({
      phone: '+14155550100',
      smsOtpUrl: 'https://api.cc/r?token=t',
    })
  })
})
