import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { browserConnection, browserWindow } from '@/lib/platform/browser-test-support'
import { TransferToolbar } from './transfer-toolbar'

function markup(
  connection: ReturnType<typeof browserConnection> | null,
  windows: ReturnType<typeof browserWindow>[] = [],
) {
  return renderToStaticMarkup(
    createElement(TransferToolbar, {
      native: true,
      connection,
      windows,
      operating: new Set<string>(),
      onImported: async () => undefined,
      onClear: () => undefined,
    }),
  )
}

function disabled(html: string, label: string) {
  const buttons = html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []
  return buttons
    .find((button) => button.endsWith(`${label}</button>`))
    ?.includes('disabled=""')
}

describe('transfer connection capabilities', () => {
  it('blocks every full transfer action on an external Tab before any selection', () => {
    const html = markup(
      browserConnection({
        providerId: 'adspower',
        capabilities: { ...browserConnection().capabilities, transfer: false },
      }),
    )
    for (const label of ['导出', '导入', '设备同步'])
      expect(disabled(html, label)).toBe(true)
    expect(html).toContain('不支持完整迁移')
    expect(html).toContain('官方浏览器')
  })

  it('allows builtin import and receiving sync without a selection', () => {
    const html = markup(browserConnection())
    expect(disabled(html, '导出')).toBe(true)
    expect(disabled(html, '导入')).toBe(false)
    expect(disabled(html, '设备同步')).toBe(false)
  })

  it('names and blocks an entire unsupported selection', () => {
    const html = markup(browserConnection(), [
      browserWindow(),
      browserWindow({ id: 'external', providerId: 'bitbrowser', name: 'Bit shop' }),
    ])
    for (const label of ['导出', '导入', '设备同步'])
      expect(disabled(html, label)).toBe(true)
    expect(html).toContain('Bit shop')
  })

  it('respects a disabled transfer capability on a builtin connection', () => {
    const html = markup(
      browserConnection({
        capabilities: { ...browserConnection().capabilities, transfer: false },
      }),
    )
    for (const label of ['导出', '导入', '设备同步'])
      expect(disabled(html, label)).toBe(true)
  })
})
