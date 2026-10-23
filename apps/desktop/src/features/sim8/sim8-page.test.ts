import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PluginView } from '@/lib/platform/native-plugins'
import { Sim8Page } from './sim8-page'

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  const base: PluginView = {
    id: 'studio.sim8',
    name: 'SIM8 接码',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: ['verification.provider'],
    granted: ['verification.provider'],
    permissions: {
      networkDomains: ['api.cc'],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: ['api-token'],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: ['sim8.config.get'],
    status: { storage: 'file' },
    lastError: null,
    storageDurable: true,
    secretSlots: ['api-token'],
    sourceDirectory: null,
  }
  return { ...base, ...overrides }
}

function render(overrides: Partial<Parameters<typeof Sim8Page>[0]>): string {
  return renderToStaticMarkup(
    createElement(Sim8Page, {
      plugin: null,
      hostAvailable: true,
      ...overrides,
    }),
  )
}

describe('sim8 page', () => {
  it('says the page needs the desktop host', () => {
    const html = render({ hostAvailable: false })
    expect(html).toContain('SIM8 接码需要桌面应用')
    expect(html).not.toContain('aria-label="号码列表"')
  })

  it('points to the plugin center when the plugin is missing', () => {
    const html = render({ plugin: null })
    expect(html).toContain('SIM8 接码插件尚未安装')
    expect(html).not.toContain('号码池')
  })

  it('waits for the process instead of offering a restart', () => {
    const html = render({ plugin: plugin({ state: 'starting' }) })
    expect(html).toContain('SIM8 接码插件正在启动')
    expect(html).not.toContain('重新启动插件进程')
  })

  it('reads the configuration before showing any numbers', () => {
    // The first paint has no config yet: the page asks for it over RPC, so the
    // server-rendered markup is the loading block, not an empty table.
    const html = render({ plugin: plugin() })
    expect(html).toContain('正在读取配置')
    expect(html).not.toContain('aria-label="号码列表"')
    // No explanatory paragraph: the page is a workbench, not a tour.
    expect(html).not.toContain('page-description')
  })
})
