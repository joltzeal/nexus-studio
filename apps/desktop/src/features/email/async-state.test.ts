import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred, flushPromises } from '@/features/settings/kernel-test-support'
import { EmailResource } from './async-state'

afterEach(() => vi.useRealTimers())

describe('email request lifecycle', () => {
  it('serializes summary polling and skips manual/poll duplicates while an RPC is pending', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    let calls = 0
    const resource = new EmailResource(
      { page: 1 },
      async () => {
        calls += 1
        return pending.promise
      },
      '读取失败',
    )
    resource.start(5_000)
    resource.refresh()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls).toBe(1)
    pending.resolve('committed')
    await flushPromises()
    expect(resource.getSnapshot()).toMatchObject({
      value: 'committed',
      loading: false,
      error: null,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toBe(2)
    resource.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(2)
  })

  it('keeps committed data when a refresh fails and clears the visible error on recovery', async () => {
    let fail = false
    const resource = new EmailResource(
      1,
      async () => {
        if (fail) throw new Error('synthetic-secret')
        return 'committed'
      },
      '列表读取失败，请重试。',
    )
    resource.start()
    await flushPromises()
    fail = true
    resource.refresh()
    await flushPromises()
    expect(resource.getSnapshot()).toMatchObject({
      value: 'committed',
      loading: false,
      error: '列表读取失败，请重试。',
    })
    fail = false
    resource.refresh()
    await flushPromises()
    expect(resource.getSnapshot().error).toBeNull()
    resource.dispose()
  })

  it.each(['success', 'failure'])(
    'ignores obsolete page/filter %s and starts only the latest requested page',
    async (outcome) => {
      const old = deferred<string>()
      const latest = deferred<string>()
      const inputs: string[] = []
      const resource = new EmailResource(
        'account-1/inbox/page-1',
        async (input) => {
          inputs.push(input)
          return inputs.length === 1 ? old.promise : latest.promise
        },
        '读取失败',
      )
      resource.start()
      resource.select('account-1/junkemail/page-1')
      resource.select('account-2/inbox/page-2')
      expect(inputs).toEqual(['account-1/inbox/page-1'])
      if (outcome === 'success') old.resolve('old mail')
      else old.reject(new Error('old failure'))
      await flushPromises()
      expect(resource.getSnapshot()).toMatchObject({
        value: null,
        error: null,
        loading: true,
      })
      expect(inputs).toEqual(['account-1/inbox/page-1', 'account-2/inbox/page-2'])
      latest.resolve('new mail')
      await flushPromises()
      expect(resource.getSnapshot()).toMatchObject({ value: 'new mail', loading: false })
      resource.dispose()
    },
  )

  it.each(['success', 'failure'])(
    'ignores a late %s after reader-close/unmount/process replacement',
    async (outcome) => {
      const pending = deferred<string>()
      const resource = new EmailResource('process-1', () => pending.promise, '读取失败')
      resource.start()
      resource.dispose()
      const snapshot = resource.getSnapshot()
      if (outcome === 'success') pending.resolve('old process data')
      else pending.reject(new Error('old process error'))
      await flushPromises()
      expect(resource.getSnapshot()).toBe(snapshot)
    },
  )

  it('invalidates a read begun before a mutation and queues a fresh read without overlapping', async () => {
    const old = deferred<string>()
    const fresh = deferred<string>()
    let calls = 0
    const resource = new EmailResource(
      1,
      () => (++calls === 1 ? old.promise : fresh.promise),
      '读取失败',
    )
    resource.start()
    resource.invalidate()
    old.resolve('before deletion')
    await flushPromises()
    expect(resource.getSnapshot().value).toBeNull()
    expect(calls).toBe(2)
    fresh.resolve('after deletion')
    await flushPromises()
    expect(resource.getSnapshot().value).toBe('after deletion')
    resource.dispose()
  })

  it('survives effect cleanup/setup without accepting a response from the earlier lifecycle', async () => {
    const old = deferred<string>()
    let calls = 0
    const resource = new EmailResource(
      1,
      () => (++calls === 1 ? old.promise : Promise.resolve('new lifecycle')),
      '读取失败',
    )
    resource.start(5_000)
    resource.dispose()
    resource.start(5_000)
    old.resolve('old lifecycle')
    await flushPromises()
    expect(resource.getSnapshot().value).toBe('new lifecycle')
    resource.dispose()
  })
})
