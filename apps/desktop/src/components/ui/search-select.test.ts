import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SearchSelect, type SearchSelectOption } from './search-select'

const options: SearchSelectOption[] = [
  { value: '1', label: '美国 · ¥1.20' },
  { value: '2', label: '英国 · ¥1.50' },
]

function render(value: string, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(SearchSelect, {
      ariaLabel: '项目',
      value,
      options,
      onValueChange: () => undefined,
      ...extra,
    }),
  )
}

describe('search select', () => {
  it('shows the chosen label on the closed trigger', () => {
    const html = render('2')
    expect(html).toContain('英国 · ¥1.50')
    expect(html).not.toContain('美国 · ¥1.20')
    // The filter box only exists once the menu opens.
    expect(html).not.toContain('输入关键字筛选')
  })

  it('falls back to the placeholder when nothing is chosen', () => {
    expect(render('')).toContain('请选择')
  })

  it('announces itself as a closed combobox', () => {
    const html = render('1')
    expect(html).toContain('aria-label="项目"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-expanded="false"')
  })

  it('renders disabled when the caller has nothing to offer', () => {
    expect(render('', { options: [], disabled: true })).toContain('disabled=""')
  })
})
