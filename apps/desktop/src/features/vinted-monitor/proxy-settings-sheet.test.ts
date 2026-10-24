import { describe, expect, it } from 'vitest'
import {
  parseMonitorProxyUrl,
  proxyInputFromForm,
  type ProxyFormValues,
} from './proxy-settings-sheet'

function form(overrides: Partial<ProxyFormValues> = {}): ProxyFormValues {
  return {
    name: 'Local proxy',
    scheme: 'socks5',
    host: '127.0.0.1',
    port: '7890',
    username: '',
    password: '',
    passwordMode: 'replace',
    enabled: true,
    hasPassword: false,
    ...overrides,
  }
}

describe('Vinted proxy URL import', () => {
  it.each(['http', 'https', 'socks5', 'socks5h'] as const)(
    'parses %s without choosing a default or persisting',
    (scheme) => {
      expect(parseMonitorProxyUrl(`${scheme}://127.0.0.1:7890`)).toEqual({
        scheme,
        host: '127.0.0.1',
        port: 7890,
        username: '',
        password: '',
      })
    },
  )

  it('preserves an explicitly supplied HTTP default port', () => {
    expect(parseMonitorProxyUrl('http://proxy.example:80').port).toBe(80)
    expect(parseMonitorProxyUrl('https://proxy.example:443').port).toBe(443)
  })

  it('decodes credentials once and accepts bracketed IPv6', () => {
    expect(
      parseMonitorProxyUrl('socks5h://demo%40user:p%3A%40%2520@[2001:db8::1]:1080/'),
    ).toEqual({
      scheme: 'socks5h',
      host: '2001:db8::1',
      port: 1080,
      username: 'demo@user',
      password: 'p:@%20',
    })
  })

  it.each([
    'socks4://127.0.0.1:7890',
    'http://proxy.example',
    'http://proxy.example:0',
    'http://proxy.example:65536',
    'http://proxy.example:1.5',
    'http://proxy.example:1e3',
    'http://proxy.example:80/path',
    'http://proxy.example:80?token=sample',
    'http://proxy.example:80#name',
    'http://proxy.example:80?',
    'http://proxy.example:80#',
    'http://proxy.example:80\\path',
    'http://proxy example:80',
    'http://-invalid.example:80',
    'http://127.1:80',
    'http://999.0.0.1:80',
    'socks5://::1:1080',
    'socks5://[invalid]:1080',
    'socks5://u:p@raw@127.0.0.1:1080',
    'socks5://u:%GG@127.0.0.1:1080',
    'socks5://u:%00@127.0.0.1:1080',
    'socks5://:sample@127.0.0.1:1080',
  ])('rejects ambiguous or malformed import %s', (url) => {
    expect(() => parseMonitorProxyUrl(url)).toThrow()
  })

  it('rejects multibyte SOCKS credentials beyond the wire limit', () => {
    expect(() =>
      parseMonitorProxyUrl(
        `socks5://demo:${encodeURIComponent('字'.repeat(86))}@127.0.0.1:1080`,
      ),
    ).toThrow('255')
  })

  it('does not include pasted credentials in validation errors', () => {
    const password = 'sample-sensitive-value'
    try {
      parseMonitorProxyUrl(`http://demo:${password}@proxy.example:99999`)
      expect.unreachable()
    } catch (cause) {
      expect(String(cause)).not.toContain(password)
    }
  })
})

describe('proxy save payload', () => {
  it('omits the password field when keeping an existing password', () => {
    const payload = proxyInputFromForm(
      form({
        id: 'existing',
        username: 'demo',
        password: 'discarded-draft',
        passwordMode: 'keep',
        hasPassword: true,
      }),
    )
    expect(payload).not.toHaveProperty('password')
    expect(payload).not.toHaveProperty('hasPassword')
    expect(payload).not.toHaveProperty('passwordMode')
  })

  it('clears a saved password only with an explicit empty password', () => {
    expect(
      proxyInputFromForm(
        form({
          id: 'existing',
          passwordMode: 'clear',
          password: 'discarded-draft',
          hasPassword: true,
        }),
      ),
    ).toMatchObject({ id: 'existing', password: '' })
  })

  it('replaces passwords without trimming credential whitespace', () => {
    expect(
      proxyInputFromForm(
        form({
          id: 'existing',
          username: ' demo ',
          password: ' sample ',
          passwordMode: 'replace',
        }),
      ),
    ).toMatchObject({ username: ' demo ', password: ' sample ' })
  })

  it('requires a password for replace mode on an existing proxy', () => {
    expect(() =>
      proxyInputFromForm(form({ id: 'existing', passwordMode: 'replace', password: '' })),
    ).toThrow('清除密码')
  })

  it('blocks removing the SOCKS username while preserving a saved password', () => {
    expect(() =>
      proxyInputFromForm(
        form({
          id: 'existing',
          passwordMode: 'keep',
          hasPassword: true,
          username: '',
        }),
      ),
    ).toThrow('用户名')
  })

  it('normalizes addresses and numbers without leaking read-only fields', () => {
    const payload = proxyInputFromForm(
      form({ name: ' Home ', host: ' PROXY.EXAMPLE ', port: '0080', enabled: false }),
    )
    expect(payload).toEqual({
      name: 'Home',
      scheme: 'socks5',
      host: 'proxy.example',
      port: 80,
      username: '',
      password: '',
      enabled: false,
    })
  })

  it.each([
    'http://proxy.example',
    'proxy.example:8080',
    'proxy.example/path',
    '[::1]:8080',
    '::1]:1/path',
  ])('rejects authority or path syntax in the host field: %s', (host) => {
    expect(() => proxyInputFromForm(form({ host }))).toThrow()
  })

  it.each(['', '0', '65536', '80.5', '1e3', 'Infinity'])(
    'rejects invalid numeric port %s',
    (port) => {
      expect(() => proxyInputFromForm(form({ port }))).toThrow('端口')
    },
  )
})
