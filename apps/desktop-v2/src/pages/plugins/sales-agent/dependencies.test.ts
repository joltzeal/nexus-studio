import { beforeEach, expect, it, vi } from 'vitest'
import { nativeApi } from '../../../raccoon/api'
import { listBrowserWindows } from './dependencies'
import { nativeWindow } from './test-data'

vi.mock('../../../raccoon/api', () => ({ nativeApi: { call: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

it('reads only the explicitly selected connection and rejects foreign Profiles', async () => {
  vi.mocked(nativeApi.call).mockResolvedValue([nativeWindow])
  await expect(listBrowserWindows('local')).resolves.toEqual([nativeWindow])
  expect(nativeApi.call).toHaveBeenCalledExactlyOnceWith('browser_window_list', {
    connectionId: 'local',
  })
  vi.mocked(nativeApi.call).mockResolvedValue([
    { ...nativeWindow, connectionId: 'other-workspace' },
  ])
  await expect(listBrowserWindows('local')).rejects.toThrow('Workspace')
})

it('does not widen an absent connection to the global Profile list', async () => {
  await expect(listBrowserWindows('')).rejects.toThrow('Workspace')
  expect(nativeApi.call).not.toHaveBeenCalled()
})
