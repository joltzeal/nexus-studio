import { beforeEach, expect, it, vi } from 'vitest'
import { relaunch } from '@tauri-apps/plugin-process'
import { listNativeProfiles } from './native-profiles'
import { installAppUpdate, type AvailableUpdate } from './app-updates'

vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))
vi.mock('./native-profiles', () => ({ listNativeProfiles: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

it('refuses to install an update while a browser window is running', async () => {
  vi.mocked(listNativeProfiles).mockResolvedValue([{ running: true }] as Awaited<
    ReturnType<typeof listNativeProfiles>
  >)
  const downloadAndInstall = vi.fn()
  const update = { downloadAndInstall } as unknown as AvailableUpdate

  await expect(installAppUpdate(update, () => {})).rejects.toThrow(
    '请先停止所有运行中的窗口',
  )
  expect(downloadAndInstall).not.toHaveBeenCalled()
  expect(relaunch).not.toHaveBeenCalled()
})

it('installs an update and relaunches when every window is stopped', async () => {
  vi.mocked(listNativeProfiles).mockResolvedValue([])
  const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
  const update = { downloadAndInstall } as unknown as AvailableUpdate
  const progress = vi.fn()

  await installAppUpdate(update, progress)
  expect(downloadAndInstall).toHaveBeenCalledOnce()
  expect(relaunch).toHaveBeenCalledOnce()
})
