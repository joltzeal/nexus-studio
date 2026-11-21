import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScenePlanSession, type ScenePlanState } from './scene-plan-session'
import type { ScenePlanInput } from './scene-plan'
import { makePlan, planContext } from './scene-plan.test-data'
import type { ScenePlan } from './types'

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
  const api = {
    create: vi.fn<(input: ScenePlanInput) => Promise<ScenePlan>>(),
    get: vi.fn<(id: string) => Promise<ScenePlan>>(),
  }
  const states: ScenePlanState[] = []
  const session = new ScenePlanSession(api)
  return {
    api,
    session,
    states,
    notify: (state: ScenePlanState) => {
      states.push(state)
    },
  }
}

const running = () => makePlan({ status: 'running', result: null })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('scene plan job lifecycle', () => {
  it('waits for each read before scheduling another and stops at success', async () => {
    const { api, session, states, notify } = setup()
    const firstRead = deferred<ScenePlan>()
    api.create.mockResolvedValue(running())
    api.get.mockReturnValueOnce(firstRead.promise).mockResolvedValueOnce(makePlan())
    await session.start(planContext, notify)
    expect(states.map((state) => state.status)).toEqual(['creating', 'running'])
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.get).toHaveBeenCalledExactlyOnceWith('scene-plan')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.get).toHaveBeenCalledTimes(1)
    firstRead.resolve(running())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1499)
    expect(api.get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(states.map((state) => state.status)).toEqual([
      'creating',
      'running',
      'running',
      'success',
    ])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a delayed create result after the dialog closes or its input changes', async () => {
    const { api, session, states, notify } = setup()
    const creation = deferred<ScenePlan>()
    const accepted = vi.fn()
    api.create.mockReturnValue(creation.promise)
    const task = session.start(planContext, notify, accepted)
    session.cancel()
    creation.resolve(makePlan())
    await task
    await vi.advanceTimersByTimeAsync(60_000)
    expect(states.map((state) => state.status)).toEqual(['creating'])
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('refreshes preferences once on acceptance, not on polling or read recovery', async () => {
    const { api, session, notify } = setup()
    const accepted = vi.fn()
    api.create.mockResolvedValue(running())
    api.get.mockResolvedValueOnce(running()).mockResolvedValueOnce(makePlan())
    await session.start(planContext, notify, accepted)
    await vi.advanceTimersByTimeAsync(3000)
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it('ignores a delayed read after cancellation and starts no further reads', async () => {
    const { api, session, states, notify } = setup()
    const read = deferred<ScenePlan>()
    api.create.mockResolvedValue(running())
    api.get.mockReturnValue(read.promise)
    await session.start(planContext, notify)
    await vi.advanceTimersByTimeAsync(1500)
    session.cancel()
    read.resolve(makePlan())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(states.map((state) => state.status)).toEqual(['creating', 'running'])
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not revive a canceled request when the user switches away and back to the same input', async () => {
    const { api, session, states, notify } = setup()
    const first = deferred<ScenePlan>()
    api.create
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(makePlan({ id: 'new-plan' }))
    const abandoned = session.start(planContext, notify)
    session.cancel()
    await session.start(planContext, notify)
    first.resolve(makePlan({ id: 'abandoned-plan' }))
    await abandoned
    expect(
      states.filter((state) => state.status === 'success').map((state) => state.plan?.id),
    ).toEqual(['new-plan'])
    expect(api.create).toHaveBeenCalledTimes(2)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('preserves the persisted job on a read error and resumes with reads only', async () => {
    const { api, session, states, notify } = setup()
    const plan = running()
    api.create.mockResolvedValue(plan)
    api.get
      .mockRejectedValueOnce(new Error('Plugin transport unavailable'))
      .mockResolvedValueOnce(makePlan())
    await session.start(planContext, notify)
    await vi.advanceTimersByTimeAsync(1500)
    expect(states[states.length - 1]).toEqual({
      status: 'read-error',
      plan,
      error: 'Plugin transport unavailable',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.get).toHaveBeenCalledTimes(1)
    session.resume(plan, notify)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(states[states.length - 1]?.status).toBe('success')
  })

  it('never retries a failed paid creation automatically', async () => {
    const { api, session, states, notify } = setup()
    const accepted = vi.fn()
    api.create.mockRejectedValue(new Error('Model rejected this input'))
    await session.start(planContext, notify, accepted)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(states[states.length - 1]).toEqual({
      status: 'failed',
      plan: null,
      error: 'Model rejected this input',
    })
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.get).not.toHaveBeenCalled()
    expect(accepted).not.toHaveBeenCalled()
  })

  it('stops polling a failed job without submitting another paid creation', async () => {
    const { api, session, states, notify } = setup()
    const failed = makePlan({
      status: 'failed',
      result: null,
      error: 'Unusable model response',
    })
    api.create.mockResolvedValue(running())
    api.get.mockResolvedValue(failed)
    await session.start(planContext, notify)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(states[states.length - 1]).toEqual({
      status: 'failed',
      plan: failed,
      error: failed.error,
    })
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a read for a different job and retains the right ID for manual read recovery', async () => {
    const { api, session, states, notify } = setup()
    const plan = running()
    api.create.mockResolvedValue(plan)
    api.get.mockResolvedValue(makePlan({ id: 'another-plan' }))
    await session.start(planContext, notify)
    await vi.advanceTimersByTimeAsync(1500)
    expect(states[states.length - 1]).toMatchObject({
      status: 'read-error',
      plan: { id: 'scene-plan' },
    })
    expect(states[states.length - 1]?.error).toContain('其他场景方案')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('validates the view count before creating a job', async () => {
    const { api, session, states, notify } = setup()
    await expect(session.start({ ...planContext, count: 5 }, notify)).rejects.toThrow(
      '1–4',
    )
    expect(api.create).not.toHaveBeenCalled()
    expect(states).toEqual([])
  })
})
