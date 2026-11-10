import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  activateBrowserConnection,
  attachBrowserWindows,
  confirmBrowserConnection,
  discoverBrowserProfiles,
  listBrowserConnections,
  listBrowserProviderGroups,
  probeBrowserConnection,
  saveBrowserConnection,
} from './browser-connections'
import { browserConnection, browserWindow } from './browser-test-support'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }))
beforeEach(() => vi.resetAllMocks())

it('uses exact connection save/confirm/activate commands and fields', async () => {
  const connection = browserConnection()
  const input = {
    id: 'ads-1',
    providerId: 'adspower' as const,
    name: 'AdsPower',
    endpoint: 'http://localhost:50325',
    apiKey: null,
    defaultGroupId: 'official-group',
    scopeLabel: 'work',
  }
  vi.mocked(invoke).mockResolvedValue(connection)
  await saveBrowserConnection(input)
  await confirmBrowserConnection('ads-1', 'work')
  await activateBrowserConnection('ads-1')
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['browser_connection_save', { input }],
    ['browser_connection_confirm', { id: 'ads-1', scopeLabel: 'work' }],
    ['browser_connection_activate', { id: 'ads-1' }],
  ])
  vi.mocked(invoke).mockResolvedValueOnce([connection])
  await expect(listBrowserConnections()).resolves.toEqual([connection])
})

it('validates probe, remote discovery and provider groups at the desktop boundary', async () => {
  const probe = {
    connected: true,
    message: 'connected',
    scopeId: null,
    capabilities: browserConnection().capabilities,
  }
  vi.mocked(invoke).mockResolvedValueOnce(probe)
  await expect(probeBrowserConnection('ads-1')).resolves.toEqual(probe)
  vi.mocked(invoke).mockResolvedValueOnce([
    {
      id: 'official',
      name: 'remote',
      kernelVersion: null,
      createdAt: null,
      providerConfig: {},
    },
  ])
  expect(await discoverBrowserProfiles('ads-1')).toHaveLength(1)
  expect(invoke).toHaveBeenLastCalledWith('browser_profile_discover', {
    connectionId: 'ads-1',
  })
  vi.mocked(invoke).mockResolvedValueOnce([{ id: 'g1', name: 'team' }])
  expect(await listBrowserProviderGroups('ads-1')).toEqual([{ id: 'g1', name: 'team' }])
  expect(invoke).toHaveBeenLastCalledWith('browser_group_list', { connectionId: 'ads-1' })
  vi.mocked(invoke).mockResolvedValueOnce({ connected: true })
  await expect(probeBrowserConnection('ads-1')).rejects.toThrow('格式')
})

it('attaches selected official IDs and requires a full window array result', async () => {
  const window = browserWindow({ origin: 'attached', proxyMode: 'provider' })
  vi.mocked(invoke).mockResolvedValueOnce([window])
  await expect(attachBrowserWindows('ads-1', ['official'])).resolves.toEqual([window])
  expect(invoke).toHaveBeenLastCalledWith('browser_window_attach', {
    connectionId: 'ads-1',
    profileIds: ['official'],
  })
  vi.mocked(invoke).mockResolvedValueOnce(window)
  await expect(attachBrowserWindows('ads-1', ['official'])).rejects.toThrow('格式')
  vi.mocked(invoke).mockClear()
  await expect(attachBrowserWindows('ads-1', [])).rejects.toThrow('选择')
  expect(invoke).not.toHaveBeenCalled()
})
