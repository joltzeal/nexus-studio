import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImportModeField, TransferResult } from './transfer-feedback'

describe('snapshot import guidance', () => {
  it('distinguishes sync identity preservation from a new file copy', () => {
    const props = {
      mode: 'copy' as const,
      disabled: false,
      onChange: () => undefined,
    }
    const file = renderToStaticMarkup(createElement(ImportModeField, props))
    const sync = renderToStaticMarkup(
      createElement(ImportModeField, { ...props, sync: true }),
    )
    expect(file).toContain('生成新标识')
    expect(sync).toContain('接收为独立窗口，保留标识供后续同步；已存在时不会覆盖')
    expect(sync).toContain('覆盖需显式启用，且目标窗口必须关闭')
    expect(sync).not.toContain('生成新标识')
    expect(sync).toContain('aria-checked="false"')
  })

  it('renders a regular import receipt with a nullable path and its actual warnings', () => {
    const html = renderToStaticMarkup(
      createElement(TransferResult, {
        report: { windowCount: 1, ids: ['source-id'], warnings: ['需要重新登录'] },
        action: '导入',
        path: null,
      }),
    )
    expect(html).toContain('已导入 1 个窗口')
    expect(html).toContain('需要重新登录')
    expect(html).not.toContain('null')
  })
})
