import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PluginView } from '@/lib/platform/native-plugins'
import { EmailPage } from './email-page'
import { emailProcessIdentity } from './identity'

const plugin: PluginView = {
  id: 'studio.email',
  name: '邮箱',
  version: '1.0.0',
  apiVersion: 1,
  minCoreVersion: '0.1.0',
  capabilities: ['email.provider'],
  granted: ['email.provider'],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
  source: 'installed',
  state: 'running',
  enabled: true,
  methods: ['email.accounts.list'],
  status: { pid: 123 },
  lastError: null,
  storageDurable: true,
  secretSlots: [],
  sourceDirectory: null,
}

describe('email page host/process boundary', () => {
  it.each([
    [false, plugin, '邮箱需要桌面应用'],
    [true, null, '邮箱插件尚未安装'],
    [true, { ...plugin, state: 'retrying' as const }, '邮箱插件正在启动'],
  ])(
    'gates RPC content when the plugin cannot serve',
    (hostAvailable, value, expected) => {
      const html = renderToStaticMarkup(
        createElement(EmailPage, { hostAvailable, plugin: value }),
      )
      expect(html).toContain(expected)
      expect(html).not.toContain('aria-label="邮箱列表"')
    },
  )

  it('exposes a compact server table and credential-free management actions', () => {
    const html = renderToStaticMarkup(
      createElement(EmailPage, { hostAvailable: true, plugin }),
    )
    expect(html).toContain('aria-label="邮箱列表"')
    expect(html).toContain('新增邮箱')
    expect(html).toContain('批量导入')
    expect(html).toContain('刷新设置')
    expect(html).toContain('筛选邮箱状态')
    expect(html).not.toContain('localStorage')
    expect(html).not.toContain('Refresh token')
  })

  it('changes the workspace identity when the host, process, version or source changes', () => {
    const identity = emailProcessIdentity(plugin, true)
    expect(identity).not.toBeNull()
    expect(emailProcessIdentity({ ...plugin }, true)).toBe(identity)
    expect(emailProcessIdentity({ ...plugin, status: { pid: 456 } }, true)).not.toBe(
      identity,
    )
    expect(emailProcessIdentity({ ...plugin, version: '2.0.0' }, true)).not.toBe(identity)
    expect(emailProcessIdentity({ ...plugin, source: 'updated' }, true)).not.toBe(
      identity,
    )
    expect(emailProcessIdentity({ ...plugin, enabled: false }, true)).toBeNull()
    expect(emailProcessIdentity(plugin, false)).toBeNull()
  })
})
