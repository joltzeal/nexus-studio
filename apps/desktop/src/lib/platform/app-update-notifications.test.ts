import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearToasts, toast, toastSnapshot } from '@/components/ui/toast'
import {
  AppUpdateError,
  checkAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  updatesAvailable,
  type AvailableUpdate,
} from './app-updates'
import { createAppUpdateController } from './app-update-controller'
import {
  startAppUpdateNotifications,
  UPDATE_CHECK_DELAY,
  UPDATE_CHECK_INTERVAL,
} from './app-update-notifications'

vi.mock('./app-updates', async (original) => ({
  ...(await original<typeof import('./app-updates')>()),
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
  updatesAvailable: vi.fn(),
}))

let stop: (() => void) | undefined
let controller: ReturnType<typeof createAppUpdateController>

function update(version = '0.1.6') {
  return {
    version,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AvailableUpdate
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.mocked(updatesAvailable).mockReturnValue(true)
  vi.mocked(checkAppUpdate).mockResolvedValue(null)
  vi.mocked(downloadAppUpdate).mockResolvedValue(undefined)
  vi.mocked(installAppUpdate).mockResolvedValue(undefined)
  controller = createAppUpdateController()
})

afterEach(() => {
  stop?.()
  stop = undefined
  controller.dispose()
  clearToasts()
  vi.useRealTimers()
})

it('downloads quietly after startup and offers installation only after verification resolves', async () => {
  let finish!: () => void
  const available = update()
  vi.mocked(checkAppUpdate).mockResolvedValue(available)
  vi.mocked(downloadAppUpdate).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  stop = startAppUpdateNotifications(controller)
  expect(checkAppUpdate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  expect(downloadAppUpdate).toHaveBeenCalledOnce()
  expect(toastSnapshot()).toHaveLength(0)
  expect(installAppUpdate).not.toHaveBeenCalled()
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(toastSnapshot()).toMatchObject([
    { message: expect.stringContaining('0.1.6'), action: { label: '立即更新' } },
  ])
  expect(available.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(toastSnapshot()).toHaveLength(1)
  expect(downloadAppUpdate).toHaveBeenCalledOnce()
  toastSnapshot()[0]?.action?.onClick()
  await vi.advanceTimersByTimeAsync(0)
  expect(installAppUpdate).toHaveBeenCalledExactlyOnceWith(available)
  expect(toastSnapshot()).toHaveLength(0)
  expect(available.close).toHaveBeenCalledOnce()
})

it('does not poll or notify from a web preview or development build', async () => {
  vi.mocked(updatesAvailable).mockReturnValue(false)
  stop = startAppUpdateNotifications(controller)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(checkAppUpdate).not.toHaveBeenCalled()
  expect(toastSnapshot()).toHaveLength(0)
})

it('keeps background check and download failures quiet and retries at the next interval', async () => {
  vi.mocked(checkAppUpdate).mockRejectedValueOnce(new AppUpdateError('network'))
  stop = startAppUpdateNotifications(controller)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  expect(toastSnapshot()).toHaveLength(0)
  const failed = update()
  vi.mocked(checkAppUpdate).mockResolvedValueOnce(failed)
  vi.mocked(downloadAppUpdate).mockRejectedValueOnce(new AppUpdateError('signature'))
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(toastSnapshot()).toHaveLength(0)
  expect(failed.close).toHaveBeenCalledOnce()
  vi.mocked(checkAppUpdate).mockResolvedValueOnce(update())
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(toastSnapshot()).toHaveLength(1)
})

it('does not announce that the app is up to date during background checks', async () => {
  stop = startAppUpdateNotifications(controller)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  expect(checkAppUpdate).toHaveBeenCalledTimes(1)
  expect(toastSnapshot()).toHaveLength(0)
})

it('cancels scheduled checks and releases a late result without downloading or notifying', async () => {
  let resolve!: (value: AvailableUpdate) => void
  vi.mocked(checkAppUpdate).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  stop = startAppUpdateNotifications(controller)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  stop()
  const late = update()
  resolve(late)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 2)
  expect(late.close).toHaveBeenCalledTimes(1)
  expect(checkAppUpdate).toHaveBeenCalledTimes(1)
  expect(downloadAppUpdate).not.toHaveBeenCalled()
  expect(toastSnapshot()).toHaveLength(0)
})

it('never overlaps background requests or a download already started from the about page', async () => {
  vi.mocked(checkAppUpdate).mockResolvedValue(update())
  vi.mocked(downloadAppUpdate).mockImplementation(() => new Promise(() => {}))
  stop = startAppUpdateNotifications(controller)
  void controller.prepare()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY + UPDATE_CHECK_INTERVAL * 2)
  expect(checkAppUpdate).toHaveBeenCalledTimes(1)
  expect(downloadAppUpdate).toHaveBeenCalledTimes(1)
  expect(toastSnapshot()).toHaveLength(0)
})

it('keeps the update action usable after running windows block installation', async () => {
  vi.mocked(checkAppUpdate).mockResolvedValue(update())
  vi.mocked(installAppUpdate).mockRejectedValueOnce(new AppUpdateError('running_windows'))
  stop = startAppUpdateNotifications(controller)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  toastSnapshot()[0]?.action?.onClick()
  await vi.advanceTimersByTimeAsync(0)
  expect(
    toastSnapshot().some((item) => item.message.includes('先停止所有运行中的窗口')),
  ).toBe(true)
  const retry = toastSnapshot().find((item) => item.action)
  expect(retry?.action?.label).toBe('立即更新')
  retry?.action?.onClick()
  await vi.advanceTimersByTimeAsync(0)
  expect(installAppUpdate).toHaveBeenCalledTimes(2)
  expect(downloadAppUpdate).toHaveBeenCalledOnce()
})

it('removes the notice and closes retained bytes when the app stops', async () => {
  const available = update()
  vi.mocked(checkAppUpdate).mockResolvedValue(available)
  stop = startAppUpdateNotifications(controller)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  const staleAction = toastSnapshot()[0]?.action
  stop()
  staleAction?.onClick()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(available.close).toHaveBeenCalledOnce()
  expect(toastSnapshot()).toHaveLength(0)
  expect(installAppUpdate).not.toHaveBeenCalled()
})

it('keeps the downloaded update actionable after ordinary notifications overflow', async () => {
  const available = update()
  vi.mocked(checkAppUpdate).mockResolvedValue(available)
  stop = startAppUpdateNotifications(controller)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  toast.success('Opened fixture window one')
  toast.success('Opened fixture window two')
  toast.success('Copied fixture')
  await vi.advanceTimersByTimeAsync(6000)

  const notice = toastSnapshot().find((item) => item.action)
  expect(notice?.action?.label).toBe('立即更新')
  expect(installAppUpdate).not.toHaveBeenCalled()
  notice?.action?.onClick()
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.getSnapshot().phase).toBe('installed')
  expect(installAppUpdate).toHaveBeenCalledExactlyOnceWith(available)
  expect(downloadAppUpdate).toHaveBeenCalledOnce()
})
