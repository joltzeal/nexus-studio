import { describe, expect, it } from 'vitest'
import { memberIdFromUrl, monitorProxyError } from './monitor-form-sheet'
import type { MonitorProxy, ProxyList } from './types'

const enabled: MonitorProxy = {
  id: 'enabled',
  name: 'Available',
  scheme: 'socks5h',
  host: '127.0.0.1',
  port: 7890,
  username: '',
  hasPassword: false,
  enabled: true,
}
const disabled: MonitorProxy = {
  ...enabled,
  id: 'disabled',
  name: 'Disabled',
  enabled: false,
}
const proxies: ProxyList = {
  items: [enabled, disabled],
  defaultProxyId: enabled.id,
  storageDurable: true,
}

describe('monitor proxy selection', () => {
  it('uses the plugin default only when no proxy is explicitly selected', () => {
    expect(monitorProxyError({ proxyId: null, enabled: true }, proxies)).toBeNull()
    expect(
      monitorProxyError(
        { proxyId: enabled.id, enabled: true },
        {
          ...proxies,
          defaultProxyId: disabled.id,
        },
      ),
    ).toBeNull()
  })

  it('allows application network inheritance when no default is configured', () => {
    expect(
      monitorProxyError(
        { proxyId: null, enabled: true },
        {
          items: [],
          defaultProxyId: null,
          storageDurable: true,
        },
      ),
    ).toBeNull()
  })

  it('does not replace a deleted explicit selection with a working default', () => {
    expect(monitorProxyError({ proxyId: 'deleted', enabled: false }, proxies)).toContain(
      '原代理已删除',
    )
    expect(monitorProxyError({ proxyId: 'deleted', enabled: true }, proxies)).toContain(
      '原代理已删除',
    )
  })

  it('keeps a disabled selected proxy only while the monitor is disabled', () => {
    expect(
      monitorProxyError({ proxyId: disabled.id, enabled: false }, proxies),
    ).toBeNull()
    expect(monitorProxyError({ proxyId: disabled.id, enabled: true }, proxies)).toContain(
      '所选代理已停用',
    )
  })

  it('blocks enabled monitors inheriting a disabled default', () => {
    const inherited = { ...proxies, defaultProxyId: disabled.id }
    expect(monitorProxyError({ proxyId: null, enabled: true }, inherited)).toContain(
      '插件默认代理已停用',
    )
    expect(monitorProxyError({ proxyId: null, enabled: false }, inherited)).toBeNull()
  })

  it('reports a deleted default instead of treating it as application networking', () => {
    expect(
      monitorProxyError(
        { proxyId: null, enabled: true },
        {
          ...proxies,
          defaultProxyId: 'deleted',
        },
      ),
    ).toContain('插件默认代理已删除')
  })
})

describe('member URL hints', () => {
  it('recognizes wardrobe URLs with a nickname and query without changing the URL', () => {
    expect(
      memberIdFromUrl(' https://www.vinted.fr/member/123456-a-user?tab=closet '),
    ).toBe('123456')
    expect(memberIdFromUrl('https://vinted.co.uk/member/123456/')).toBe('123456')
  })

  it.each([
    'https://example.com/member/123456',
    'https://vinted.fr.example.com/member/123456',
    'https://vinted.fr/catalog?search_text=nike',
    'https://vinted.fr/member/not-a-number',
    'https://user:pass@vinted.fr/member/123456',
    'ftp://vinted.fr/member/123456',
    'https://vinted.fr/member/123456/items',
    'not a URL',
  ])('does not present a member hint for %s', (url) => {
    expect(memberIdFromUrl(url)).toBeNull()
  })
})
