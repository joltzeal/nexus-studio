import { describe, expect, it } from 'vitest'
import { parseProxyLink } from './parse-proxy-link'

describe('parseProxyLink', () => {
  it('reads the userinfo spelling', () => {
    expect(
      parseProxyLink('socks5://ltz1201PB937476:LBG8XsJxSq1v@wlau64u47b.cn.fxdx.in:13793'),
    ).toEqual({
      scheme: 'socks5',
      host: 'wlau64u47b.cn.fxdx.in',
      port: 13793,
      username: 'ltz1201PB937476',
      password: 'LBG8XsJxSq1v',
      format: 'userinfo',
    })
  })

  it('reads the colon-chain spelling', () => {
    expect(
      parseProxyLink('socks5://wlau64u47b.cn.fxdx.in:13793:ltz1201PB937476:LBG8XsJxSq1v'),
    ).toEqual({
      scheme: 'socks5',
      host: 'wlau64u47b.cn.fxdx.in',
      port: 13793,
      username: 'ltz1201PB937476',
      password: 'LBG8XsJxSq1v',
      format: 'colon-chain',
    })
  })

  it('keeps colons inside a chained password', () => {
    expect(parseProxyLink('http://host.test:8080:user:pa:ss:word')?.password).toBe(
      'pa:ss:word',
    )
  })

  it('reads a colon chain whose password contains an at sign', () => {
    expect(parseProxyLink('socks5://host.test:1080:user:p@ss')).toMatchObject({
      host: 'host.test',
      port: 1080,
      username: 'user',
      password: 'p@ss',
      format: 'colon-chain',
    })
  })

  it('accepts a colon chain without credentials', () => {
    expect(parseProxyLink('socks5h://host.test:1080')).toMatchObject({
      host: 'host.test',
      port: 1080,
      username: '',
      password: '',
    })
  })

  it('accepts a colon chain with only a username', () => {
    expect(parseProxyLink('socks5://host.test:1080:user')).toMatchObject({
      username: 'user',
      password: '',
    })
  })

  it('handles bracketed IPv6 in both spellings', () => {
    expect(parseProxyLink('socks5://[2001:db8::1]:1080:u:p')).toMatchObject({
      host: '2001:db8::1',
      port: 1080,
      username: 'u',
      password: 'p',
    })
    expect(parseProxyLink('http://u:p@[2001:db8::1]:8080')).toMatchObject({
      host: '2001:db8::1',
      port: 8080,
      username: 'u',
      password: 'p',
    })
  })

  it('decodes percent-encoded credentials', () => {
    expect(parseProxyLink('http://us%40er:p%3Ass@host.test:8080')).toMatchObject({
      username: 'us@er',
      password: 'p:ss',
    })
  })

  it('is case-insensitive about the scheme and tolerates a trailing slash', () => {
    expect(parseProxyLink('SOCKS5://user:pass@host.test:1080/')).toMatchObject({
      scheme: 'socks5',
      host: 'host.test',
    })
  })

  it('strips wrapping quotes from a pasted cell', () => {
    expect(parseProxyLink('"socks5://user:pass@host.test:1080"')?.host).toBe('host.test')
  })

  it('never treats a bare host as a link', () => {
    expect(parseProxyLink('host.test')).toBeNull()
    expect(parseProxyLink('host.test:1080')).toBeNull()
    expect(parseProxyLink('[2001:db8::1]:1080')).toBeNull()
    expect(parseProxyLink('')).toBeNull()
  })

  it('rejects unknown schemes, missing ports and out-of-range ports', () => {
    expect(parseProxyLink('ftp://user:pass@host.test:21')).toBeNull()
    expect(parseProxyLink('socks5://user:pass@host.test')).toBeNull()
    expect(parseProxyLink('socks5://host.test:0')).toBeNull()
    expect(parseProxyLink('socks5://host.test:70000')).toBeNull()
  })

  it('rejects input containing whitespace instead of repairing it', () => {
    expect(parseProxyLink('socks5://user:pass@host.test:1080 extra')).toBeNull()
  })
})
