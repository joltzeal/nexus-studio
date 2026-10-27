import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SmsWaitManager, type SmsWaitRead, type SmsWaitTarget } from './sms-wait'

const target: SmsWaitTarget = {
  accountId: 'account-one',
  accountName: 'seller@example.invalid',
  windowId: 'window-one',
  windowName: 'UK shop',
  phone: '+447700900123',
  smsOtpUrl: 'https://inbox.example.invalid/synthetic',
}
const flush = () => vi.advanceTimersByTimeAsync(0)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let manager: SmsWaitManager
let reads: { target: SmsWaitTarget; time: number }[]
let response: (target: SmsWaitTarget) => Promise<SmsWaitRead>
let received: { target: SmsWaitTarget; code: string }[]
let expired: { target: SmsWaitTarget; lastError: string | null }[]
let invalidated: { target: SmsWaitTarget; reason: string }[]
let signals: AbortSignal[]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  reads = []
  received = []
  expired = []
  invalidated = []
  signals = []
  response = async () => ({ code: null })
  manager = new SmsWaitManager({
    read: async (item, signal) => {
      reads.push({ target: item, time: Date.now() })
      signals.push(signal)
      return response(item)
    },
    received: (item, code) => {
      received.push({ target: item, code })
    },
    expired: (item, lastError) => {
      expired.push({ target: item, lastError })
    },
    invalidated: (item, reason) => {
      invalidated.push({ target: item, reason })
    },
  })
})
afterEach(() => {
  manager.stopAll()
  vi.useRealTimers()
})

describe('explicit SMS waiting', () => {
  it('starts only on request, reads immediately then every five seconds, and deduplicates shared accounts', async () => {
    await vi.advanceTimersByTimeAsync(10000)
    expect(reads).toEqual([])
    expect(manager.start(target)).toBe(true)
    expect(manager.start({ ...target, windowId: 'second-window' })).toBe(false)
    await flush()
    expect(manager.getSnapshot()).toEqual([
      { accountId: 'account-one', expiresAt: 310000, lastError: null },
    ])
    expect(reads.map((read) => read.time)).toEqual([10000])
    await vi.advanceTimersByTimeAsync(4999)
    expect(reads).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5001)
    expect(reads.map((read) => read.time)).toEqual([10000, 15000, 20000])
  })

  it('releases at five minutes without a final request or an automatic restart', async () => {
    manager.start(target)
    await vi.advanceTimersByTimeAsync(300000)
    expect(reads).toHaveLength(60)
    expect(reads[reads.length - 1]?.time).toBe(295000)
    expect(manager.getSnapshot()).toEqual([])
    expect(expired).toEqual([{ target, lastError: null }])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(300000)
    expect(reads).toHaveLength(60)
  })

  it.each(['1234', '654321'])(
    'notifies %s once and stops until another manual start',
    async (code) => {
      response = async () => ({ code: reads.length === 2 ? code : null })
      manager.start(target)
      await vi.advanceTimersByTimeAsync(5000)
      expect(received).toEqual([{ target, code }])
      expect(manager.getSnapshot()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(30000)
      expect(reads).toHaveLength(2)
      expect(manager.start(target)).toBe(true)
      await flush()
      expect(reads).toHaveLength(3)
    },
  )

  it('never overlaps slow reads, including after stop and manual restart, and ignores the old result', async () => {
    const pending = deferred<SmsWaitRead>()
    response = async () => pending.promise
    manager.start(target)
    await vi.advanceTimersByTimeAsync(12000)
    expect(reads).toHaveLength(1)
    manager.stop(target.accountId)
    manager.start(target)
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads).toHaveLength(1)
    response = async () => ({ code: null })
    pending.resolve({ code: '123456' })
    await flush()
    expect(received).toEqual([])
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads).toHaveLength(2)
    expect(manager.getSnapshot()).toHaveLength(1)
  })

  it('releases an in-flight task at the deadline and discards its later code', async () => {
    const pending = deferred<SmsWaitRead>()
    response = async () => pending.promise
    manager.start(target)
    await vi.advanceTimersByTimeAsync(300000)
    expect(manager.getSnapshot()).toEqual([])
    expect(expired).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    pending.resolve({ code: '123456' })
    await flush()
    expect(received).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks wall time before accepting a code after sleep', async () => {
    const pending = deferred<SmsWaitRead>()
    response = async () => pending.promise
    manager.start(target)
    await flush()
    vi.setSystemTime(360000)
    pending.resolve({ code: '123456' })
    await flush()
    expect(received).toEqual([])
    expect(expired).toHaveLength(1)
    expect(manager.getSnapshot()).toEqual([])
  })

  it('retries transient read failures on the next tick and retains the last error for timeout', async () => {
    response = async () => {
      throw new Error('Inbox unavailable')
    }
    manager.start(target)
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads).toHaveLength(2)
    expect(manager.getSnapshot()[0]?.lastError).toBe('Inbox unavailable')
    await vi.advanceTimersByTimeAsync(295000)
    expect(expired).toEqual([{ target, lastError: 'Inbox unavailable' }])
    expect(received).toEqual([])
  })

  it('stops when the saved account/contact/binding no longer matches', async () => {
    response = async () => ({ stopped: 'Contact changed' })
    manager.start(target)
    await flush()
    expect(invalidated).toEqual([{ target, reason: 'Contact changed' }])
    expect(received).toEqual([])
    expect(manager.getSnapshot()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('supports independent accounts and releases all tasks on application shutdown', async () => {
    manager.start(target)
    manager.start({ ...target, accountId: 'second-account' })
    await flush()
    manager.stop(target.accountId)
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads.map((read) => read.target.accountId)).toEqual([
      'account-one',
      'second-account',
      'second-account',
    ])
    manager.stopAll()
    await vi.advanceTimersByTimeAsync(300000)
    expect(reads).toHaveLength(3)
    expect(expired).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('only cancels the originating window when another window shares its account', async () => {
    manager.start(target)
    await flush()
    manager.stopWindow('second-window')
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads).toHaveLength(2)
    expect(manager.getSnapshot()).toHaveLength(1)
    manager.stopWindow(target.windowId)
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads).toHaveLength(2)
    expect(manager.getSnapshot()).toEqual([])
  })

  it('rejects an incomplete target and malformed codes without reporting success', async () => {
    expect(() => manager.start({ ...target, smsOtpUrl: '' })).toThrow()
    expect(() => manager.start({ ...target, phone: ' ' })).toThrow()
    response = async () => ({ code: 'not a code' })
    manager.start(target)
    await flush()
    expect(received).toEqual([])
    expect(manager.getSnapshot()[0]?.lastError).toBeTruthy()
  })

  it('publishes stable snapshots, and unsubscribing a row never stops its background task', async () => {
    let updates = 0
    const unsubscribe = manager.subscribe(() => {
      updates += 1
    })
    const empty = manager.getSnapshot()
    expect(manager.getSnapshot()).toBe(empty)
    manager.start(target)
    await flush()
    expect(updates).toBeGreaterThan(0)
    const active = manager.getSnapshot()
    expect(manager.getSnapshot()).toBe(active)
    unsubscribe()
    const before = updates
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads).toHaveLength(2)
    manager.stopAll()
    expect(updates).toBe(before)
  })
})
