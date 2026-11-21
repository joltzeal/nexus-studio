import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Pager } from './Pager'
import { ProductFilters } from './ProductFilters'

vi.mock('@proxyshard/shardx-ui-kit', () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    React.createElement('button', null, children),
  IconButton: ({ label, disabled }: { label: string; disabled?: boolean }) =>
    React.createElement('button', { 'aria-label': label, disabled }),
  Input: ({ label }: { label: string }) =>
    React.createElement('input', { 'aria-label': label }),
  Select: ({
    label,
    'aria-label': name,
    disabled,
  }: {
    label?: string
    'aria-label'?: string
    disabled?: boolean
  }) => React.createElement('select', { 'aria-label': label ?? name, disabled }),
}))

it('keeps typed search and enumerated controls in one full-width filter row', () => {
  const markup = renderToStaticMarkup(
    <ProductFilters query={{ page: 1, pageSize: 20, query: '' }} onChange={vi.fn()} />,
  )
  expect(markup).toContain('<input aria-label="搜索商品"')
  for (const label of ['准备状态', '发布状态', '商品来源']) {
    expect(markup).toContain(`<select aria-label="${label}"`)
  }
  expect(markup).toMatch(
    /<div[^>]*aria-label="商品筛选条件"[^>]*class="[^"]*w-full[^>]*>/,
  )
  expect(markup).toContain('flex-nowrap')
  expect(markup).toContain('overflow-x-auto')
  expect(markup).not.toContain('flex-wrap')
})

it('keeps the count, page size and navigation in one compact footer', () => {
  const markup = renderToStaticMarkup(
    <Pager page={2} pageSize={20} total={21} busy={false} onChange={vi.fn()} />,
  )
  expect(markup).toContain('flex-nowrap')
  expect(markup).toContain('共 21 条')
  expect(markup).toContain('第 2 / 2 页')
  expect(markup).toContain('aria-label="每页条数"')
  expect(markup).toContain('<button aria-label="上一页"></button>')
  expect(markup).toContain('<button aria-label="下一页" disabled=""></button>')
})

it('does not show stale totals or allow paging without a current result', () => {
  const markup = renderToStaticMarkup(
    <Pager page={2} pageSize={20} busy onChange={vi.fn()} />,
  )
  expect(markup).toContain('aria-label="分页"')
  expect(markup).not.toContain('共 ')
  expect(markup).toContain('<button aria-label="上一页" disabled=""></button>')
  expect(markup).toContain('<button aria-label="下一页" disabled=""></button>')
  expect(markup).toMatch(/<select[^>]*disabled=""/)
})
