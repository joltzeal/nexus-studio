import { describe, expect, it } from 'vitest'
import {
  indexProxyUsage,
  proxyUsageLabel,
  type ProxyUsageProfile,
  type ProxyUsageState,
} from './proxy-usage'
import { PROXY_PLUGIN_ID } from './types'

function profile(
  id: string,
  endpoint: number | null,
  overrides: Partial<ProxyUsageProfile> = {},
): ProxyUsageProfile {
  return {
    id,
    name: `Window ${id}`,
    proxyPlugin: PROXY_PLUGIN_ID,
    proxyEndpoint: endpoint,
    ...overrides,
  }
}

describe('proxy endpoint usage', () => {
  it('counts explicit bindings and followers of the current default together', () => {
    const usage = indexProxyUsage(
      [profile('pinned', 7), profile('default', null), profile('other', 8)],
      '7',
    )
    expect(usage.get('7')).toEqual({
      current: null,
      others: [
        { id: 'pinned', name: 'Window pinned', viaDefault: false },
        { id: 'default', name: 'Window default', viaDefault: true },
      ],
    })
    expect(usage.get('8')?.others).toHaveLength(1)
  })

  it('excludes the edited window by ID while retaining another window of the same name', () => {
    const usage = indexProxyUsage(
      [
        profile('editing', 7, { name: 'Shared name' }),
        profile('other', 7, { name: 'Shared name' }),
      ],
      null,
      'editing',
    )
    expect(usage.get('7')).toEqual({
      current: { id: 'editing', name: 'Shared name', viaDefault: false },
      others: [{ id: 'other', name: 'Shared name', viaDefault: false }],
    })
  })

  it('represents the current window following the default separately', () => {
    const usage = indexProxyUsage([profile('editing', null)], '9', 'editing')
    const state: ProxyUsageState = { status: 'loaded', byEndpoint: usage }
    expect(usage.get('9')?.current?.viaDefault).toBe(true)
    expect(proxyUsageLabel(state, '9')).toBe('当前窗口使用（跟随默认） · 无其他窗口使用')
  })

  it('moves default followers when the default changes but retains explicit bindings', () => {
    const profiles = [profile('pinned', 7), profile('default', null)]
    const first = indexProxyUsage(profiles, '7')
    const next = indexProxyUsage(profiles, '8')
    expect(first.get('7')?.others).toHaveLength(2)
    expect(next.get('7')?.others.map((window) => window.id)).toEqual(['pinned'])
    expect(next.get('8')?.others.map((window) => window.id)).toEqual(['default'])
  })

  it('does not assign default followers when no default is configured', () => {
    const usage = indexProxyUsage([profile('default', null), profile('pinned', 7)], null)
    expect([...usage.keys()]).toEqual(['7'])
    expect(usage.get('7')?.others.map((window) => window.id)).toEqual(['pinned'])
  })

  it('ignores other plugins and direct or manually configured windows', () => {
    const usage = indexProxyUsage(
      [
        profile('other-plugin', 7, { proxyPlugin: 'another.proxy-provider' }),
        profile('other-default', null, { proxyPlugin: 'another.proxy-provider' }),
        profile('direct', null, { proxyPlugin: null }),
        profile('manual', 7, { proxyPlugin: null }),
        profile('pool', 7),
      ],
      '7',
    )
    expect(usage.get('7')?.others.map((window) => window.id)).toEqual(['pool'])
  })

  it('counts saved bindings for both stopped and running windows', () => {
    const profiles = [
      { ...profile('stopped', 7), running: false },
      { ...profile('running', 7), running: true },
    ]
    expect(indexProxyUsage(profiles, null).get('7')?.others).toHaveLength(2)
  })

  it('keeps endpoint identities separate even when windows have the same label', () => {
    const usage = indexProxyUsage(
      [
        profile('first', 7, { name: 'Same gateway' }),
        profile('second', 8, { name: 'Same gateway' }),
      ],
      null,
    )
    expect(usage.get('7')?.others.map((window) => window.id)).toEqual(['first'])
    expect(usage.get('8')?.others.map((window) => window.id)).toEqual(['second'])
  })

  it('shows the count and names, marks default followers, and excludes the current window from the count', () => {
    const state: ProxyUsageState = {
      status: 'loaded',
      byEndpoint: indexProxyUsage(
        [profile('editing', 7), profile('pinned', 7), profile('default', null)],
        '7',
        'editing',
      ),
    }
    expect(proxyUsageLabel(state, '7')).toBe(
      '当前窗口使用 · 已被 2 个其他窗口使用：Window pinned、Window default（跟随默认）',
    )
  })

  it('only calls an endpoint unused after successfully reading the bindings and default', () => {
    expect(proxyUsageLabel({ status: 'loading' }, '7')).toBe('正在读取窗口占用…')
    expect(
      proxyUsageLabel({ status: 'error', message: 'Profile list unavailable' }, '7'),
    ).toBe('窗口占用未知（读取失败）')
    expect(
      proxyUsageLabel({ status: 'loaded', byEndpoint: indexProxyUsage([], null) }, '7'),
    ).toBe('未被窗口使用')
  })
})
