import { invoke, isTauri } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openExternalUrl, safeExternalHttpUrl } from './external-url'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

const browserOpen = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isTauri).mockReturnValue(true)
  vi.mocked(invoke).mockResolvedValue(undefined)
  vi.stubGlobal('window', { open: browserOpen })
})

afterEach(() => vi.unstubAllGlobals())

describe('external URL adapter', () => {
  it.each([
    [
      ' HTTPS://www.vinted.fr/items/123?ref=catalog#details ',
      'https://www.vinted.fr/items/123?ref=catalog#details',
    ],
    ['http://vinted.fr/member/123', 'http://vinted.fr/member/123'],
  ])(
    'opens a validated HTTP(S) link with the desktop command: %s',
    async (input, url) => {
      await openExternalUrl(input)
      expect(invoke).toHaveBeenCalledExactlyOnceWith('external_url_open', { url })
      expect(browserOpen).not.toHaveBeenCalled()
    },
  )

  it.each([
    '',
    'not a URL',
    '//vinted.fr/items/1',
    '/items/1',
    'https:vinted.fr/items/1',
    'javascript:alert(1)',
    'file:///tmp/item.html',
    'data:text/html,hello',
    'mailto:seller@example.com',
    'vinted://items/1',
    'https://user:secret@vinted.fr/items/1',
    'https://user@vinted.fr/items/1',
    'https://vinted.fr\\@example.com/items/1',
    'https://vinted.fr/items/1\n',
    'https://vin\tted.fr/items/1',
    'https://vinted.fr/items/\u0000',
    'https://vinted.fr/items/\u007f',
  ])('rejects unsafe or malformed input before either opener: %j', async (url) => {
    expect(safeExternalHttpUrl(url)).toBeNull()
    await expect(openExternalUrl(url)).rejects.toThrow('链接无效')
    expect(invoke).not.toHaveBeenCalled()
    expect(browserOpen).not.toHaveBeenCalled()
  })

  it('opens preview links synchronously with no opener access or referrer', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    // Browsers can return null for a successful noopener open.
    browserOpen.mockReturnValue(null)
    const pending = openExternalUrl('https://vinted.fr/items/123')
    expect(browserOpen).toHaveBeenCalledExactlyOnceWith(
      'https://vinted.fr/items/123',
      '_blank',
      'noopener,noreferrer',
    )
    await expect(pending).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('propagates desktop errors for retry without falling back into the WebView', async () => {
    const failure = new Error('native opener failed')
    vi.mocked(invoke).mockRejectedValueOnce(failure)
    await expect(openExternalUrl('https://vinted.fr/items/123')).rejects.toBe(failure)
    expect(browserOpen).not.toHaveBeenCalled()
    await openExternalUrl('https://vinted.fr/items/123')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
