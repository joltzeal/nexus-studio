import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PluginView } from '@/lib/platform/native-plugins'
import { ProxyPoolPage } from './proxy-pool-page'

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  const base: PluginView = {
    id: 'studio.proxy-pool',
    name: '代理池',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: ['proxy.provider'],
    granted: ['proxy.provider'],
    permissions: {
      networkDomains: ['api64.ipify.org', 'proxycheck.io'],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: ['proxy-password'],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: ['proxy.list'],
    status: { storage: { durable: true } },
    lastError: null,
    storageDurable: true,
    secretSlots: ['proxy-password'],
    sourceDirectory: null,
  }
  return { ...base, ...overrides }
}

function render(overrides: Partial<Parameters<typeof ProxyPoolPage>[0]>): string {
  return renderToStaticMarkup(
    createElement(ProxyPoolPage, { plugin: null, hostAvailable: true, ...overrides }),
  )
}

describe('proxy pool page', () => {
  it('explains that the pool needs the desktop host', () => {
    const html = render({ hostAvailable: false })
    expect(html).toContain('只能在 Nexus 桌面应用中运行')
    expect(html).not.toContain('新增代理')
  })

  it('points to the plugin center when the plugin is missing', () => {
    const html = render({ plugin: null })
    expect(html).toContain('代理插件尚未安装')
  })

  it('does not pretend a disabled plugin can serve data', () => {
    const html = render({ plugin: plugin({ state: 'stopped', enabled: false }) })
    expect(html).toContain('代理插件未启用')
    expect(html).toContain('启用并授予 proxy.provider')
    expect(html).not.toContain('新增代理')
  })

  it('says where passwords live and never mentions a system keychain', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('密码保存在插件私有目录')
    expect(html).not.toContain('钥匙串')
    expect(html).not.toContain('凭据库')
  })

  it('never renders a credential value', () => {
    const html = render({ plugin: plugin() })
    expect(html).not.toContain('password=')
    expect(html).not.toContain('secret')
  })

  it('shows the inventory toolbar and an empty table before data arrives', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('新增代理')
    expect(html).toContain('批量添加')
    expect(html).toContain('检测选中')
    expect(html).toContain('搜索名称或主机')
    expect(html).toContain('支持协议')
    expect(html).toContain('IP 质量')
    expect(html).toContain('还没有代理')
    expect(html).toContain('共 0 条')
  })

  it('does not claim a default proxy before the config has been read', () => {
    const html = render({ plugin: plugin() })
    expect(html).not.toContain('未设置默认代理')
    expect(html).toContain('每页 50')
    expect(html).toContain('第 1 / 1 页')
  })
})
