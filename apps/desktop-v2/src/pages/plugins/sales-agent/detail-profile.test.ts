import { beforeEach, expect, it, vi } from 'vitest'
import { nativeApi } from '../../../raccoon/api'
import { findDetailProfile } from '../../../raccoon/plugins/detail-profile'
import { nativeWindow, ids } from './test-data'

vi.mock('../../../raccoon/api', () => ({ nativeApi: { call: vi.fn() } }))
beforeEach(() => vi.clearAllMocks())

it('locates a linked Raccoon UUID across Workspaces through the registered list command', async () => {
  vi.mocked(nativeApi.call).mockResolvedValue([
    { ...nativeWindow, id: ids.otherWindow },
    { ...nativeWindow, connectionId: 'other-connection' },
  ])
  await expect(findDetailProfile(nativeWindow.id)).resolves.toMatchObject({
    id: nativeWindow.id,
    connectionId: 'other-connection',
  })
  expect(nativeApi.call).toHaveBeenCalledExactlyOnceWith('browser_window_list', {
    connectionId: null,
  })
})

it('reports a missing or ambiguous Profile without substituting another UUID', async () => {
  vi.mocked(nativeApi.call).mockResolvedValue([{ ...nativeWindow, id: ids.otherWindow }])
  await expect(findDetailProfile(nativeWindow.id)).rejects.toThrow('不可见')
  vi.mocked(nativeApi.call).mockResolvedValue([nativeWindow, nativeWindow])
  await expect(findDetailProfile(nativeWindow.id)).rejects.toThrow('重复')
})
