import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordSession } from './record-session'
import { makeSceneRecord } from './scene-plan.test-data'
import type { GenerationRecord } from './types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup() {
  const get = vi.fn<(id: string) => Promise<{ record: GenerationRecord }>>()
  const session = new RecordSession(get)
  const callbacks = {
    onRecord: vi.fn<(record: GenerationRecord) => void>(),
    onError: vi.fn<(error: string) => void>(),
    onSettled: vi.fn<() => void>(),
  }
  return { get, session, callbacks }
}

const activeRecord = (): GenerationRecord => ({
  ...makeSceneRecord(),
  status: 'running',
  stage: 'image',
  error: null,
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('record detail read lifecycle', () => {
  it('polls sequentially and notifies the parent once when generation settles', async () => {
    const { get, session, callbacks } = setup()
    const pending = deferred<{ record: GenerationRecord }>()
    get
      .mockResolvedValueOnce({ record: activeRecord() })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ record: makeSceneRecord() })
    await session.open('record', callbacks)
    await vi.advanceTimersByTimeAsync(2500)
    expect(get).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(get).toHaveBeenCalledTimes(2)
    pending.resolve({ record: activeRecord() })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2499)
    expect(get).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(get).toHaveBeenCalledTimes(3)
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1)
    expect(callbacks.onRecord.mock.calls.map(([record]) => record.status)).toEqual([
      'running',
      'running',
      'failed',
    ])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(get).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an old failed GET after retry returns running and continues polling the retried job', async () => {
    const { get, session, callbacks } = setup()
    const stale = deferred<{ record: GenerationRecord }>()
    get
      .mockResolvedValueOnce({ record: makeSceneRecord() })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ record: activeRecord() })
    await session.open('record', callbacks)
    const reading = session.refresh()
    const retry = session.beginAction()
    expect(session.accept(retry, activeRecord())).toBe(true)
    session.resume(retry)
    stale.resolve({ record: makeSceneRecord() })
    await reading
    expect(callbacks.onRecord.mock.calls.map(([record]) => record.status)).toEqual([
      'failed',
      'running',
    ])
    await vi.advanceTimersByTimeAsync(2500)
    expect(get).toHaveBeenCalledTimes(3)
    expect(callbacks.onRecord.mock.calls.map(([record]) => record.status)).toEqual([
      'failed',
      'running',
      'running',
    ])
    expect(callbacks.onSettled).not.toHaveBeenCalled()
  })

  it('does not let a superseded read error replace the action result or schedule another poll', async () => {
    const { get, session, callbacks } = setup()
    const stale = deferred<{ record: GenerationRecord }>()
    get
      .mockResolvedValueOnce({ record: makeSceneRecord() })
      .mockReturnValueOnce(stale.promise)
    await session.open('record', callbacks)
    const reading = session.refresh()
    const action = session.beginAction()
    session.accept(action, { ...makeSceneRecord(), status: 'success' })
    session.resume(action)
    stale.reject(new Error('Old transport failure'))
    await reading
    await vi.advanceTimersByTimeAsync(60_000)
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(2)
    expect(callbacks.onRecord.mock.calls.map(([record]) => record.status)).toEqual([
      'failed',
      'success',
    ])
  })

  it('keeps polling output recognition even when the original generation has finished', async () => {
    const { get, session, callbacks } = setup()
    const recognition: GenerationRecord = {
      ...makeSceneRecord(),
      status: 'success',
      outputVision: {
        providerId: 'vision-provider',
        providerName: 'Vision provider',
        providerKind: 'openai_compatible',
        model: 'vision-model',
        outputFileId: 'detail-output',
        status: 'running',
        description: null,
        error: null,
      },
    }
    get.mockResolvedValueOnce({ record: makeSceneRecord() }).mockResolvedValueOnce({
      record: {
        ...recognition,
        outputVision: {
          ...recognition.outputVision!,
          status: 'success',
          description: 'Visible wear',
        },
      },
    })
    await session.open('record', callbacks)
    const action = session.beginAction()
    session.accept(action, recognition)
    session.resume(action)
    await vi.advanceTimersByTimeAsync(2500)
    expect(get).toHaveBeenCalledTimes(2)
    expect(
      callbacks.onRecord.mock.calls[callbacks.onRecord.mock.calls.length - 1]?.[0]
        .outputVision?.description,
    ).toBe('Visible wear')
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a late initial read after close: %s',
    async (outcome) => {
      const { get, session, callbacks } = setup()
      const stale = deferred<{ record: GenerationRecord }>()
      get.mockReturnValue(stale.promise)
      const reading = session.open('record', callbacks)
      session.close()
      if (outcome === 'resolve') stale.resolve({ record: activeRecord() })
      else stale.reject(new Error('Late error'))
      await reading
      expect(callbacks.onRecord).not.toHaveBeenCalled()
      expect(callbacks.onError).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('ignores a previous record read and resets its polling when the ID changes', async () => {
    const { get, session, callbacks } = setup()
    const stale = deferred<{ record: GenerationRecord }>()
    get
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ record: { ...makeSceneRecord(), id: 'second' } })
    const first = session.open('record', callbacks)
    await session.open('second', callbacks)
    stale.resolve({ record: activeRecord() })
    await first
    expect(callbacks.onRecord.mock.calls.map(([record]) => record.id)).toEqual(['second'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates action results on close or a newer action, including deletion', async () => {
    const { get, session, callbacks } = setup()
    get.mockResolvedValue({ record: makeSceneRecord() })
    await session.open('record', callbacks)
    const retry = session.beginAction()
    const deletion = session.beginAction()
    expect(session.isCurrent(retry)).toBe(false)
    expect(session.accept(retry, activeRecord())).toBe(false)
    expect(session.isCurrent(deletion)).toBe(true)
    session.close()
    expect(session.isCurrent(deletion)).toBe(false)
    expect(session.accept(deletion, activeRecord())).toBe(false)
    session.resume(deletion)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(callbacks.onRecord).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('pauses pending polling during an action and resumes only after that action finishes', async () => {
    const { get, session, callbacks } = setup()
    get.mockResolvedValue({ record: activeRecord() })
    await session.open('record', callbacks)
    const action = session.beginAction()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(get).toHaveBeenCalledTimes(1)
    session.resume(action)
    await vi.advanceTimersByTimeAsync(2500)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('retains the active record through a read failure and retries only the read', async () => {
    const { get, session, callbacks } = setup()
    get
      .mockResolvedValueOnce({ record: activeRecord() })
      .mockRejectedValueOnce(new Error('Temporary transport failure'))
      .mockResolvedValueOnce({ record: makeSceneRecord() })
    await session.open('record', callbacks)
    await vi.advanceTimersByTimeAsync(2500)
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
      'Temporary transport failure',
    )
    expect(callbacks.onRecord).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2500)
    expect(callbacks.onRecord).toHaveBeenCalledTimes(2)
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a mismatched record ID without replacing visible data', async () => {
    const { get, session, callbacks } = setup()
    get.mockResolvedValue({ record: { ...makeSceneRecord(), id: 'wrong' } })
    await session.open('record', callbacks)
    expect(callbacks.onRecord).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
      '读取到其他生成记录，请重新读取。',
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})
