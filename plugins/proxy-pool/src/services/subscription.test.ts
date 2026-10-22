import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { isPluginFailure } from '../domain/errors.js'
import type { EndpointRecord } from '../domain/schemas.js'
import { nodeNames } from './node-names.js'
import {
  hashToken,
  newSubscriptionToken,
  parseBaseConfig,
  renderClash,
  tokenMatches,
} from './subscription.js'

function row(overrides: Partial<EndpointRecord> = {}): EndpointRecord {
  return {
    id: 1,
    name: 'pool-1',
    schemes: ['socks5h'],
    host: 'proxy.example',
    port: 1080,
    username: 'user',
    secretRef: 'mem:proxy-password:1',
    credentialFingerprint: 'digest',
    fingerprint: 'fingerprint',
    groupId: null,
    enabled: true,
    udp: true,
    checkStatus: 'ok',
    checkedScheme: 'socks5h',
    checkedAt: '2026-01-01T00:00:00.000Z',
    exitIp: '45.33.32.156',
    exitIpCheckedAt: '2026-01-01T00:00:00.000Z',
    previousExitIp: null,
    previousExitIpCheckedAt: null,
    geo: null,
    reputation: null,
    riskScore: null,
    isProxy: null,
    isVpn: null,
    isHosting: null,
    latencyMs: null,
    checkError: null,
    deleted: false,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function message(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (isPluginFailure(error)) return error.message
    throw error
  }
  throw new Error('expected a plugin failure')
}

describe('Clash base configuration', () => {
  it('accepts an empty document and the default template', () => {
    expect(parseBaseConfig('', 'PROXY')).toEqual({})
    expect(
      parseBaseConfig(
        'mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\n',
        'PROXY',
      ),
    ).toEqual({
      'mixed-port': 7890,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'info',
    })
  })

  it('rejects nodes, aliases and unknown structure', () => {
    expect(message(() => parseBaseConfig('proxies: []', 'PROXY'))).toContain('proxies')
    expect(message(() => parseBaseConfig('proxy-groups: []', 'PROXY'))).toContain(
      'proxy-groups',
    )
    expect(
      message(() => parseBaseConfig('base: &a\n  mode: rule\ncopy: *a\n', 'PROXY')),
    ).toBe('基础 YAML 配置无效，请检查缩进、锚点与字段类型')
    expect(message(() => parseBaseConfig('- just\n- a list\n', 'PROXY'))).toBe(
      '基础 YAML 配置必须是键值映射',
    )
    expect(message(() => parseBaseConfig('mode: proxy\n', 'PROXY'))).toContain('mode')
    expect(message(() => parseBaseConfig('mixed-port: 70000\n', 'PROXY'))).toContain(
      'mixed-port',
    )
    expect(message(() => parseBaseConfig('allow-lan: "yes"\n', 'PROXY'))).toContain(
      'allow-lan',
    )
  })

  it('only allows rules that resolve to the generated group or built-ins', () => {
    expect(
      parseBaseConfig('rules:\n  - DOMAIN-SUFFIX,example.com,PROXY\n', 'PROXY'),
    ).toEqual({
      rules: ['DOMAIN-SUFFIX,example.com,PROXY'],
    })
    expect(
      message(() =>
        parseBaseConfig('rules:\n  - DOMAIN-SUFFIX,example.com,OTHER\n', 'PROXY'),
      ),
    ).toContain('内置策略')
    expect(message(() => parseBaseConfig('rules: []\n', 'PROXY'))).toContain('非空列表')
  })
})

describe('Clash rendering', () => {
  it('renders nodes, a select group and a default rule', () => {
    const rows = [
      row({ id: 1, name: 'socks', schemes: ['socks5h'], udp: true }),
      row({
        id: 2,
        name: 'https',
        schemes: ['https'],
        host: 'second.example',
        port: 8443,
        username: '',
        secretRef: null,
        udp: false,
      }),
    ]
    const yaml = renderClash({
      rows,
      config: {},
      groupName: 'PROXY',
      includeDirect: true,
      preferredScheme: null,
      passwordFor: () => 'p@ssw0rd',
    })
    const output = parse(yaml) as Record<string, unknown>
    expect(output['mixed-port']).toBe(7890)
    expect(output.rules).toEqual(['MATCH,PROXY'])
    const nodes = output.proxies as Record<string, unknown>[]
    expect(nodes[0]).toMatchObject({ type: 'socks5', server: 'proxy.example', udp: true })
    expect(nodes[1]).toMatchObject({ type: 'http', tls: true })
    expect(nodes[1]?.password).toBeUndefined()
    const groups = output['proxy-groups'] as Record<string, unknown>[]
    expect(groups[0]?.proxies).toEqual([nodes[0]?.name, nodes[1]?.name, 'DIRECT'])
  })

  it('redacts the password for preview but keeps the field', () => {
    const yaml = renderClash({
      rows: [row()],
      config: {},
      groupName: 'PROXY',
      includeDirect: false,
      preferredScheme: null,
      passwordFor: () => '',
      redactSecrets: true,
    })
    const output = parse(yaml) as { proxies: Record<string, unknown>[] }
    expect(output.proxies[0]?.password).toBe('***')
    expect(output.proxies[0]?.username).toBe('user')
  })

  it('honours the preferred protocol and rejects one that is not configured', () => {
    const yaml = renderClash({
      rows: [row({ schemes: ['http', 'https'] })],
      config: {},
      groupName: 'PROXY',
      includeDirect: false,
      preferredScheme: 'https',
      passwordFor: () => 'p',
    })
    expect(
      (parse(yaml) as { proxies: Record<string, unknown>[] }).proxies[0],
    ).toMatchObject({
      type: 'http',
      tls: true,
    })
    expect(
      message(() =>
        renderClash({
          rows: [row({ schemes: ['http', 'https'] })],
          config: {},
          groupName: 'PROXY',
          includeDirect: false,
          preferredScheme: 'socks5',
          passwordFor: () => 'p',
        }),
      ),
    ).toContain('未配置所选协议')
  })

  it('refuses to render an empty subscription', () => {
    expect(
      message(() =>
        renderClash({
          rows: [],
          config: {},
          groupName: 'PROXY',
          includeDirect: false,
          preferredScheme: null,
          passwordFor: () => '',
        }),
      ),
    ).toContain('没有可用代理节点')
  })
})

describe('node names', () => {
  it('uses saved location and score, then de-duplicates', () => {
    const geo = {
      status: 'ok' as const,
      source: 'proxycheck.io' as const,
      country: 'Germany',
      countryCode: 'DE',
      region: 'Berlin',
      city: 'Berlin',
      isp: null,
      error: null,
    }
    const names = nodeNames(
      [
        row({ id: 1, geo, riskScore: 20 }),
        row({ id: 2, geo, riskScore: 20 }),
        row({ id: 3, name: 'plain' }),
      ],
      'PROXY',
    )
    expect(names[0]).toBe('🇩🇪 Germany · Berlin · IP 80/100')
    expect(names[1]).toBe('🇩🇪 Germany · Berlin · IP 80/100 #2')
    expect(names[2]).toBe('plain')
  })

  it('never collides with built-in policy names', () => {
    const names = nodeNames(
      [row({ name: 'DIRECT' }), row({ id: 2, name: 'PROXY' })],
      'PROXY',
    )
    expect(names).toEqual(['DIRECT #2', 'PROXY #2'])
  })
})

describe('subscription tokens', () => {
  it('produces a 43 character token and verifies it in constant time', () => {
    const { token, hash } = newSubscriptionToken()
    expect(token).toHaveLength(43)
    expect(hash).toBe(hashToken(token))
    expect(tokenMatches(token, hash)).toBe(true)
    expect(tokenMatches(`${token}x`, hash)).toBe(false)
    expect(tokenMatches('short', hash)).toBe(false)
  })
})
