import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { AccountPager } from './AccountPager'

vi.mock('@proxyshard/shardx-ui-kit', () => ({
  IconButton: ({ label, disabled }: { label: string; disabled?: boolean }) =>
    React.createElement('button', { 'aria-label': label, disabled }),
  Select: ({
    'aria-label': label,
    disabled,
  }: {
    'aria-label': string
    disabled?: boolean
  }) => React.createElement('select', { 'aria-label': label, disabled }),
  ICON_STROKE: 1,
}))

it('keeps account pagination in one row with icon navigation', () => {
  const markup = renderToStaticMarkup(
    <AccountPager
      page={2}
      pageSize={20}
      total={21}
      busy={false}
      onPageChange={vi.fn()}
      onPageSizeChange={vi.fn()}
    />,
  )
  expect(markup).toContain('flex-nowrap')
  expect(markup).toContain('共 21 个 · 第 2 / 2 页')
  expect(markup).toContain('aria-label="每页账号数"')
  expect(markup).toContain('aria-label="上一页"')
  expect(markup).toContain('aria-label="下一页"')
})

it('disables paging while loading and clamps an empty result to one page', () => {
  const markup = renderToStaticMarkup(
    <AccountPager
      page={1}
      pageSize={50}
      total={0}
      busy
      onPageChange={vi.fn()}
      onPageSizeChange={vi.fn()}
    />,
  )
  expect(markup).toContain('共 0 个 · 第 1 / 1 页')
  expect(markup).toMatch(/<select[^>]*disabled=""/)
  expect(markup).toMatch(/<button[^>]*aria-label="上一页"[^>]*disabled=""/)
  expect(markup).toMatch(/<button[^>]*aria-label="下一页"[^>]*disabled=""/)
})
