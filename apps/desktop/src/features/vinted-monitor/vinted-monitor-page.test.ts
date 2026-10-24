import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PluginView } from '@/lib/platform/native-plugins'
import { VintedMonitorPage } from './vinted-monitor-page'

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  const base: PluginView = {
    id: 'studio.vinted-monitor',
    name: 'Vinted 商品监控',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: ['monitor.collector'],
    granted: ['monitor.collector'],
    permissions: {
      networkDomains: ['vinted.fr', 'api.vinted.fr'],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: ['vinted.monitors.list', 'vinted.items.get', 'vinted.proxies.list'],
    status: { storage: 'file' },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
  }
  return { ...base, ...overrides }
}

function render(overrides: Partial<Parameters<typeof VintedMonitorPage>[0]>): string {
  return renderToStaticMarkup(
    createElement(VintedMonitorPage, {
      plugin: null,
      hostAvailable: true,
      ...overrides,
    }),
  )
}

describe('vinted monitor page', () => {
  it('says the page needs the desktop host', () => {
    const html = render({ hostAvailable: false })
    expect(html).toContain('Vinted 监控需要桌面应用')
    // The actions stay in place but disabled: there is no host to call.
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('vinted-table-scroll')
  })

  it('points to the plugin center when the plugin is missing', () => {
    expect(render({ plugin: null })).toContain('Vinted 监控插件尚未安装')
  })

  it('waits for a starting process instead of offering a restart', () => {
    const html = render({ plugin: plugin({ state: 'starting' }) })
    expect(html).toContain('Vinted 监控插件正在启动')
    expect(html).not.toContain('重新启动插件进程')
    expect(html).not.toContain('vinted-table-scroll')
  })

  it('reports a retrying process without the raw error', () => {
    const html = render({ plugin: plugin({ state: 'retrying', lastError: '握手超时' }) })
    expect(html).toContain('Vinted 监控插件正在启动')
    expect(html).toContain('后台会自动重试')
    expect(html).not.toContain('握手超时')
  })

  it('shows the table skeleton, not an empty state, before the first load', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('Vinted 监控')
    expect(html).toContain('新增监控')
    expect(html).toContain('vinted-skeleton')
    expect(html).not.toContain('还没有监控')
  })

  it('requires a plugin update before exposing incompatible page actions', () => {
    const html = render({ plugin: plugin({ methods: ['vinted.monitors.list'] }) })
    expect(html).toContain('请更新 Vinted 监控插件')
    expect(html).not.toContain('新增监控')
    expect(html).not.toContain('vinted-skeleton')
  })
})
