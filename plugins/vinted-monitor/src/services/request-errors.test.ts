import { describe, expect, it } from 'vitest'
import { upstreamErrorText, upstreamFailure } from '../domain/errors.js'
import { networkFailure, statusFailure } from './request-errors.js'

describe('safe Vinted transport diagnostics', () => {
  it.each([
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['ETIMEDOUT', 'timeout'],
    ['ECONNRESET', 'upstream-network'],
  ])('classifies %s while removing exception contents', (code, reason) => {
    const cause = Object.assign(new Error('https://user:password@private-proxy'), {
      code,
    })
    const error = networkFailure(new TypeError('fetch failed', { cause }), 'session')
    expect(error.reason).toBe(reason)
    expect(upstreamErrorText(error)).toContain('初始化会话')
    expect(JSON.stringify(error)).not.toContain('password')
    expect(upstreamFailure(error).message).not.toContain('private-proxy')
  })

  it('recognizes Undici CONNECT authentication rejection through its wrapped error', () => {
    const cause = Object.assign(
      new Error('Proxy response (407) !== 200 when HTTP Tunneling'),
      { code: 'UND_ERR_ABORTED' },
    )
    const error = networkFailure(new TypeError('fetch failed', { cause }), 'session')
    expect(error).toMatchObject({ reason: 'proxy-auth', status: 407 })
    expect(upstreamErrorText(error)).toContain('代理认证失败')
    expect(upstreamErrorText(error)).toContain('HTTP 407')
  })

  it('retains the underlying SOCKS/TLS classification through proxy wrappers', () => {
    const tls = Object.assign(new Error('secret'), { code: 'CERT_HAS_EXPIRED' })
    const wrapped = new Error('Proxy connection failed', { cause: tls })
    expect(networkFailure(wrapped, 'items').reason).toBe('tls')
    const socks = Object.assign(new Error('Socks5 Authentication failed: secret'), {
      name: 'SocksClientError',
    })
    expect(
      networkFailure(new Error('Proxy connection failed', { cause: socks }), 'items')
        .reason,
    ).toBe('proxy-auth')
  })

  it('keeps HTTP status and collection phase without the response body or location', () => {
    for (const status of [302, 401, 403, 404, 407, 429, 500, 503, 504]) {
      const error = statusFailure(status, 'items')
      expect(upstreamErrorText(error)).toContain(`HTTP ${status}`)
      expect(upstreamFailure(error).message).toContain('获取商品')
    }
    expect(upstreamFailure(statusFailure(429, 'items')).code).toBe('RATE_LIMITED')
    expect(upstreamFailure(statusFailure(504, 'user')).code).toBe('TIMEOUT')
  })
})
