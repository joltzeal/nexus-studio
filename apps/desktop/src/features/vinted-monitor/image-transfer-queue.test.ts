import { describe, expect, it, vi } from 'vitest'
import { ImageTransferQueue } from './image-transfer-queue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('shared Vinted image transfer admission', () => {
  it('waits for cancelled gallery IPC before starting AI transfers', async () => {
    const queue = new ImageTransferQueue()
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const pending = controllers.map(() => deferred())
    const gallery = pending.map((gate, index) =>
      queue.run(controllers[index]!.signal, () => gate.promise),
    )
    await Promise.resolve()
    controllers.forEach((controller) => controller.abort())
    const ai = vi.fn(async () => 'uploaded')
    const result = queue.run(new AbortController().signal, ai)
    await Promise.resolve()
    expect(ai).not.toHaveBeenCalled()
    pending[0]!.resolve()
    await expect(result).resolves.toBe('uploaded')
    expect(ai).toHaveBeenCalledTimes(1)
    pending.forEach((gate) => gate.resolve())
    await Promise.all(gallery)
  })

  it('removes cancelled queued transfers and admits remaining requests in order', async () => {
    const queue = new ImageTransferQueue()
    const gate = deferred()
    const active = Array.from({ length: 4 }, () =>
      queue.run(new AbortController().signal, () => gate.promise),
    )
    const controller = new AbortController()
    const dropped = vi.fn(async () => undefined)
    const cancelled = queue.run(controller.signal, dropped)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    const order: number[] = []
    const rest = [1, 2, 3].map((index) =>
      queue.run(new AbortController().signal, async () => {
        order.push(index)
      }),
    )
    gate.resolve()
    await Promise.all([...active, ...rest, rejected])
    expect(dropped).not.toHaveBeenCalled()
    expect(order).toEqual([1, 2, 3])
  })

  it('releases failed requests without losing queue capacity', async () => {
    const queue = new ImageTransferQueue()
    const calls = Array.from({ length: 12 }, (_, index) =>
      queue.run(new AbortController().signal, async () => {
        if (index < 4) throw new Error('proxy failed')
        return index
      }),
    )
    const results = await Promise.allSettled(calls)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(8)
  })
})
