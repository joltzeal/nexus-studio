import { describe, expect, it } from 'vitest'

import {
  buildConnectionUrl,
  buildRedactedUrl,
  endpointFingerprint,
  parseProxyUrl,
} from '../domain/credentials.js'
import { isPluginFailure } from '../domain/errors.js'
import { DecodoInputSchema, normalizeHost, parseOrThrow } from '../domain/schemas.js'
import { decodoInputs, parseImportInput } from './import.js'

function failureMessage(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (isPluginFailure(error)) return error.message
    throw error
  }
  throw new Error('expected a plugin failure')
}

describe('proxy URL parsing', () => {
  it('accepts the four supported schemes and decodes credentials', () => {
    expect(parseProxyUrl('socks5h://user%40name:p%40ss@1.2.3.4:1080')).toEqual({
      scheme: 'socks5h',
      host: '1.2.3.4',
      port: 1080,
      username: 'user@name',
      password: 'p@ss',
    })
    expect(parseProxyUrl('http://[2001:db8::1]:8080/').host).toBe('2001:db8::1')
  })

  it.each([
    'ftp://1.2.3.4:21',
    'http://1.2.3.4',
    'http://1.2.3.4:8080/path',
    'http://1.2.3.4:8080?x=1',
    'http://1.2.3.4:8080#frag',
    'http://1.2.3.4:99999',
    'not a url',
    '',
  ])('rejects %s without echoing the input', (value) => {
    const message = failureMessage(() => parseProxyUrl(value))
    expect(message).toBe('代理 URL 无效，请检查协议、认证信息、主机和端口')
    if (value !== '') expect(message).not.toContain(value)
  })
})

describe('host normalization', () => {
  it('lowercases, converts IDN and strips IPv6 brackets', () => {
    expect(normalizeHost('Example.COM.')).toBe('example.com')
    expect(normalizeHost('bücher.example')).toBe('xn--bcher-kva.example')
    expect(normalizeHost('[2001:0db8:0000::1]')).toBe('2001:db8::1')
    expect(normalizeHost(' 10.0.0.1 ')).toBe('10.0.0.1')
  })

  it.each(['host:8080', 'http://example.com', 'exa mple.com', '[fe80::1%eth0]'])(
    'rejects %s',
    (value) => {
      expect(() => normalizeHost(value)).toThrow()
    },
  )
})

describe('connection URLs', () => {
  it('percent-encodes credentials and brackets IPv6 hosts', () => {
    expect(buildConnectionUrl('socks5', '2001:db8::1', 1080, 'u@x', 'p:y')).toBe(
      'socks5://u%40x:p%3Ay@[2001:db8::1]:1080',
    )
    expect(buildRedactedUrl('http', 'example.com', 8080, 'user')).toBe(
      'http://user@example.com:8080',
    )
    expect(buildRedactedUrl('http', 'example.com', 8080, '')).toBe(
      'http://example.com:8080',
    )
  })

  it('separates rows by address and the vault-provided credential digest', () => {
    const base = endpointFingerprint('example.com', 8080, 'user', 'digest-a')
    expect(endpointFingerprint('example.com', 8080, 'user', 'digest-a')).toBe(base)
    expect(endpointFingerprint('example.com', 8080, 'user', 'digest-b')).not.toBe(base)
    expect(endpointFingerprint('example.com', 8081, 'user', 'digest-a')).not.toBe(base)
  })
})

describe('import input', () => {
  it('builds one row per non-empty line', () => {
    const rows = parseImportInput({
      proxyUrls: 'http://a.example:8080\n\nsocks5://b.example:1080\n',
      groupId: 3,
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.name).toBe('proxy-8080')
    expect(rows[1]?.schemes).toEqual(['socks5'])
    expect(rows[0]?.groupId).toBe(3)
  })

  it('fails the whole batch and points at the offending line', () => {
    const message = failureMessage(() =>
      parseImportInput({ proxyUrls: 'http://a.example:8080\nbad-line', groupId: null }),
    )
    expect(message).toBe('第 2 行代理 URL 无效；未保存任何记录')
    expect(message).not.toContain('bad-line')
  })

  it('rejects an empty list and an oversized batch', () => {
    expect(
      failureMessage(() => parseImportInput({ proxyUrls: '  ', groupId: null })),
    ).toBe('请提供 1 至 1000 条代理 URL，每行一条')
    const many = Array.from({ length: 1001 }, (_, index) => `http://h:${index + 1}`)
    expect(
      failureMessage(() =>
        parseImportInput({ proxyUrls: many.join('\n'), groupId: null }),
      ),
    ).toBe('请提供 1 至 1000 条代理 URL，每行一条')
  })
})

describe('decodo strategy', () => {
  it('expands a bounded port range into endpoints', () => {
    const rows = decodoInputs({
      host: 'dc.decodo.com',
      username: 'user',
      password: 'secret',
      startPort: 10001,
      endPort: 10003,
      schemes: ['http', 'socks5'],
      udp: true,
      groupId: null,
    })
    expect(rows.map((row) => row.name)).toEqual([
      'decodo-10001',
      'decodo-10002',
      'decodo-10003',
    ])
  })

  it('rejects a range larger than the batch limit', () => {
    const message = failureMessage(() =>
      parseOrThrow(
        DecodoInputSchema,
        {
          host: 'dc.decodo.com',
          username: 'user',
          password: 'secret',
          startPort: 1,
          endPort: 2000,
          schemes: ['http'],
          udp: true,
          groupId: null,
        },
        'Decodo 策略参数',
      ),
    )
    expect(message).toBe(
      'Decodo 策略参数无效（endPort: 端口范围无效；单次最多生成 1000 条代理）',
    )
  })
})
