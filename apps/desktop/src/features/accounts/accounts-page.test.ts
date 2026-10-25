import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AccountsPage } from './accounts-page'

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  const base: PluginView = {
    id: 'studio.vinted-accounts',
    name: 'Vinted 账号池',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: ['account.pool'],
    granted: ['account.pool'],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: ['vinted.accounts.list'],
    status: { storage: 'file' },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
  }
  return { ...base, ...overrides }
}

function render(overrides: Partial<Parameters<typeof AccountsPage>[0]>): string {
  return renderToStaticMarkup(
    createElement(AccountsPage, {
      plugin: null,
      hostAvailable: true,
      ...overrides,
    }),
  )
}

describe('vinted accounts page', () => {
  it('says the page needs the desktop host', () => {
    const html = render({ hostAvailable: false })
    expect(html).toContain('Vinted 账号需要桌面应用')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('aria-label="账号列表"')
  })

  it('points to the plugin center when the plugin is missing', () => {
    expect(render({ plugin: null })).toContain('Vinted 账号插件尚未安装')
  })

  it('waits for a starting process instead of offering a restart', () => {
    const html = render({ plugin: plugin({ state: 'starting' }) })
    expect(html).toContain('Vinted 账号插件正在启动')
    expect(html).not.toContain('重新启动插件进程')
    expect(html).not.toContain('aria-label="账号列表"')
  })

  it('shows the empty pool with the import and add actions', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('aria-label="账号列表"')
    expect(html).toContain('还没有账号')
    expect(html).toContain('新增账号')
    expect(html).toContain('导入')
    expect(html).toContain('全选当前筛选的账号')
    const buttons =
      html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []
    expect(buttons.find((button) => button.endsWith('批量创建窗口</button>'))).toMatch(
      /\bdisabled=""/,
    )
    // No explanatory paragraph: the page is a table, not a tour.
    expect(html).not.toContain('page-description')
    expect(html).not.toContain('演示占位')
  })
})
