import { expect, it, vi } from 'vitest'
import { SupplyImageSession } from './image-session'

it('starts a new transfer when an aborted image is immediately reacquired', async () => {
  let finish!: (blob: Blob) => void
  const pending = new Promise<Blob>((resolve) => {
    finish = resolve
  })
  const image = new Blob(['image'])
  const load = vi.fn(() => Promise.resolve(image)).mockReturnValueOnce(pending)
  const revoke = vi.fn()
  const session = new SupplyImageSession(load, () => 'blob:replacement', revoke)
  const original = session.acquire('photo')
  const rejected = expect(original.url).rejects.toThrow('图片读取已取消')
  original.release()
  const replacement = session.acquire('photo')
  finish(image)
  await rejected
  await expect(replacement.url).resolves.toBe('blob:replacement')
  expect(load).toHaveBeenCalledTimes(2)
  replacement.release()
  session.dispose()
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:replacement')
})
