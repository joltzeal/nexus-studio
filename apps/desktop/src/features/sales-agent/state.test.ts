import type { DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deferred,
  flushPromises,
  KernelHookHarness,
} from '@/features/settings/kernel-test-support'
import {
  appendEvents,
  batchLabel,
  controlReason,
  emptyEventStream,
  type EventStream,
} from './state'
import { AgentEvents } from './batch-runs'
import { getAgentEvents } from './api'
import { useAgentQuery } from './use-query'
import { batch, ids, job, now } from './test-data'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  getAgentEvents: vi.fn(),
}))

describe('attention and recovery states', () => {
  it.each([
    'result_unknown',
    'sync_pending',
    'blocked',
    'review_required',
    'failed',
  ] as const)('never reports completion or enables resume for %s', (state) => {
    const completed = { ...batch, state: 'completed' as const, completed: 1 }
    const jobs = [{ ...job, state }]
    expect(batchLabel(completed, jobs)).toBe('需要处理')
    expect(controlReason({ ...batch, state: 'paused' }, jobs, 'resume')).toContain('核对')
    expect(controlReason(completed, jobs, 'reconcile')).toBeNull()
  })

  it('uses batch attention even when the affected job is on a different page', () => {
    const current = { ...batch, state: 'completed' as const, attention: 1 }
    expect(batchLabel(current, [])).toBe('需要处理')
    expect(controlReason(current, [], 'resume')).toContain('核对')
  })

  it.each([
    'blocked',
    'result_unknown',
    'sync_pending',
    'review_required',
    'failed',
  ] as const)('allows a healthy paused sibling to resume while retaining %s', (state) => {
    const current = {
      ...batch,
      state: 'needs_attention' as const,
      total: 2,
      attention: 1,
    }
    const jobs = [
      { ...job, state },
      { ...job, id: ids.otherWindow, state: 'paused' as const },
    ]
    const before = structuredClone(jobs)
    expect(controlReason(current, jobs, 'resume')).toBeNull()
    expect(batchLabel(current, jobs)).toBe('需要处理')
    expect(jobs).toEqual(before)
  })

  it('permits resume when a healthy sibling is outside the current page', () => {
    const current = {
      ...batch,
      state: 'needs_attention' as const,
      total: 21,
      attention: 20,
    }
    const page = Array.from({ length: 20 }, (_, index) => ({
      ...job,
      id: `blocked-${index}`,
      state: 'blocked' as const,
    }))
    expect(controlReason(current, page, 'resume')).toBeNull()
    expect(controlReason({ ...current, total: 20 }, page, 'resume')).toContain('核对')
  })

  it('does not resume paused remnants of an ended batch', () => {
    const jobs = [{ ...job, state: 'paused' as const }]
    expect(controlReason({ ...batch, state: 'completed' }, jobs, 'resume')).not.toBeNull()
    expect(controlReason({ ...batch, state: 'cancelled' }, jobs, 'resume')).not.toBeNull()
  })

  it('permits a clean paused batch to resume and preserves reconcile after cancellation', () => {
    expect(controlReason({ ...batch, state: 'paused' }, [job], 'resume')).toBeNull()
    expect(controlReason(batch, [job], 'resume')).toContain('已暂停')
    expect(controlReason({ ...batch, state: 'cancelled' }, [], 'reconcile')).toBeNull()
  })

  it('keeps monotone cursors and deduplicates bounded event history', () => {
    const events = Array.from({ length: 600 }, (_, index) => ({
      sequence: index + 1,
      batchId: ids.batch,
      jobId: ids.job,
      kind: 'phase',
      message: `Step ${index}`,
      createdAt: now,
    }))
    const initial = appendEvents(emptyEventStream(), {
      items: events.slice(0, 500),
      cursor: 500,
      hasMore: true,
    })
    const next = appendEvents(initial, {
      items: events.slice(490),
      cursor: 600,
      hasMore: false,
    })
    expect(next.items).toHaveLength(500)
    expect(next.items[0]?.sequence).toBe(101)
    expect(next.cursor).toBe(600)
    expect(appendEvents(next, { items: [], cursor: 1, hasMore: false })).toBe(next)
  })
})

describe('pause controls with mixed job states', () => {
  it.each([
    'blocked',
    'result_unknown',
    'sync_pending',
    'review_required',
    'failed',
  ] as const)('allows a healthy queued sibling to pause beside %s', (state) => {
    const current = {
      ...batch,
      state: 'needs_attention' as const,
      total: 2,
      attention: 1,
    }
    const jobs = [
      { ...job, state },
      { ...job, id: ids.otherWindow, state: 'queued' as const },
    ]
    const before = structuredClone(jobs)
    expect(controlReason(current, jobs, 'pause')).toBeNull()
    expect(batchLabel(current, jobs)).toBe('需要处理')
    expect(jobs).toEqual(before)
  })

  it('permits pause when the healthy queued sibling is outside the current page', () => {
    const jobs = [
      ...Array.from({ length: 20 }, (_, index) => ({
        ...job,
        id: `blocked-${index}`,
        state: 'blocked' as const,
      })),
      { ...job, id: ids.otherWindow, state: 'queued' as const },
    ]
    const current = {
      ...batch,
      state: 'needs_attention' as const,
      total: jobs.length,
      attention: 20,
    }
    expect(controlReason(current, jobs.slice(0, 20), 'pause')).toBeNull()
    expect(
      controlReason({ ...current, total: 20 }, jobs.slice(0, 10), 'pause'),
    ).not.toBeNull()
    expect(
      controlReason({ ...current, completed: 1 }, jobs.slice(0, 20), 'pause'),
    ).not.toBeNull()
  })

  it.each(['paused', 'cancelled'] as const)(
    'does not pause when the only healthy sibling is already %s',
    (state) => {
      const current = {
        ...batch,
        state: 'needs_attention' as const,
        total: 2,
        attention: 1,
      }
      const inactive = { ...job, id: ids.otherWindow, state }
      expect(
        controlReason(current, [{ ...job, state: 'blocked' }, inactive], 'pause'),
      ).not.toBeNull()
      expect(controlReason(current, [inactive], 'pause')).not.toBeNull()
    },
  )

  it.each(['completed', 'cancelled', 'paused'] as const)(
    'keeps pause disabled for a %s batch even with stale queued jobs',
    (state) => {
      expect(controlReason({ ...batch, state }, [job], 'pause')).not.toBeNull()
    },
  )

  it.each(['queued', 'running'] as const)(
    'still allows a %s batch to pause without loading its jobs',
    (state) => {
      expect(controlReason({ ...batch, state }, [], 'pause')).toBeNull()
    },
  )
})

