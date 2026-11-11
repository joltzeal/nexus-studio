import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import type { Account, BindingView } from '@/features/accounts/types'
import { components } from '@/features/settings/kernel-test-support'
import { browserWindow } from '@/lib/platform/browser-test-support'
import { expiryAssociations } from './expiry-associations'
import { ExpiryReminderRows, Sim8ExpiryNotice } from './expiry-notice'
import { useNumberExpiry } from './use-number-expiry'

vi.mock('./use-number-expiry', () => ({ useNumberExpiry: vi.fn() }))

const accounts = [
  { id: 'a', account: 'a@example.test', phone: '+1 (415) 555-0100' },
  { id: 'b', account: 'b@example.test', phone: '14155550100' },
] as Account[]
const bindings = [
  { accountId: 'a', windowId: 'w1' },
  { accountId: 'a', windowId: 'w2' },
] as BindingView[]
const windows = [
  browserWindow({ id: 'w1', name: '店铺一' }),
  browserWindow({
    id: 'w2',
    name: '店铺二',
    providerId: 'adspower',
    connectionId: 'ads',
  }),
]
const item = { tel: '+14155550100', expiresAt: '2026-11-03T10:00:00Z', checkedAt: null }

describe('window expiry notice', () => {
  it.each(['hidden', 'upgrade', 'unavailable'] as const)(
    'keeps plugin availability messages off the window homepage (%s)',
    (availability) => {
      vi.mocked(useNumberExpiry).mockReturnValue({
        availability,
      } as ReturnType<typeof useNumberExpiry>)
      expect(
        renderToStaticMarkup(
          createElement(Sim8ExpiryNotice, {
            refreshKey: 0,
            now: Date.now(),
            accounts,
            bindings,
            windows,
          }),
        ),
      ).toBe('')
    },
  )

  it('shows one number with all its accounts/windows and supports dismissing that number', () => {
    const onDismiss = vi.fn()
    const props = {
      items: [item],
      now: Date.parse('2026-10-30T10:00:00Z'),
      dismissing: [],
      onDismiss,
      accounts,
      bindings,
      windows,
    }
    const html = renderToStaticMarkup(createElement(ExpiryReminderRows, props))
    expect(html.match(/<li\b/g)).toHaveLength(1)
    expect(html).toContain('4 天内到期')
    expect(html).toContain('a@example.test')
    expect(html).toContain('b@example.test')
    expect(html).toContain('店铺一、店铺二')
    expect(html).toContain('未关联窗口')
    components(ExpiryReminderRows(props), Button)[0]?.props.onClick?.({} as never)
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(item)
  })

  it('updates associations immediately after unlinking and does not infer country codes', () => {
    expect(expiryAssociations(item.tel, { accounts: [], bindings, windows })).toBe(
      '未关联账号',
    )
    expect(expiryAssociations(item.tel, { accounts: null, bindings, windows })).toBe(
      '账号关联信息暂不可用',
    )
    expect(expiryAssociations('4155550100', { accounts, bindings, windows })).toBe(
      '未关联账号',
    )
    expect(
      expiryAssociations(item.tel, { accounts, bindings: [], windows }),
    ).not.toContain('店铺一')
  })

  it('disables repeated dismissals while saving', () => {
    const html = renderToStaticMarkup(
      createElement(ExpiryReminderRows, {
        items: [item],
        now: Date.parse('2026-11-03T09:00:00Z'),
        dismissing: [item.tel],
        onDismiss: vi.fn(),
        accounts,
        bindings,
        windows,
      }),
    )
    expect(html).toContain('24 小时内到期')
    expect(html).toContain('disabled=""')
  })
})
