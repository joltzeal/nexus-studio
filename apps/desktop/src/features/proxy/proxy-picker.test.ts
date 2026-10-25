import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProxyIdentityDetails, ProxyUsernameCell } from './proxy-detail'
import { ProxyPicker, ProxyPickerOption } from './proxy-picker'
import { indexProxyUsage, type ProxyUsageState } from './proxy-usage'
import { matchesProxyQuery, PROXY_PLUGIN_ID, type ProxyRow } from './types'

const row: ProxyRow = {
  id: '7',
  name: 'Shared gateway',
  groupId: null,
  schemes: ['http', 'socks5'],
  host: 'proxy.example.test',
  port: 8080,
  username: 'sample-country-us-session-unique-endpoint-001',
  enabled: true,
  udp: true,
  hasPassword: true,
  checkStatus: 'unknown',
  checkedScheme: null,
  checkedAt: null,
  exitIp: null,
  exitIpCheckedAt: null,
  previousExitIp: null,
  previousExitIpCheckedAt: null,
  exitIpChanged: false,
  geo: null,
  reputation: null,
  latencyMs: null,
  checkError: null,
}

function renderOption(usage: ProxyUsageState, proxy = row): string {
  return renderToStaticMarkup(
    createElement(ProxyPickerOption, {
      row: proxy,
      usage,
      selected: false,
      disabled: false,
      onSelect: () => undefined,
    }),
  )
}

describe('proxy picker', () => {
  it('keeps the initial default state loading instead of claiming it is missing or unused', () => {
    const html = renderToStaticMarkup(
      createElement(ProxyPicker, {
        endpointId: null,
        currentWindowId: null,
        disabled: false,
        onChange: () => undefined,
      }),
    )
    expect(html).toContain('正在读取默认项')
    expect(html).not.toContain('未被窗口使用')
    expect(html).not.toContain('尚未设置')
    expect(html).not.toContain('代理池还没有代理')
  })

  it('shows full username data and usage names without disabling a shared endpoint', () => {
    const html = renderOption({
      status: 'loaded',
      byEndpoint: indexProxyUsage(
        [
          {
            id: 'other',
            name: 'Other window',
            proxyPlugin: PROXY_PLUGIN_ID,
            proxyEndpoint: null,
          },
        ],
        row.id,
      ),
    })
    expect(html).toContain(row.username)
    expect(html).toContain(`title="${row.username}"`)
    expect(html).toContain('已被 1 个其他窗口使用')
    expect(html).toContain('Other window（跟随默认）')
    expect(html).not.toContain('disabled=""')
  })

  it.each<ProxyUsageState>([
    { status: 'loading' },
    { status: 'error', message: 'Could not read windows' },
  ])('keeps unconfirmed usage distinct from unused: $status', (usage) => {
    const html = renderOption(usage)
    expect(html).not.toContain('未被窗口使用')
    expect(html).not.toContain('disabled=""')
    expect(html).toContain(
      usage.status === 'loading' ? '正在读取窗口占用' : '窗口占用未知',
    )
  })

  it('retains the existing disabled state for a disabled proxy', () => {
    expect(renderOption({ status: 'loading' }, { ...row, enabled: false })).toContain(
      'disabled=""',
    )
  })

  it('searches dynamic usernames while retaining name, host and port matching', () => {
    for (const query of [
      'Shared',
      'EXAMPLE.TEST',
      '8080',
      ' SESSION-UNIQUE-ENDPOINT-001 ',
    ]) {
      expect(matchesProxyQuery(row, query)).toBe(true)
    }
    const another = { ...row, id: '8', username: 'sample-session-other-endpoint' }
    expect(matchesProxyQuery(another, 'session-unique-endpoint-001')).toBe(false)
    expect(matchesProxyQuery(row, '')).toBe(true)
    expect(matchesProxyQuery(row, 'missing')).toBe(false)
  })
})

describe('proxy username presentation', () => {
  it('keeps long usernames in the table and exposes the full value in connection details', () => {
    const proxy = { ...row, username: `sample-${'long-session-'.repeat(8)}endpoint-001` }
    const cell = renderToStaticMarkup(createElement(ProxyUsernameCell, { row: proxy }))
    const detail = renderToStaticMarkup(
      createElement(ProxyIdentityDetails, { row: proxy }),
    )
    expect(cell).toContain(proxy.username)
    expect(cell).toContain(`title="${proxy.username}"`)
    expect(detail).toContain(proxy.username)
    expect(detail).toContain('proxy.example.test:8080')
    expect(detail).toContain('HTTP / SOCKS5')
    expect(detail).toContain('已配置')
  })

  it('states when no username is configured', () => {
    const proxy = { ...row, username: '' }
    const cell = renderToStaticMarkup(createElement(ProxyUsernameCell, { row: proxy }))
    const detail = renderToStaticMarkup(
      createElement(ProxyIdentityDetails, { row: proxy }),
    )
    expect(cell).toContain('未设置用户名')
    expect(detail).toContain('未设置')
  })
})
