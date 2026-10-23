import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from '@/components/ui/toast'
import { checkAppUpdate, updatesAvailable, type AvailableUpdate } from './app-updates'
import {
  startAppUpdateNotifications,
  UPDATE_CHECK_DELAY,
  UPDATE_CHECK_INTERVAL,
} from './app-update-notifications'

vi.mock('./app-updates', () => ({
  checkAppUpdate: vi.fn(),
  updatesAvailable: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({ toast: { info: vi.fn() } }))

let stop: (() => void) | undefined

function update(version = '0.1.4') {
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
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
})

it('checks after startup and notifies once per version while releasing update resources', async () => {
  const available = update()
  vi.mocked(checkAppUpdate).mockResolvedValue(available)
  stop = startAppUpdateNotifications()
  expect(checkAppUpdate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  expect(toast.info).toHaveBeenCalledWith(
    expect.stringContaining('0.1.4'),
    expect.objectContaining({ duration: 12_000 }),
  )
  expect(available.close).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(toast.info).toHaveBeenCalledTimes(1)
  expect(available.close).toHaveBeenCalledTimes(2)
  const newer = update('0.1.5')
  vi.mocked(checkAppUpdate).mockResolvedValue(newer)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(toast.info).toHaveBeenCalledTimes(2)
  expect(newer.close).toHaveBeenCalledTimes(1)
})

it('does not poll or notify from a web preview or development build', async () => {
  vi.mocked(updatesAvailable).mockReturnValue(false)
  stop = startAppUpdateNotifications()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(checkAppUpdate).not.toHaveBeenCalled()
  expect(toast.info).not.toHaveBeenCalled()
})

it('keeps background failures quiet and retries at the next interval', async () => {
  vi.mocked(checkAppUpdate).mockRejectedValueOnce(new Error('offline'))
  stop = startAppUpdateNotifications()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  expect(toast.info).not.toHaveBeenCalled()
  vi.mocked(checkAppUpdate).mockResolvedValue(update())
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(toast.info).toHaveBeenCalledTimes(1)
})

it('does not announce that the app is up to date during background checks', async () => {
  stop = startAppUpdateNotifications()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  expect(checkAppUpdate).toHaveBeenCalledTimes(1)
  expect(toast.info).not.toHaveBeenCalled()
})

it('cancels scheduled checks and releases a late result without showing a toast', async () => {
  let resolve!: (value: AvailableUpdate) => void
  vi.mocked(checkAppUpdate).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  stop = startAppUpdateNotifications()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY)
  stop()
  const late = update()
  resolve(late)
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 2)
  expect(late.close).toHaveBeenCalledTimes(1)
  expect(checkAppUpdate).toHaveBeenCalledTimes(1)
  expect(toast.info).not.toHaveBeenCalled()
})

it('never overlaps background requests', async () => {
  vi.mocked(checkAppUpdate).mockImplementation(() => new Promise(() => {}))
  stop = startAppUpdateNotifications()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY + UPDATE_CHECK_INTERVAL * 2)
  expect(checkAppUpdate).toHaveBeenCalledTimes(1)
})
