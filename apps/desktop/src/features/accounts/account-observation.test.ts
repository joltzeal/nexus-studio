import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PopoverContent } from '@/components/ui/popover'
import { components } from '@/features/settings/kernel-test-support'
import { accountBalanceData } from './account-observation-data'
import {
  AccountObservationBalance,
  AccountObservationSummary,
} from './account-observation'
import {
  accountObservation,
  balanceTime,
  observationTime,
} from './account-observation-test-support'

describe('account observation render data', () => {
  it('pairs independent amounts and currencies with their retained evidence', () => {
    expect(accountBalanceData(accountObservation())).toEqual({
      amounts: [
        {
          key: 'available',
          label: '可用',
          amount: '123456789012.3400',
          currency: 'EUR',
          sourceLabel: '官方接口',
          observedAt: balanceTime,
          retained: true,
        },
        {
          key: 'pending',
          label: '待结算',
          amount: '0.00',
          currency: 'GBP',
          sourceLabel: '页面',
          observedAt: observationTime,
          retained: false,
        },
      ],
    })
  })
  it('shows null amounts as unknown without inventing currency or evidence', () => {
    expect(
      accountBalanceData({
        ...accountObservation(),
        wallet: { available: null, pending: null },
      })?.amounts,
    ).toEqual([
      {
        key: 'available',
        label: '可用',
        amount: '—',
        currency: null,
        sourceLabel: null,
        observedAt: null,
        retained: false,
      },
      {
        key: 'pending',
        label: '待结算',
        amount: '—',
        currency: null,
        sourceLabel: null,
        observedAt: null,
        retained: false,
      },
    ])
  })
  it('does not mark a different failed check as a failed wallet read', () => {
    const observation = accountObservation()
    observation.checks = {}
    expect(
      accountBalanceData(observation)?.amounts.map((entry) => entry.retained),
    ).toEqual([false, false])
  })
  it('keeps negative decimals and legacy model evidence explicit', () => {
    const observation = accountObservation()
    observation.wallet!.available = {
      amount: '-0.0001',
      currency: 'EUR',
      source: 'model',
      observedAt: balanceTime,
    }
    expect(accountBalanceData(observation)?.amounts[0]).toMatchObject({
      amount: '-0.0001',
      sourceLabel: '模型',
      observedAt: balanceTime,
    })
  })
  it('does not invent wallet state before inspection', () => {
    expect(accountBalanceData(undefined)).toBeNull()
    expect(accountBalanceData({ sessions: {}, checks: {} })).toBeNull()
  })
})

describe('read-only account observation components', () => {
  it('renders summary text safely and displays zero ratings', () => {
    const html = renderToStaticMarkup(
      createElement(AccountObservationSummary, {
        observation: {
          ...accountObservation(),
          tags: ['<tag>', '<tag>'],
          summary: '<script>alert("test")</script>',
          rating: 0,
        },
      }),
    )

    expect(html).toContain('&lt;tag&gt;')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('评分 0/5')
    expect(html).not.toMatch(/<(input|textarea|button)\b/)
  })

  it('omits empty metadata rather than showing a fake rating or summary', () => {
    expect(
      renderToStaticMarkup(
        createElement(AccountObservationSummary, { observation: undefined }),
      ),
    ).toBe('')
    expect(
      renderToStaticMarkup(
        createElement(AccountObservationSummary, {
          observation: {
            sessions: {},
            checks: {},
            tags: [],
            summary: '',
          },
        }),
      ),
    ).toBe('')
  })

  it('shows each amount with its original source and machine-readable observation time in the popover', () => {
    const tree = AccountObservationBalance({
      accountName: 'seller@example.test',
      observation: accountObservation(),
    })
    const content = components(tree, PopoverContent)[0]!
    const html = renderToStaticMarkup(
      createElement(Fragment, null, content.props.children),
    )
    const sections = html.match(/<dl\b[^>]*>[\s\S]*?<\/dl>/g) ?? []

    expect(sections).toHaveLength(1)
    expect(html).toContain('123456789012.3400')
    expect(html).toContain('0.00')
    expect(html).toContain('官方接口')
    expect(html).toContain('页面')
    expect(html).toContain(`dateTime="${balanceTime}"`)
    expect(html).toContain(`dateTime="${observationTime}"`)
    expect(html).toContain('最近读取未知，保留此前金额')
  })

  it('shows a plain dash for accounts without balance observations', () => {
    const html = renderToStaticMarkup(
      createElement(AccountObservationBalance, {
        accountName: 'seller@example.test',
        observation: undefined,
      }),
    )

    expect(html).toMatch(/^<span\b[^>]*>—<\/span>$/)
    expect(html).not.toContain('button')
  })
})
