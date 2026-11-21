import { invoke, isTauri } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { Update } from '@tauri-apps/plugin-updater'
import { afterEach, expect, it, vi } from 'vitest'
import { startAppUpdateChecks, useAppUpdate } from './update'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('can install the downloaded update after an active Profile stops', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, setInterval })
  vi.stubEnv('PROD', true)
  vi.mocked(isTauri).mockReturnValue(true)
  vi.mocked(invoke)
    .mockResolvedValueOnce({
      rid: 42,
      currentVersion: '0.2.0',
      version: '0.2.1',
      rawJson: { version: '0.2.1' },
    })
    .mockRejectedValueOnce({ code: 'running_windows' })
    .mockResolvedValueOnce(73)
  const download = vi.spyOn(Update.prototype, 'download').mockResolvedValue(undefined)
  const install = vi.spyOn(Update.prototype, 'install').mockResolvedValue(undefined)
  vi.mocked(relaunch).mockResolvedValue(undefined)

  startAppUpdateChecks()
  await vi.advanceTimersByTimeAsync(10_000)

  expect(useAppUpdate.getState().phase).toBe('ready')
  await expect(useAppUpdate.getState().install()).rejects.toThrow('请先停止运行中的 Profile')
  expect(useAppUpdate.getState().phase).toBe('ready')
  expect(install).not.toHaveBeenCalled()

  await useAppUpdate.getState().install()
  expect(download).toHaveBeenCalledOnce()
  expect(install).toHaveBeenCalledOnce()
  expect(relaunch).toHaveBeenCalledOnce()
})
