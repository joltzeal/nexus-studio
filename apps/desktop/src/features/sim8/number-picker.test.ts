import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NumberPoolList, NumberPoolOptions, NumberPoolPicker } from './number-picker'
import type { AccountTarget } from './accounts-bridge'
import type { SmsRecord } from './types'

const noop = () => undefined

function target(id: string, phone: string): AccountTarget {
  return {
    id,
    account: `${id}@example.com`,
    phone,
    smsOtpUrl: 'https://sms.example.com/saved',
    status: 'active',
    note: '',
  }
}

function record(tel = '+14155550100'): SmsRecord {
  return {
    tel,
    api: 'https://sms.example.com/pool',
    token: '',
    apiId: null,
    ordernum: 'order-1',
    appId: null,
    cateId: null,
    type: null,
    endTime: '',
    remark: '',
    status: null,
    renew: null,
    smsCount: null,
    voiceCount: null,
    addedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastRead: null,
  }
}

describe('number pool picker', () => {
  it('keeps the pool behind a labelled button', () => {
    const html = renderToStaticMarkup(createElement(NumberPoolPicker, { onPick: noop }))
    expect(html).toContain('aria-label="从号码池选择号码"')
    expect(html).toContain('号码池</button>')
    // The list itself only exists once the popover opens.
    expect(html).not.toContain('aria-label="已购号码"')
  })

  it('can be an icon-only trigger for a tight table cell', () => {
    const html = renderToStaticMarkup(
      createElement(NumberPoolPicker, { onPick: noop, size: 'icon-xs' }),
    )
    expect(html).toContain('aria-label="从号码池选择号码"')
    expect(html).not.toContain('号码池</button>')
  })

  it('starts on a loader instead of an empty list', () => {
    const html = renderToStaticMarkup(createElement(NumberPoolList, { onPick: noop }))
    expect(html).toContain('aria-label="搜索号码池"')
    expect(html).toContain('正在读取号码池')
    expect(html).not.toContain('没有匹配的号码')
  })
})

describe('number occupancy reminders', () => {
  it('marks the current account and names all other users without blocking selection', () => {
    const html = renderToStaticMarkup(
      createElement(NumberPoolOptions, {
        records: [record()],
        currentAccountId: 'current',
        accounts: {
          state: 'ready',
          items: [
            target('current', '+1 (415) 555-0100'),
            target('alice', '1 415 555 0100'),
            target('bob', '1-415-555-0100'),
          ],
        },
        onPick: noop,
      }),
    )
    expect(html).toContain('当前账号')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('其他账号已使用')
    expect(html).toContain('alice@example.com')
    expect(html).toContain('bob@example.com')
    expect(html).not.toContain('current@example.com')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('暂无账号使用')
  })

  it('treats all existing owners as other accounts when creating an account', () => {
    const html = renderToStaticMarkup(
      createElement(NumberPoolOptions, {
        records: [record()],
        accounts: { state: 'ready', items: [target('alice', '14155550100')] },
        onPick: noop,
      }),
    )
    expect(html).toContain('其他账号已使用')
    expect(html).toContain('alice@example.com')
    expect(html).toContain('aria-selected="false"')
    expect(html).not.toContain('当前账号')
  })

  it('does not count the current account as another owner', () => {
    const html = renderToStaticMarkup(
      createElement(NumberPoolOptions, {
        records: [record()],
        currentAccountId: 'current',
        accounts: { state: 'ready', items: [target('current', '14155550100')] },
        onPick: noop,
      }),
    )
    expect(html).toContain('当前账号')
    expect(html).not.toContain('其他账号已使用')
    expect(html).not.toContain('暂无账号使用')
  })

  it.each(['loading', 'unavailable'] as const)(
    'does not label numbers unused while account lookup is %s',
    (state) => {
      const html = renderToStaticMarkup(
        createElement(NumberPoolOptions, {
          records: [record()],
          accounts: { state },
          onPick: noop,
        }),
      )
      expect(html).toContain(state === 'loading' ? '正在查询账号占用' : '占用情况未知')
      expect(html).not.toContain('暂无账号使用')
      expect(html).not.toContain('disabled=""')
      expect(html).toContain('+14155550100')
    },
  )

  it('only marks a number unused after a successful account lookup', () => {
    const html = renderToStaticMarkup(
      createElement(NumberPoolOptions, {
        records: [record('+442079460000')],
        accounts: { state: 'ready', items: [target('local', '020 7946 0000')] },
        onPick: noop,
      }),
    )
    expect(html).toContain('暂无账号使用')
    expect(html).not.toContain('local@example.com')
  })

  it('still disables records with no SMS link, regardless of occupancy', () => {
    const html = renderToStaticMarkup(
      createElement(NumberPoolOptions, {
        records: [{ ...record(), api: '' }],
        accounts: { state: 'ready', items: [] },
        onPick: noop,
      }),
    )
    expect(html).toContain('没有接码链接')
    expect(html).toContain('disabled=""')
  })
})
