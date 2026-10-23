import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncStatus } from '@/lib/platform/native-transfer'
import {
  canImportReceived,
  exportPasswordError,
  observeTransferRecovery,
  selectionError,
  toggleSelection,
  watchSyncStatus,
  withDeadline,
} from './transfer-state'

afterEach(() => vi.useRealTimers())

describe('window snapshot selection', () => {
  it('selects only supplied visible ids and preserves selections hidden by filters', () => {
    const original = new Set(['hidden', 'a'])
    const selected = toggleSelection(original, ['a', 'b'], true)
    expect([...selected]).toEqual(['hidden', 'a', 'b'])
    expect([...toggleSelection(selected, ['a', 'b'], false)]).toEqual(['hidden'])
    expect([...original]).toEqual(['hidden', 'a'])
  })

  it('blocks a stale selection if a selected window has started or is busy', () => {
    expect(selectionError([])).toContain('选择')
    expect(selectionError([{ id: 'a', running: true }])).toContain('关闭')
    expect(selectionError([{ id: 'a', running: false }], new Set(['a']))).toContain(
      '操作',
    )
    expect(selectionError([{ id: 'a', running: false }])).toBeNull()
  })

  it('requires an eight character password and exact confirmation', () => {
    expect(exportPasswordError('short', 'short')).toContain('8')
    expect(exportPasswordError('password', 'different')).toContain('一致')
    expect(exportPasswordError(' password ', 'password')).toContain('一致')
    expect(exportPasswordError('密码密码密码密码', '密码密码密码密码')).toBeNull()
  })
})

describe('sync lifecycle', () => {
  it('requires a received completed snapshot and a separate import', () => {
    expect(
      canImportReceived('receive', { state: 'completed', bytes: 100, total: 100 }, false),
    ).toBe(true)
    expect(
      canImportReceived('send', { state: 'completed', bytes: 100, total: 100 }, false),
    ).toBe(false)
    expect(
      canImportReceived(
        'receive',
        { state: 'transferring', bytes: 100, total: 100 },
        false,
      ),
    ).toBe(false)
    expect(
      canImportReceived('receive', { state: 'completed', bytes: 100, total: 100 }, true),
    ).toBe(false)
  })

  it('does not import after an acknowledged cancellation races with completion', () => {
    expect(
      canImportReceived(
        'receive',
        { state: 'completed', bytes: 100, total: 100 },
        false,
        true,
      ),
    ).toBe(false)
  })

  it('stops polling on completion and never treats transfer bytes as an import report', async () => {
    vi.useFakeTimers()
    const statuses: SyncStatus[] = []
    let reads = 0
    const stop = watchSyncStatus(
      async () => {
        reads += 1
        return {
          state: reads === 1 ? 'transferring' : 'completed',
          bytes: reads * 50,
          total: 100,
        }
      },
      (status) => statuses.push(status),
      (cause) => {
        throw cause
      },
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads).toBe(2)
    expect(statuses.map((status) => status.state)).toEqual(['transferring', 'completed'])
    stop()
  })

  it('ignores late results on cleanup without cancelling a native job', async () => {
    vi.useFakeTimers()
    let finish!: (status: SyncStatus) => void
    const statuses: SyncStatus[] = []
    const failures: unknown[] = []
    const stop = watchSyncStatus(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      (status) => statuses.push(status),
      (cause) => failures.push(cause),
    )
    stop()
    finish({ state: 'completed', bytes: 1, total: 1 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(statuses).toEqual([])
    expect(failures).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds stalled status requests and stops instead of piling up more polls', async () => {
    vi.useFakeTimers()
    let reads = 0
    const failures: unknown[] = []
    const stop = watchSyncStatus(
      () => {
        reads += 1
        return new Promise(() => undefined)
      },
      () => {
        throw new Error('No status should be invented')
      },
      (cause) => failures.push(cause),
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reads).toBe(1)
    expect(failures).toHaveLength(1)
    expect(String(failures[0])).toContain('超时')
    stop()
  })

  it('does not publish a late completion after progress reading timed out', async () => {
    vi.useFakeTimers()
    let finish!: (status: SyncStatus) => void
    const statuses: SyncStatus[] = []
    const failures: unknown[] = []
    const stop = watchSyncStatus(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      (status) => statuses.push(status),
      (cause) => failures.push(cause),
    )
    await vi.advanceTimersByTimeAsync(10_000)
    finish({ state: 'completed', bytes: 100, total: 100 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(failures).toHaveLength(1)
    expect(statuses).toEqual([])
    stop()
  })

  it.each(['failed', 'cancelled'] as const)('stops after native %s', async (state) => {
    vi.useFakeTimers()
    let reads = 0
    watchSyncStatus(
      async () => {
        reads += 1
        return { state, bytes: 0, total: 100 }
      },
      () => undefined,
      () => undefined,
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reads).toBe(1)
  })
})

describe('bounded UI waiting', () => {
  it('reports unconfirmed results without claiming to cancel the underlying operation', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const native = new Promise<string>((resolve) => {
      finish = resolve
    })
    const waiting = withDeadline(native, 100, '等待超时；后台请求仍可能继续。')
    const failed = expect(waiting).rejects.toThrow('后台请求仍可能继续')
    await vi.advanceTimersByTimeAsync(100)
    await failed
    finish('completed later')
    await expect(native).resolves.toBe('completed later')
  })

  it('clears a deadline when a real result arrives', async () => {
    vi.useFakeTimers()
    await expect(withDeadline(Promise.resolve('actual'), 100, '超时')).resolves.toBe(
      'actual',
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('transfer recovery observation', () => {
  it('reads once without polling or waiting for pending plugin recovery to finish', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => ({ pending: 2, warnings: ['studio.proxy-pool'] }))
    const onStatus = vi.fn()
    const onError = vi.fn()
    const stop = observeTransferRecovery(read, onStatus, onError)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledExactlyOnceWith({
      pending: 2,
      warnings: ['studio.proxy-pool'],
    })
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('bounds a stalled read and ignores late results without inventing a recovery outcome', async () => {
    vi.useFakeTimers()
    let finish!: (status: { pending: number; warnings: string[] }) => void
    const onStatus = vi.fn()
    const onError = vi.fn()
    const stop = observeTransferRecovery(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      onStatus,
      onError,
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining('超时') }),
    )
    finish({ pending: 0, warnings: [] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onStatus).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stops observation on cleanup without claiming to cancel native recovery', async () => {
    vi.useFakeTimers()
    let finish!: (status: { pending: number; warnings: string[] }) => void
    const onStatus = vi.fn()
    const onError = vi.fn()
    const stop = observeTransferRecovery(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      onStatus,
      onError,
    )
    stop()
    finish({ pending: 1, warnings: ['仍待恢复'] })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onStatus).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows an explicit later read to clear previously pending warnings', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ pending: 1, warnings: ['仍待恢复'] })
      .mockResolvedValueOnce({ pending: 0, warnings: [] })
    const onStatus = vi.fn()
    const onError = vi.fn()
    const stopFirst = observeTransferRecovery(read, onStatus, onError)
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(1))
    stopFirst()
    const stopRetry = observeTransferRecovery(read, onStatus, onError)
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(2))
    expect(onStatus).toHaveBeenLastCalledWith({ pending: 0, warnings: [] })
    expect(onError).not.toHaveBeenCalled()
    stopRetry()
  })
})