describe('query response ordering and read-only polling', () => {
  let hooks: KernelHookHarness
  beforeEach(() => {
    vi.useFakeTimers()
    hooks = new KernelHookHarness(state)
  })
  afterEach(() => {
    hooks.dispose()
    vi.useRealTimers()
  })

  it('ignores stale success and failure after filters change and stops polling on unmount', async () => {
    const old = deferred<number>()
    const loadOld = vi.fn(() => old.promise)
    const loadNew = vi.fn(async () => 2)
    hooks.render(() => useAgentQuery('old-page', loadOld, 2500))
    hooks.flushEffects()
    hooks.render(() => useAgentQuery('new-page', loadNew, 2500))
    hooks.flushEffects()
    await flushPromises()
    old.reject(new Error('Late old failure'))
    await flushPromises()
    let result = hooks.render(() => useAgentQuery('new-page', loadNew, 2500))
    expect(result).toMatchObject({ data: 2, error: null, loading: false })
    await vi.advanceTimersByTimeAsync(2500)
    expect(loadNew).toHaveBeenCalledTimes(2)
    hooks.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(loadNew).toHaveBeenCalledTimes(2)
    result = hooks.render(() => useAgentQuery('new-page', loadNew, 2500))
    expect(result.error).toBeNull()
  })

  it('does not overlap slow status reads or advance backend state with a timer', async () => {
    const response = deferred<number>()
    const load = vi.fn(() => response.promise)
    hooks.render(() => useAgentQuery('batch', load, 2500))
    hooks.flushEffects()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(1)
    response.resolve(1)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2500)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps prior data visibly marked by an error when a polling read fails', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(42)
      .mockRejectedValueOnce(new Error('Transport failed'))
    hooks.render(() => useAgentQuery<number>('batch', load, 2500))
    hooks.flushEffects()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2500)
    const result = hooks.render(() => useAgentQuery<number>('batch', load, 2500))
    expect(result).toMatchObject({ data: 42, error: 'Transport failed' })
  })
})

describe('event cursor recovery', () => {
  let hooks: KernelHookHarness
  let cache: Map<string, EventStream>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(getAgentEvents).mockReset()
    hooks = new KernelHookHarness(state)
    cache = new Map()
  })
  afterEach(() => {
    hooks.dispose()
    vi.useRealTimers()
  })
  const event = {
    sequence: 8,
    batchId: ids.batch,
    jobId: ids.job,
    kind: 'result_unknown',
    message: 'Verify once',
    createdAt: now,
  }

  it('continues from a saved cursor across reopen and after an event read failure', async () => {
    cache.set(ids.batch, { cursor: 7, items: [], hasMore: false })
    vi.mocked(getAgentEvents)
      .mockResolvedValueOnce({ items: [event], cursor: 8, hasMore: false })
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue({ items: [], cursor: 8, hasMore: false })
    hooks.render(() => AgentEvents({ id: ids.batch, cache, revision: 0 }))
    hooks.flushEffects()
    await flushPromises()
    expect(getAgentEvents).toHaveBeenLastCalledWith(ids.batch, 7)
    await vi.advanceTimersByTimeAsync(2500)
    expect(cache.get(ids.batch)?.cursor).toBe(8)
    await vi.advanceTimersByTimeAsync(5000)
    expect(getAgentEvents).toHaveBeenLastCalledWith(ids.batch, 8)
    hooks.dispose()
    hooks = new KernelHookHarness(state)
    hooks.render(() => AgentEvents({ id: ids.batch, cache, revision: 0 }))
    hooks.flushEffects()
    await flushPromises()
    expect(getAgentEvents).toHaveBeenLastCalledWith(ids.batch, 8)
    expect(cache.get(ids.batch)?.items).toEqual([event])
  })

  it('ignores a late event response after changing batch and restores the other cursor', async () => {
    const old = deferred<Awaited<ReturnType<typeof getAgentEvents>>>()
    vi.mocked(getAgentEvents).mockReturnValueOnce(old.promise).mockResolvedValue({
      items: [],
      cursor: 12,
      hasMore: false,
    })
    hooks.render(() => AgentEvents({ id: ids.batch, cache, revision: 0 }))
    hooks.flushEffects()
    hooks.dispose()
    hooks = new KernelHookHarness(state)
    cache.set(ids.otherWindow, { cursor: 12, items: [], hasMore: false })
    hooks.render(() => AgentEvents({ id: ids.otherWindow, cache, revision: 0 }))
    hooks.flushEffects()
    await flushPromises()
    old.resolve({ items: [event], cursor: 8, hasMore: false })
    await flushPromises()
    expect(cache.has(ids.batch)).toBe(false)
    expect(getAgentEvents).toHaveBeenLastCalledWith(ids.otherWindow, 12)
    expect(cache.get(ids.otherWindow)?.cursor).toBe(12)
  })
})
