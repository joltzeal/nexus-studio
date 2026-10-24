import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Account } from '@/features/accounts/types'
import {
  attachNumber,
  indexAccountPhones,
  mergeAccountNumber,
  updateContact,
} from './accounts-bridge'

const state = vi.hoisted(() => ({
  calls: [] as { method: string; payload: unknown }[],
  items: [] as Account[],
  saved: null as Account | null,
  saveError: null as Error | null,
  listError: null as Error | null,
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
      if (state.listError) return Promise.reject(state.listError)
      return Promise.resolve({ items: state.items })
    }
    if (method === 'vinted.accounts.save') {
      if (state.saveError) return Promise.reject(state.saveError)
      return Promise.resolve({
        item: state.saved ?? { ...state.items[0], ...(payload as object) },
        created: false,
      })
    }
    return Promise.reject(new Error(`Unexpected method: ${method}`))
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
    state.saved = null
    state.saveError = null
    state.listError = null
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
    const result = await updateContact('acc-1', { smsOtpUrl: '' })
    expect(state.calls.map((entry) => entry.method)).toEqual(['vinted.accounts.list'])
    expect(result).toEqual(account())
  })

  it('refuses an account that no longer exists', async () => {
    await expect(updateContact('gone', { smsOtpUrl: 'https://x' })).rejects.toThrow(
      '账号不存在',
    )
    expect(state.calls.map((entry) => entry.method)).toEqual(['vinted.accounts.list'])
  })

  it('writes both fields when a number is attached', async () => {
    const result = await attachNumber('acc-1', '+14155550100', 'https://api.cc/r?token=t')
    const save = state.calls.find((entry) => entry.method === 'vinted.accounts.save')
    expect(save?.payload).toMatchObject({
      id: 'acc-1',
      phone: '+14155550100',
      smsOtpUrl: 'https://api.cc/r?token=t',
    })
    expect(result).toMatchObject({
      id: 'acc-1',
      phone: '+14155550100',
      smsOtpUrl: 'https://api.cc/r?token=t',
    })
  })

  it('returns the persisted account so the next code read sees the saved link', async () => {
    state.items = [
      account({
        phone: '+14155550100',
        smsOtpUrl: 'https://old.example.com/sms',
      }),
    ]
    state.saved = account({
      phone: '+14155550100',
      smsOtpUrl: 'https://new.example.com/sms',
      updatedAt: '2026-10-24T01:00:00.000Z',
    })
    const result = await updateContact('acc-1', {
      smsOtpUrl: 'https://new.example.com/sms',
    })
    expect(result).toEqual(state.saved)
    expect(result?.phone).toBe('+14155550100')
  })

  it('uses the selected account and preserves its latest fields from the fresh lookup', async () => {
    state.items = [
      account(),
      account({
        id: 'acc-2',
        account: 'second@example.com',
        phone: '+442079460000',
        note: 'updated elsewhere',
      }),
    ]
    await updateContact('acc-2', { smsOtpUrl: 'https://sms.example.com/new' })
    const save = state.calls.find((entry) => entry.method === 'vinted.accounts.save')
    expect(save?.payload).toEqual({
      id: 'acc-2',
      loginMethod: 'email',
      account: 'second@example.com',
      password: 'p@ss word ',
      phone: '+442079460000',
      emailOtpUrl: 'https://mail.example.com/a',
      smsOtpUrl: 'https://sms.example.com/new',
      note: 'updated elsewhere',
      status: 'active',
      homepageUrl: 'https://vinted.fr',
    })
  })

  it('propagates a failed save without changing the account snapshot or patch', async () => {
    const before = account({ phone: '+14155550100' })
    state.items = [before]
    state.saveError = new Error('write failed')
    const patch = { smsOtpUrl: 'https://sms.example.com/draft' }

    await expect(updateContact('acc-1', patch)).rejects.toThrow('write failed')
    expect(state.items).toEqual([account({ phone: '+14155550100' })])
    expect(patch).toEqual({ smsOtpUrl: 'https://sms.example.com/draft' })
  })

  it('does not attempt a save when account lookup fails', async () => {
    state.listError = new Error('accounts unavailable')
    await expect(
      attachNumber('acc-1', '+14155550100', 'https://sms.example.com'),
    ).rejects.toThrow('accounts unavailable')
    expect(state.calls.map((entry) => entry.method)).toEqual(['vinted.accounts.list'])
  })
})

describe('account phone occupancy', () => {
  it('groups formatting variants and retains every account using the number', () => {
    const usage = indexAccountPhones([
      account({ id: 'current', phone: '+1 (415) 555-0100' }),
      account({ id: 'other-1', phone: '1 415 555 0100' }),
      account({ id: 'other-2', phone: '+1.415.555.0100' }),
    ])
    expect(usage.get('14155550100')?.map((item) => item.id)).toEqual([
      'current',
      'other-1',
      'other-2',
    ])
  })

  it('does not infer country codes or strip meaningful leading zeroes', () => {
    const usage = indexAccountPhones([
      account({ id: 'international', phone: '+44 20 7946 0000' }),
      account({ id: 'local', phone: '020 7946 0000' }),
      account({ id: 'international-prefix', phone: '0044 20 7946 0000' }),
    ])
    expect(usage.get('442079460000')?.map((item) => item.id)).toEqual(['international'])
    expect(usage.get('02079460000')?.map((item) => item.id)).toEqual(['local'])
    expect(usage.get('00442079460000')?.map((item) => item.id)).toEqual([
      'international-prefix',
    ])
  })

  it('does not treat empty or formatting-only values as occupied numbers', () => {
    const usage = indexAccountPhones([
      account({ phone: '' }),
      account({ id: 'blank', phone: ' + - ( ) ' }),
    ])
    expect(usage.size).toBe(0)
  })
})
