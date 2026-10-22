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
    methods: ['vinted.monitors.list'],
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
  it('explains that collection needs the desktop host', () => {
    const html = render({ hostAvailable: false })
    expect(html).toContain('Vinted 监控需要桌面应用')
    // The actions stay in place but disabled: there is no host to call.
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('vinted-table-scroll')
  })

  it('points to the plugin center when the plugin is missing', () => {
    expect(render({ plugin: null })).toContain('Vinted 监控插件尚未安装')
  })

  it('does not pretend a stopped plugin can collect', () => {
    const html = render({ plugin: plugin({ state: 'stopped', enabled: false }) })
    expect(html).toContain('Vinted 监控插件未启用')
    expect(html).toContain('monitor.collector')
    expect(html).not.toContain('vinted-table-scroll')
  })

  it('surfaces the real process error instead of a generic message', () => {
    const html = render({ plugin: plugin({ state: 'failed', lastError: '握手超时' }) })
    expect(html).toContain('插件进程启动失败')
    expect(html).toContain('握手超时')
  })

  it('shows the table skeleton, not an empty state, before the first load', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('Vinted 监控')
    expect(html).toContain('新增监控')
    expect(html).toContain('vinted-skeleton')
    expect(html).not.toContain('还没有监控')
  })
})
