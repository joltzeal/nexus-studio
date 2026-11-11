import { expect, it, vi } from 'vitest'
import {
  activateBrowserConnection,
  confirmBrowserConnection,
  saveBrowserConnection,
} from './browser-connections'
import { browserConnectionDefaults, connectBrowser } from './browser-connection-setup'
import { browserConnection } from './browser-test-support'

vi.mock('./browser-connections', () => ({
  saveBrowserConnection: vi.fn(),
  confirmBrowserConnection: vi.fn(),
  activateBrowserConnection: vi.fn(),
}))

it('provides immediately usable local endpoints and names without an account label', () => {
  expect(browserConnectionDefaults('adspower')).toMatchObject({
    name: 'AdsPower',
    endpoint: 'http://127.0.0.1:50325',
    scopeLabel: 'AdsPower',
  })
  expect(browserConnectionDefaults('bitbrowser').endpoint).toBe('http://127.0.0.1:54345')
})

it('saves, probes through confirmation, and activates in order with a single action', async () => {
  const saved = browserConnection({ id: 'ads', enabled: false, scopeConfirmed: false })
  const confirmed = { ...saved, scopeConfirmed: true }
  vi.mocked(saveBrowserConnection).mockResolvedValueOnce(saved)
  vi.mocked(confirmBrowserConnection).mockResolvedValueOnce(confirmed)
  vi.mocked(activateBrowserConnection).mockResolvedValueOnce({
    ...confirmed,
    enabled: true,
  })
  const remember = vi.fn()
  const result = await connectBrowser(browserConnectionDefaults('adspower'), remember)
  expect(remember).toHaveBeenCalledExactlyOnceWith(saved)
  expect(confirmBrowserConnection).toHaveBeenLastCalledWith('ads', saved.scopeLabel)
  expect(activateBrowserConnection).toHaveBeenLastCalledWith('ads')
  expect(result.enabled).toBe(true)
  expect(vi.mocked(saveBrowserConnection).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(confirmBrowserConnection).mock.invocationCallOrder[0]!,
  )
  expect(vi.mocked(confirmBrowserConnection).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(activateBrowserConnection).mock.invocationCallOrder[0]!,
  )
})

it('remembers a saved connection on failed detection so retry can reuse its identity', async () => {
  vi.clearAllMocks()
  const saved = browserConnection({ id: 'saved-offline' })
  vi.mocked(saveBrowserConnection).mockResolvedValueOnce(saved)
  vi.mocked(confirmBrowserConnection).mockRejectedValueOnce(new Error('API offline'))
  const remember = vi.fn()
  await expect(
    connectBrowser(browserConnectionDefaults('adspower'), remember),
  ).rejects.toThrow('API offline')
  expect(remember).toHaveBeenCalledExactlyOnceWith(saved)
  expect(activateBrowserConnection).not.toHaveBeenCalled()
})

it('reconnects an unchanged active connection without a configuration write or reactivation', async () => {
  vi.clearAllMocks()
  const input = { ...browserConnectionDefaults('adspower'), id: 'ads' }
  const previous = browserConnection({
    ...input,
    id: 'ads',
    scopeConfirmed: false,
    enabled: true,
  })
  const confirmed = { ...previous, scopeConfirmed: true }
  vi.mocked(confirmBrowserConnection).mockResolvedValueOnce(confirmed)
  expect(await connectBrowser(input, vi.fn(), previous)).toEqual(confirmed)
  expect(saveBrowserConnection).not.toHaveBeenCalled()
  expect(activateBrowserConnection).not.toHaveBeenCalled()
})
