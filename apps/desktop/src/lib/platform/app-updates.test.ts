import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { Update, type DownloadEvent } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { listNativeProfiles } from './native-profiles'
import {
  checkAppUpdate,
  installAppUpdate,
  updatesAvailable,
  type AvailableUpdate,
} from './app-updates'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-updater', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/plugin-updater')>()),
  check: () => Promise.resolve(null),
}))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))
vi.mock('./native-profiles', () => ({ listNativeProfiles: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isTauri).mockReturnValue(true)
  vi.mocked(relaunch).mockResolvedValue(undefined)
  vi.mocked(listNativeProfiles).mockResolvedValue([])
  vi.stubEnv('PROD', true)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

it('checks through the native service and keeps the Tauri update resource for signed installation', async () => {
  vi.mocked(invoke).mockResolvedValue({
    rid: 42,
    currentVersion: '0.1.1',
    version: '0.1.2',
    body: 'Release notes',
    rawJson: { version: '0.1.2' },
  })

  const update = await checkAppUpdate()

  expect(invoke).toHaveBeenCalledExactlyOnceWith('app_update_check')
  expect(update).toBeInstanceOf(Update)
  expect(update?.rid).toBe(42)
  expect(update?.version).toBe('0.1.2')
  expect(update?.body).toBe('Release notes')
})

it('returns no update only when the native check succeeds with null', async () => {
  vi.mocked(invoke).mockResolvedValue(null)
  await expect(checkAppUpdate()).resolves.toBeNull()
})

it.each([
  ['update_source', '更新源未提供有效的发布清单'],
  ['proxy_settings', '无法读取应用代理设置'],
  ['proxy_config', '应用代理配置不可用'],
  ['manifest', '更新清单格式无效'],
  ['platform', '更新清单缺少当前平台'],
  ['timeout', '检查更新超时'],
  ['network', '无法连接更新源'],
])('shows an actionable %s check error', async (code, message) => {
  vi.mocked(invoke).mockRejectedValue({ code })
  await expect(checkAppUpdate()).rejects.toThrow(message)
})

it('does not expose arbitrary native diagnostics, URLs or credentials', async () => {
  const diagnostic = 'https://private.invalid/?token=sensitive-diagnostic'
  vi.mocked(invoke).mockRejectedValue({
    code: 'unknown',
    message: diagnostic,
  })

  await expect(checkAppUpdate()).rejects.toThrow('检查更新失败，请重试')
  await expect(checkAppUpdate()).rejects.not.toThrow(diagnostic)
})

it.each([{}, { rid: -1, version: '0.1.2' }, 'not metadata', undefined])(
  'rejects malformed update metadata instead of reporting up to date: %j',
  async (metadata) => {
    vi.mocked(invoke).mockResolvedValue(metadata)
    await expect(checkAppUpdate()).rejects.toThrow('更新服务返回的数据无效')
  },
)

it('does not call the updater from a web preview or a development build', async () => {
  vi.mocked(isTauri).mockReturnValue(false)
  expect(updatesAvailable()).toBe(false)
  await expect(checkAppUpdate()).rejects.toThrow('发行版桌面应用')
  vi.mocked(isTauri).mockReturnValue(true)
  vi.stubEnv('PROD', false)
  expect(updatesAvailable()).toBe(false)
  await expect(checkAppUpdate()).rejects.toThrow('发行版桌面应用')
  expect(invoke).not.toHaveBeenCalled()
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
  const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
  const update = { downloadAndInstall } as unknown as AvailableUpdate
  const progress = vi.fn()

  await installAppUpdate(update, progress)
  expect(downloadAndInstall).toHaveBeenCalledOnce()
  expect(relaunch).toHaveBeenCalledOnce()
})

it('reports download progress and resets it when a download restarts', async () => {
  const events: DownloadEvent[] = [
    { event: 'Started', data: { contentLength: 100 } },
    { event: 'Progress', data: { chunkLength: 40 } },
    { event: 'Progress', data: { chunkLength: 60 } },
    { event: 'Finished' },
    { event: 'Started', data: {} },
    { event: 'Progress', data: { chunkLength: 25 } },
  ]
  const downloadAndInstall = vi.fn(async (onEvent: (event: DownloadEvent) => void) => {
    events.forEach(onEvent)
  })
  const progress = vi.fn()

  await installAppUpdate({ downloadAndInstall } as unknown as AvailableUpdate, progress)

  expect(progress.mock.calls).toEqual([
    [0, 100],
    [40, 100],
    [100, 100],
    [100, 100],
    [0, null],
    [25, null],
  ])
})

it('does not install if the running-window status cannot be read', async () => {
  vi.mocked(listNativeProfiles).mockRejectedValue('private native diagnostic')
  const downloadAndInstall = vi.fn()

  await expect(
    installAppUpdate({ downloadAndInstall } as unknown as AvailableUpdate, () => {}),
  ).rejects.toThrow('无法确认窗口状态')
  expect(downloadAndInstall).not.toHaveBeenCalled()
  expect(relaunch).not.toHaveBeenCalled()
})

it('does not relaunch after a signature verification failure', async () => {
  const downloadAndInstall = vi
    .fn()
    .mockRejectedValue('The signature verification failed')

  await expect(
    installAppUpdate({ downloadAndInstall } as unknown as AvailableUpdate, () => {}),
  ).rejects.toThrow('更新包签名验证失败')
  expect(relaunch).not.toHaveBeenCalled()
})

it('distinguishes download errors from an installed update that cannot restart', async () => {
  const downloadAndInstall = vi
    .fn()
    .mockRejectedValueOnce('error sending request for url (https://private.invalid)')
    .mockResolvedValueOnce(undefined)
  const update = { downloadAndInstall } as unknown as AvailableUpdate

  await expect(installAppUpdate(update, () => {})).rejects.toThrow('更新包下载失败')
  expect(relaunch).not.toHaveBeenCalled()
  vi.mocked(relaunch).mockRejectedValue('private restart diagnostic')
  await expect(installAppUpdate(update, () => {})).rejects.toThrow(
    '更新已安装，但无法自动重启',
  )
})
