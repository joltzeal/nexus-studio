import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PluginView } from '@/lib/platform/native-plugins'
import { SupplyPage } from './supply-page'

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  const base: PluginView = {
    id: 'studio.shared-supply',
    name: '共享货源',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: ['supply.catalog'],
    granted: ['supply.catalog'],
    permissions: {
      networkDomains: ['gz.aliyizhan.com', 'aliyizhan.com', 'product.aliyizhan.com'],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: ['supply.catalog'],
    status: { storage: 'file' },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
  }
  return { ...base, ...overrides }
}

function render(overrides: Partial<Parameters<typeof SupplyPage>[0]>): string {
  return renderToStaticMarkup(
    createElement(SupplyPage, { plugin: null, hostAvailable: true, ...overrides }),
  )
}

describe('shared supply page', () => {
  it('explains that browsing needs the desktop host', () => {
    const html = render({ hostAvailable: false })
    expect(html).toContain('只能在 Nexus 桌面应用中运行')
    expect(html).not.toContain('分类商户')
  })

  it('points to the plugin center when the plugin is missing', () => {
    const html = render({ plugin: null })
    expect(html).toContain('共享货源插件尚未安装')
  })

  it('does not pretend a stopped plugin can browse', () => {
    const html = render({ plugin: plugin({ state: 'stopped', enabled: false }) })
    expect(html).toContain('共享货源插件未启用')
    expect(html).toContain('supply.catalog')
    expect(html).not.toContain('以图搜图')
  })

  it('surfaces the real process error instead of a generic message', () => {
    const html = render({ plugin: plugin({ state: 'failed', lastError: '握手超时' }) })
    expect(html).toContain('插件进程启动失败')
    expect(html).toContain('握手超时')
  })

  it('shows the four sections and an honest empty state once running', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('分类商户')
    expect(html).toContain('搜索商品')
    expect(html).toContain('以图搜图')
    expect(html).toContain('我的收藏')
    // Nothing has been requested yet, so the page says it is loading rather
    // than claiming the category is empty.
    expect(html).toContain('正在加载商户…')
    expect(html).toContain('先选择一个商户')
  })

  it('keeps the card header to the title and the action cluster', () => {
    const html = render({ plugin: plugin() })
    // The description paragraph was removed on request, so the header carries
    // no explanatory copy any more.
    expect(html).not.toContain('按分类浏览商户商品')
    expect(html).not.toContain('不代表可直接下单')
    expect(html).toContain('共享货源')
    expect(html).toContain('section-actions')
  })
})
