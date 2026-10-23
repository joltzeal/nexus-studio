import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke, isTauri, Resource } from '@tauri-apps/api/core'
import { Update, type DownloadEvent } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { listNativeProfiles } from './native-profiles'
import {
  checkAppUpdate,
  downloadAppUpdate,
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
  vi.mocked(invoke).mockResolvedValue(73)
  vi.spyOn(Resource.prototype, 'close').mockResolvedValue(undefined)
  vi.stubEnv('PROD', true)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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

it('refuses native admission even when the displayed window list looks idle', async () => {
  vi.mocked(invoke).mockRejectedValue({ code: 'running_windows' })
  const install = vi.fn()
  const update = { install } as unknown as AvailableUpdate

  await expect(installAppUpdate(update)).rejects.toThrow('请先停止所有运行中的窗口')
  expect(install).not.toHaveBeenCalled()
  expect(relaunch).not.toHaveBeenCalled()
})

it('installs an update and relaunches when every window is stopped', async () => {
  const install = vi.fn().mockResolvedValue(undefined)
  const download = vi.fn()
  const update = { install, download } as unknown as AvailableUpdate

  await installAppUpdate(update)
  expect(install).toHaveBeenCalledOnce()
  expect(download).not.toHaveBeenCalled()
  expect(relaunch).toHaveBeenCalledOnce()
})

it('downloads in the background while windows are running without installing or restarting', async () => {
  vi.mocked(listNativeProfiles).mockResolvedValue([{ running: true }] as Awaited<
    ReturnType<typeof listNativeProfiles>
  >)
  const download = vi.fn().mockResolvedValue(undefined)
  const install = vi.fn()

  await downloadAppUpdate({ download, install } as unknown as AvailableUpdate, () => {})

  expect(download).toHaveBeenCalledOnce()
  expect(listNativeProfiles).not.toHaveBeenCalled()
  expect(install).not.toHaveBeenCalled()
  expect(relaunch).not.toHaveBeenCalled()
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
  const download = vi.fn(async (onEvent: (event: DownloadEvent) => void) => {
    events.forEach(onEvent)
  })
  const progress = vi.fn()

  await downloadAppUpdate({ download } as unknown as AvailableUpdate, progress)

  expect(progress.mock.calls).toEqual([
    [0, 100],
    [40, 100],
    [100, 100],
    [100, 100],
    [0, null],
    [25, null],
  ])
})

it('does not install if the native operation guard cannot be acquired', async () => {
  vi.mocked(invoke).mockRejectedValue('private native diagnostic')
  const install = vi.fn()

  await expect(
    installAppUpdate({ install } as unknown as AvailableUpdate),
  ).rejects.toThrow('无法确认窗口状态')
  expect(install).not.toHaveBeenCalled()
  expect(relaunch).not.toHaveBeenCalled()
})

it('waits for native admission and keeps its guard through installation and relaunch', async () => {
  let admit!: (rid: number) => void
  let finishInstall!: () => void
  let finishRelaunch!: () => void
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise<number>((resolve) => {
        admit = resolve
      }),
  )
  const install = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishInstall = resolve
      }),
  )
  vi.mocked(relaunch).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishRelaunch = resolve
      }),
  )

  const installing = installAppUpdate({ install } as unknown as AvailableUpdate)
  expect(invoke).toHaveBeenCalledExactlyOnceWith('app_update_begin_install')
  expect(install).not.toHaveBeenCalled()
  admit(73)
  await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
  expect(relaunch).not.toHaveBeenCalled()
  expect(Resource.prototype.close).not.toHaveBeenCalled()
  finishInstall()
  await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce())
  expect(Resource.prototype.close).not.toHaveBeenCalled()
  finishRelaunch()
  await installing
  // Relaunch can resolve before process exit. Only that exit releases the guard.
  expect(Resource.prototype.close).not.toHaveBeenCalled()
  expect(listNativeProfiles).not.toHaveBeenCalled()
})

it.each(['disk write failed', 'signature verification failed'])(
  'releases native admission before surfacing an installation failure: %s',
  async (diagnostic) => {
    const closed: number[] = []
    vi.mocked(Resource.prototype.close).mockImplementation(async function (
      this: Resource,
    ) {
      closed.push(this.rid)
    })
    const install = vi.fn().mockRejectedValue(diagnostic)

    await expect(
      installAppUpdate({ install } as unknown as AvailableUpdate),
    ).rejects.toThrow(diagnostic.includes('signature') ? '签名验证失败' : '安装更新失败')

    expect(closed).toEqual([73])
    expect(relaunch).not.toHaveBeenCalled()
  },
)

it('keeps admission held after successful installation if relaunch fails', async () => {
  const install = vi.fn().mockResolvedValue(undefined)
  vi.mocked(relaunch).mockRejectedValue('synthetic relaunch failure')

  await expect(
    installAppUpdate({ install } as unknown as AvailableUpdate),
  ).rejects.toThrow('更新已安装，但无法自动重启')

  expect(invoke).toHaveBeenCalledExactlyOnceWith('app_update_begin_install')
  expect(Resource.prototype.close).not.toHaveBeenCalled()
})

it.each([undefined, null, -1, 1.5, '73'])(
  'does not install with an invalid native guard resource: %j',
  async (rid) => {
    vi.mocked(invoke).mockResolvedValue(rid)
    const install = vi.fn()
    await expect(
      installAppUpdate({ install } as unknown as AvailableUpdate),
    ).rejects.toThrow('无法确认窗口状态')
    expect(install).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  },
)

it('requires an application restart if failed-install cleanup cannot release the guard', async () => {
  const install = vi.fn().mockRejectedValue('synthetic install failure')
  vi.mocked(Resource.prototype.close).mockRejectedValue('private native diagnostic')
  await expect(
    installAppUpdate({ install } as unknown as AvailableUpdate),
  ).rejects.toThrow('无法确认窗口状态，请退出并重新打开应用后重试')
  expect(relaunch).not.toHaveBeenCalled()
})

it('rejects a signature failure even after receiving the download-finished event', async () => {
  const download = vi
    .fn()
    .mockImplementation(async (onEvent: (event: DownloadEvent) => void) => {
      onEvent({ event: 'Finished' })
      throw new Error('The signature verification failed')
    })

  await expect(
    downloadAppUpdate({ download } as unknown as AvailableUpdate, () => {}),
  ).rejects.toThrow('更新包签名验证失败')
  expect(relaunch).not.toHaveBeenCalled()
})

it('distinguishes download errors from an installed update that cannot restart', async () => {
  const download = vi
    .fn()
    .mockRejectedValueOnce('error sending request for url (https://private.invalid)')
  const install = vi.fn().mockResolvedValue(undefined)
  const update = { download, install } as unknown as AvailableUpdate

  await expect(downloadAppUpdate(update, () => {})).rejects.toThrow('更新包下载失败')
  expect(relaunch).not.toHaveBeenCalled()
  vi.mocked(relaunch).mockRejectedValue('private restart diagnostic')
  await expect(installAppUpdate(update)).rejects.toThrow('更新已安装，但无法自动重启')
})

it('classifies a generic download failure without exposing its details', async () => {
  const download = vi.fn().mockRejectedValue('request failed with status: 403')
  await expect(
    downloadAppUpdate({ download } as unknown as AvailableUpdate, () => {}),
  ).rejects.toThrow('更新包下载失败')
})
