import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NumberPoolList, NumberPoolPicker } from './number-picker'

const noop = () => undefined

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
