import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AppUpdateError,
  checkAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  type AvailableUpdate,
} from './app-updates'
import { createAppUpdateController } from './app-update-controller'

vi.mock('./app-updates', async (original) => ({
  ...(await original<typeof import('./app-updates')>()),
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function available() {
  return {
    version: '0.1.6',
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AvailableUpdate
}

let controller: ReturnType<typeof createAppUpdateController>

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(checkAppUpdate).mockResolvedValue(available())
  vi.mocked(downloadAppUpdate).mockResolvedValue(undefined)
  vi.mocked(installAppUpdate).mockResolvedValue(undefined)
  controller = createAppUpdateController()
})

afterEach(() => controller.dispose())

it('shares one download and retains the verified update across subscribers until installation', async () => {
  const verification = deferred<void>()
  const update = available()
  vi.mocked(checkAppUpdate).mockResolvedValue(update)
  vi.mocked(downloadAppUpdate).mockImplementation(async (_update, progress) => {
    progress(100, 100)
    await verification.promise
  })
  const subscriber = vi.fn()
  const unsubscribe = controller.subscribe(subscriber)
  const first = controller.prepare()
  expect(controller.prepare()).toBe(first)
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('downloading'))
  expect(controller.getSnapshot()).toMatchObject({ downloaded: 100, total: 100 })
  expect(update.close).not.toHaveBeenCalled()
  expect(installAppUpdate).not.toHaveBeenCalled()
  unsubscribe()
  verification.resolve()
  await first
  expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', version: '0.1.6' })
  expect(subscriber).toHaveBeenCalled()
  await controller.prepare()
  expect(checkAppUpdate).toHaveBeenCalledOnce()
  expect(downloadAppUpdate).toHaveBeenCalledOnce()
  expect(update.close).not.toHaveBeenCalled()
  await controller.install()
  expect(installAppUpdate).toHaveBeenCalledExactlyOnceWith(update)
  expect(controller.getSnapshot().phase).toBe('installed')
  expect(update.close).toHaveBeenCalledOnce()
})

it('does not install before a verified download has completed', async () => {
  await expect(controller.install()).rejects.toThrow('尚未准备完成')
  expect(installAppUpdate).not.toHaveBeenCalled()
})

it('discards failed downloads and checks again before retrying', async () => {
  const failed = available()
  vi.mocked(checkAppUpdate).mockResolvedValueOnce(failed)
  vi.mocked(downloadAppUpdate).mockRejectedValueOnce(new AppUpdateError('signature'))
  await expect(controller.prepare()).rejects.toThrow('签名验证失败')
  expect(controller.getSnapshot().phase).toBe('error')
  expect(failed.close).toHaveBeenCalledOnce()
  await controller.prepare()
  expect(controller.getSnapshot().phase).toBe('ready')
  expect(checkAppUpdate).toHaveBeenCalledTimes(2)
  expect(installAppUpdate).not.toHaveBeenCalled()
})

it('retains downloaded bytes when running windows prevent installation, then retries without downloading', async () => {
  const update = available()
  vi.mocked(checkAppUpdate).mockResolvedValue(update)
  vi.mocked(installAppUpdate).mockRejectedValueOnce(new AppUpdateError('running_windows'))
  await controller.prepare()
  await expect(controller.install()).rejects.toThrow('先停止所有运行中的窗口')
  expect(controller.getSnapshot()).toMatchObject({
    phase: 'ready',
    error: { code: 'running_windows' },
  })
  expect(update.close).not.toHaveBeenCalled()
  await controller.install()
  expect(downloadAppUpdate).toHaveBeenCalledOnce()
  expect(installAppUpdate).toHaveBeenCalledTimes(2)
  expect(update.close).toHaveBeenCalledOnce()
})

it('never starts two installers from repeated actions', async () => {
  const installation = deferred<void>()
  vi.mocked(installAppUpdate).mockReturnValue(installation.promise)
  await controller.prepare()
  const first = controller.install()
  expect(controller.install()).toBe(first)
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('installing'))
  expect(installAppUpdate).toHaveBeenCalledOnce()
  installation.resolve()
  await first
})

it('does not reinstall a successful update when restarting failed', async () => {
  vi.mocked(installAppUpdate).mockRejectedValueOnce(new AppUpdateError('relaunch_failed'))
  await controller.prepare()
  await expect(controller.install()).rejects.toThrow('无法自动重启')
  expect(controller.getSnapshot()).toMatchObject({
    phase: 'installed',
    error: { code: 'relaunch_failed' },
  })
  await controller.prepare()
  await expect(controller.install()).rejects.toThrow('尚未准备完成')
  expect(installAppUpdate).toHaveBeenCalledOnce()
  expect(downloadAppUpdate).toHaveBeenCalledOnce()
})

it('closes a late check result without downloading after the app stops', async () => {
  const checking = deferred<AvailableUpdate>()
  vi.mocked(checkAppUpdate).mockReturnValue(checking.promise)
  const request = controller.prepare()
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('checking'))
  controller.dispose()
  const update = available()
  checking.resolve(update)
  await request
  expect(update.close).toHaveBeenCalledOnce()
  expect(downloadAppUpdate).not.toHaveBeenCalled()
  expect(controller.getSnapshot().phase).toBe('idle')
})

it('releases a late download without replacing a subsequent session state', async () => {
  const download = deferred<void>()
  const old = available()
  vi.mocked(checkAppUpdate).mockResolvedValueOnce(old).mockResolvedValueOnce(null)
  vi.mocked(downloadAppUpdate).mockReturnValueOnce(download.promise)
  const request = controller.prepare()
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('downloading'))
  controller.dispose()
  await controller.prepare()
  download.resolve()
  await request
  expect(controller.getSnapshot().phase).toBe('up-to-date')
  expect(old.close).toHaveBeenCalledOnce()
})

it('releases prepared resources when the app stops', async () => {
  const update = available()
  vi.mocked(checkAppUpdate).mockResolvedValue(update)
  await controller.prepare()
  controller.dispose()
  expect(update.close).toHaveBeenCalledOnce()
  expect(controller.getSnapshot().phase).toBe('idle')
})
