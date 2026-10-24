import { afterEach, describe, expect, it, vi } from 'vitest'
import { SupplyImageCache } from './image-cache'

afterEach(() => vi.useRealTimers())

describe('shared image blob lifecycle', () => {
  it('shares one load across thumbnail and gallery, then revokes the unused cached URL', async () => {
    vi.useFakeTimers()
    let loads = 0
    const cache = new SupplyImageCache(async () => {
      loads += 1
      return new Blob(['photo'], { type: 'image/jpeg' })
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const first = cache.acquire('photo')
    const second = cache.acquire('photo')
    const objectUrl = await first.promise
    expect(await second.promise).toBe(objectUrl)
    expect(loads).toBe(1)
    first.release()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(revoke).not.toHaveBeenCalled()
    second.release()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(revoke).toHaveBeenCalledWith(objectUrl)
  })

  it('drops failed entries so an explicit retry can load after network recovery', async () => {
    let attempts = 0
    const cache = new SupplyImageCache(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return new Blob(['photo'])
    })
    const first = cache.acquire('photo')
    await expect(first.promise).rejects.toThrow('offline')
    first.release()
    const retry = cache.acquire('photo')
    expect(await retry.promise).toMatch(/^blob:/)
    retry.release()
    cache.clearUnused()
  })

  it('reloads a decode failure without revoking a URL another image still holds', async () => {
    let loads = 0
    const cache = new SupplyImageCache(async () => new Blob([String(++loads)]))
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const thumbnail = cache.acquire('photo')
    const gallery = cache.acquire('photo')
    const failedUrl = await gallery.promise
    cache.invalidate('photo', failedUrl)
    gallery.release()
    const retry = cache.acquire('photo')
    expect(await retry.promise).not.toBe(failedUrl)
    expect(loads).toBe(2)
    expect(revoke).not.toHaveBeenCalledWith(failedUrl)
    // A late decode error for the old URL must not invalidate the newer one.
    cache.invalidate('photo', failedUrl)
    const next = cache.acquire('photo')
    expect(await next.promise).toBe(await retry.promise)
    thumbnail.release()
    expect(revoke).toHaveBeenCalledWith(failedUrl)
    retry.release()
    next.release()
    cache.clearUnused()
  })

  it('discards late downloads after the last consumer releases instead of creating a leaked URL', async () => {
    let resolve!: (blob: Blob) => void
    let signal: AbortSignal | undefined
    const cache = new SupplyImageCache((_url, nextSignal) => {
      signal = nextSignal
      return new Promise<Blob>((done) => {
        resolve = done
      })
    })
    const create = vi.spyOn(URL, 'createObjectURL')
    const lease = cache.acquire('photo')
    const rejected = expect(lease.promise).rejects.toMatchObject({ name: 'AbortError' })
    lease.release()
    expect(signal?.aborted).toBe(true)
    resolve(new Blob(['late']))
    await rejected
    expect(create).not.toHaveBeenCalled()
  })

  it('bounds concurrent RPC transfers and never starts abandoned queued requests', async () => {
    const started: string[] = []
    const finish: (() => void)[] = []
    const cache = new SupplyImageCache((url) => {
      started.push(url)
      return new Promise<Blob>((resolve) => finish.push(() => resolve(new Blob([url]))))
    })
    const leases = Array.from({ length: 6 }, (_, index) => cache.acquire(String(index)))
    expect(started).toEqual(['0', '1', '2', '3'])
    const abandoned = leases[4]!
    const rejected = expect(abandoned.promise).rejects.toMatchObject({
      name: 'AbortError',
    })
    abandoned.release()
    await rejected
    finish[0]!()
    await leases[0]!.promise
    await vi.waitFor(() => expect(started).toEqual(['0', '1', '2', '3', '5']))
    for (const done of finish) done()
    await Promise.all(leases.filter((_, i) => i !== 4).map((lease) => lease.promise))
    for (const lease of leases) lease.release()
    cache.clearUnused()
  })

  it('evicts unused bytes to keep memory bounded while retaining images still on screen', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const cache = new SupplyImageCache(
      async () => new Blob([new Uint8Array(8 * 1024 * 1024)]),
    )
    const pinned = cache.acquire('pinned')
    const pinnedUrl = await pinned.promise
    let firstUnused = ''
    for (let i = 0; i < 5; i += 1) {
      const lease = cache.acquire(String(i))
      const result = await lease.promise
      if (i === 0) firstUnused = result
      lease.release()
    }
    expect(revoke).toHaveBeenCalledWith(firstUnused)
    expect(revoke).not.toHaveBeenCalledWith(pinnedUrl)
    pinned.release()
    cache.clearUnused()
  })
})
