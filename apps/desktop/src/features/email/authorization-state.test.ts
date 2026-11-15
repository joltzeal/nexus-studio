import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred, flushPromises } from '@/features/settings/kernel-test-support'
import { EmailAuthorizationStore } from './authorization-state'
import { mailbox } from './test-fixtures'

const challenge = {
  authorizationId: 'consent-1',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://microsoft.com/devicelogin',
  expiresAt: '2026-11-14T01:15:00Z',
  intervalSeconds: 5,
}
const stores: EmailAuthorizationStore[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.cancel())
  vi.useRealTimers()
})
function setup() {
  vi.useFakeTimers()
  const api = {
    start: vi.fn().mockResolvedValue(challenge),
    poll: vi.fn().mockResolvedValue({ status: 'pending', retryAfterSeconds: 5 }),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
  const saved = vi.fn()
  const store = new EmailAuthorizationStore(mailbox(), api)
  stores.push(store)
  store.setOnAuthorized(saved)
  store.activate()
  return { store, api, saved }
}

describe('email consent lifecycle', () => {
  it('requests consent only on an explicit action and respects server polling intervals', async () => {
    const t = setup()
    expect(t.api.start).not.toHaveBeenCalled()
    await t.store.begin()
    expect(t.api.start).toHaveBeenCalledExactlyOnceWith(
      'mailbox-1',
      'reader@example.test',
    )
    await vi.advanceTimersByTimeAsync(4999)
    expect(t.api.poll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.api.poll).toHaveBeenCalledTimes(1)
    t.api.poll.mockResolvedValueOnce({ status: 'pending', retryAfterSeconds: 10 })
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(9999)
    expect(t.api.poll).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.api.poll).toHaveBeenCalledTimes(3)
  })

  it('pauses hidden effects without resetting the code or losing an in-flight successful authorization', async () => {
    const t = setup()
    await t.store.begin()
    const response = deferred<{
      status: 'authorized'
      account: ReturnType<typeof mailbox>
    }>()
    t.api.poll.mockReturnValueOnce(response.promise)
    await vi.advanceTimersByTimeAsync(5000)
    t.store.pause()
    response.resolve({ status: 'authorized', account: mailbox() })
    await flushPromises()
    expect(t.saved).not.toHaveBeenCalled()
    t.store.activate()
    expect(t.saved).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.api.start).toHaveBeenCalledOnce()
    expect(t.api.poll).toHaveBeenCalledOnce()
  })

  it('ignores a late challenge after closing and cancels it instead of publishing a stale code', async () => {
    const t = setup()
    const pending = deferred<typeof challenge>()
    t.api.start.mockReturnValueOnce(pending.promise)
    const starting = t.store.begin()
    t.store.cancel()
    pending.resolve(challenge)
    await starting
    expect(t.api.cancel).toHaveBeenCalledWith('consent-1')
    expect(t.saved).not.toHaveBeenCalled()
    expect(t.store.getSnapshot().challenge).toBeNull()
  })

  it('retains the code after a failed poll and retries without starting a new device grant', async () => {
    const t = setup()
    await t.store.begin()
    t.api.poll.mockRejectedValueOnce(new Error('synthetic-private-details'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(t.store.getSnapshot().error).not.toContain('synthetic-private')
    expect(t.store.getSnapshot().challenge?.userCode).toBe('ABCD-EFGH')
    t.api.poll.mockResolvedValueOnce({ status: 'authorized', account: mailbox() })
    await t.store.retry()
    expect(t.saved).toHaveBeenCalledOnce()
    expect(t.api.start).toHaveBeenCalledOnce()
  })

  it.each(['denied', 'expired', 'account-mismatch'] as const)(
    'shows a terminal %s outcome and stops polling without applying credentials',
    async (status) => {
      const t = setup()
      await t.store.begin()
      t.api.poll.mockResolvedValueOnce({ status })
      await vi.advanceTimersByTimeAsync(5000)
      expect(t.store.getSnapshot().phase).toBe('failed')
      expect(t.store.getSnapshot().error).toBeTruthy()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(t.api.poll).toHaveBeenCalledOnce()
      expect(t.saved).not.toHaveBeenCalled()
    },
  )
})
