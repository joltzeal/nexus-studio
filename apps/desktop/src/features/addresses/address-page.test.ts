import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AddressPage } from './address-page'

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  const base: PluginView = {
    id: 'studio.address-generator',
    name: '地址生成器',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: ['address.generator'],
    granted: ['address.generator'],
    permissions: {
      networkDomains: ['overpass-api.de', 'maps.mail.ru'],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: ['google-maps-key'],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: ['address.generate'],
    status: { storage: 'file' },
    lastError: null,
    storageDurable: true,
    secretSlots: ['google-maps-key'],
    sourceDirectory: null,
  }
  return { ...base, ...overrides }
}

function render(overrides: Partial<Parameters<typeof AddressPage>[0]>): string {
  return renderToStaticMarkup(
    createElement(AddressPage, { plugin: null, hostAvailable: true, ...overrides }),
  )
}

describe('address generator page', () => {
  it('says the page needs the desktop host', () => {
    const html = render({ hostAvailable: false })
    expect(html).toContain('地址生成器需要桌面应用')
    expect(html).not.toContain('生成地址')
  })

  it('points to the plugin center when the plugin is missing', () => {
    const html = render({ plugin: null })
    expect(html).toContain('地址生成器插件尚未安装')
  })

  it('waits for a starting process instead of offering a restart', () => {
    const html = render({ plugin: plugin({ state: 'starting' }) })
    expect(html).toContain('地址生成器插件正在启动')
    expect(html).not.toContain('重新启动插件进程')
    expect(html).not.toContain('生成数量')
  })

  it('shows the controls and an honest empty state once the plugin runs', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('国家')
    expect(html).toContain('城市')
    expect(html).toContain('生成数量')
    expect(html).toContain('公开地址')
    expect(html).toContain('地图选点')
    expect(html).toContain('生成地址')
    expect(html).toContain('还没有结果')
    expect(html).toContain('生成结果')
  })

  it('credits the address source instead of implying it invented addresses', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('OpenStreetMap')
    expect(html).toContain('ODbL')
  })

  it('never renders a stored map key', () => {
    const html = render({ plugin: plugin() })
    expect(html).not.toContain('AIza')
    expect(html).not.toContain('apiKey')
  })

  it('does not open the key sheet until asked', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('地图 Key')
    expect(html).not.toContain('secrets.json')
  })
})
