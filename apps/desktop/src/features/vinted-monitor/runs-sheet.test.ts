import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchRunHistory } from './runs-sheet'
import type { RunList } from './types'

const empty: RunList = { items: [], total: 0, page: 0, pageSize: 20 }

function observer() {
  return { pending: vi.fn(), success: vi.fn(), error: vi.fn() }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('run history subscription', () => {
  it('uses zero-based pagination and keeps polling an empty history for scheduled work', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValue(empty)
    const events = observer()
    const stop = watchRunHistory('monitor-a', { page: 0, pageSize: 20 }, events, fetch)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledWith('monitor-a', { page: 0, pageSize: 20 })
    expect(events.success).toHaveBeenCalledWith(empty)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(15000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('recovers from a failed request without losing future polls', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(empty)
    const events = observer()
    const stop = watchRunHistory('monitor-a', { page: 2, pageSize: 10 }, events, fetch)
    await vi.advanceTimersByTimeAsync(0)
    expect(events.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'offline' }),
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(events.success).toHaveBeenCalledWith(empty)
    expect(fetch).toHaveBeenLastCalledWith('monitor-a', { page: 2, pageSize: 10 })
    stop()
  })

  it('does not overlap slow requests and ignores results after changing page', async () => {
    vi.useFakeTimers()
    let resolve!: (value: RunList) => void
    const delayed = new Promise<RunList>((done) => {
      resolve = done
    })
    const fetch = vi.fn().mockReturnValue(delayed)
    const oldEvents = observer()
    const stopOld = watchRunHistory(
      'monitor-a',
      { page: 0, pageSize: 20 },
      oldEvents,
      fetch,
    )
    await vi.advanceTimersByTimeAsync(20000)
    expect(fetch).toHaveBeenCalledTimes(1)
    stopOld()

    const newEvents = observer()
    const nextFetch = vi.fn().mockResolvedValue({ ...empty, page: 1 })
    const stopNew = watchRunHistory(
      'monitor-a',
      { page: 1, pageSize: 20 },
      newEvents,
      nextFetch,
    )
    await vi.advanceTimersByTimeAsync(0)
    resolve(empty)
    await vi.advanceTimersByTimeAsync(0)
    expect(oldEvents.success).not.toHaveBeenCalled()
    expect(newEvents.success).toHaveBeenCalledWith({ ...empty, page: 1 })
    stopNew()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(nextFetch).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale rejection after the sheet closes', async () => {
    vi.useFakeTimers()
    let reject!: (cause: unknown) => void
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise<RunList>((_, fail) => {
          reject = fail
        }),
    )
    const events = observer()
    const stop = watchRunHistory('monitor-a', { page: 0, pageSize: 50 }, events, fetch)
    await vi.advanceTimersByTimeAsync(0)
    stop()
    reject(new Error('late error'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(events.error).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('can be closed before its first request starts', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValue(empty)
    const events = observer()
    const stop = watchRunHistory('monitor-a', { page: 0, pageSize: 20 }, events, fetch)
    stop()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetch).not.toHaveBeenCalled()
    expect(events.pending).not.toHaveBeenCalled()
  })
})
