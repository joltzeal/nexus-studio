import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadVintedImage } from '@/features/vinted-monitor/api'
import { uploadImage, uploadRemoteImage } from './api'
import { prepareReference, type PreparedReference } from './prepare-reference'
import {
  handoffImages,
  MAX_REFERENCES,
  ReferenceTransfers,
  transferInitialImage,
} from './reference-transfer'
import type { StoredFile } from './types'

vi.mock('@/features/vinted-monitor/api', () => ({ loadVintedImage: vi.fn() }))
vi.mock('./api', () => ({ uploadImage: vi.fn(), uploadRemoteImage: vi.fn() }))
vi.mock('./prepare-reference', () => ({ prepareReference: vi.fn() }))

const source = {
  pluginId: 'studio.vinted-monitor',
  itemId: 'vinted.fr:123',
  title: 'mug',
  url: 'https://www.vinted.fr/items/123',
}
const image = { name: 'mug-1', url: 'https://images.example.test/selected.png' }
const stored: StoredFile = {
  id: 'uploaded',
  name: image.name,
  mime: 'image/png',
  bytes: 8,
}
const prepared: PreparedReference = {
  base64: '/9j/2Q==',
  mime: 'image/jpeg',
  name: 'mug-1.jpg',
  width: 1200,
  height: 800,
  bytes: 4,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.mocked(loadVintedImage).mockReset()
  vi.mocked(uploadImage).mockReset().mockResolvedValue(stored)
  vi.mocked(uploadRemoteImage).mockReset().mockResolvedValue(stored)
  vi.mocked(prepareReference).mockReset().mockResolvedValue(prepared)
})
afterEach(() => vi.unstubAllGlobals())

describe('gallery references', () => {
  it.each(['image/webp', 'image/png', 'image/jpeg'])(
    'downloads %s with the monitor route and uploads the locally converted JPEG',
    async (mime) => {
      const fetchMock = vi.fn(() => {
        throw new Error('WebView must not fetch URLs')
      })
      vi.stubGlobal('fetch', fetchMock)
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13])
      vi.mocked(loadVintedImage).mockResolvedValue(new Blob([bytes], { type: mime }))
      const signal = new AbortController().signal
      expect(await transferInitialImage(image, source, signal)).toEqual(stored)
      expect(loadVintedImage).toHaveBeenCalledExactlyOnceWith(
        source.itemId,
        image.url,
        signal,
      )
      const downloaded = vi.mocked(prepareReference).mock.calls[0]?.[0]
      expect(downloaded).toBeInstanceOf(File)
      if (!(downloaded instanceof File)) throw new Error('Expected downloaded File')
      expect(downloaded.type).toBe(mime)
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes)
      expect(prepareReference).toHaveBeenCalledExactlyOnceWith(downloaded, signal)
      expect(uploadImage).toHaveBeenCalledExactlyOnceWith(prepared, signal)
      expect(uploadRemoteImage).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('download failure is surfaced without trying AI remote download or generating', async () => {
    vi.mocked(loadVintedImage).mockRejectedValue(new Error('采集代理失败'))
    await expect(
      transferInitialImage(image, source, new AbortController().signal),
    ).rejects.toThrow('采集代理失败')
    expect(uploadImage).not.toHaveBeenCalled()
    expect(uploadRemoteImage).not.toHaveBeenCalled()
  })

  it('normalizes source IDs before routing so whitespace cannot bypass the monitor', async () => {
    vi.mocked(loadVintedImage).mockResolvedValue(
      new Blob(['bytes'], { type: 'image/png' }),
    )
    const signal = new AbortController().signal
    await transferInitialImage(
      image,
      { ...source, pluginId: ` ${source.pluginId} `, itemId: ` ${source.itemId} ` },
      signal,
    )
    expect(loadVintedImage).toHaveBeenCalledExactlyOnceWith(
      source.itemId,
      image.url,
      signal,
    )
    expect(uploadRemoteImage).not.toHaveBeenCalled()
  })

  it('cancellation after download prevents the AI upload', async () => {
    const controller = new AbortController()
    vi.mocked(loadVintedImage).mockImplementation(async () => {
      controller.abort()
      return new Blob(['bytes'], { type: 'image/png' })
    })
    await expect(transferInitialImage(image, source, controller.signal)).rejects.toThrow()
    expect(uploadImage).not.toHaveBeenCalled()
    expect(uploadRemoteImage).not.toHaveBeenCalled()
  })

  it('conversion failure does not upload the WebP or fall back to remote download', async () => {
    vi.mocked(loadVintedImage).mockResolvedValue(
      new Blob(['webp'], { type: 'image/webp' }),
    )
    vi.mocked(prepareReference).mockRejectedValue(new Error('图片转为 JPEG 失败'))
    await expect(
      transferInitialImage(image, source, new AbortController().signal),
    ).rejects.toThrow('图片转为 JPEG 失败')
    expect(uploadImage).not.toHaveBeenCalled()
    expect(uploadRemoteImage).not.toHaveBeenCalled()
  })

  it('cancellation during conversion prevents any later plugin upload', async () => {
    const controller = new AbortController()
    vi.mocked(loadVintedImage).mockResolvedValue(
      new Blob(['webp'], { type: 'image/webp' }),
    )
    vi.mocked(prepareReference).mockImplementation(async () => {
      controller.abort()
      return prepared
    })
    await expect(transferInitialImage(image, source, controller.signal)).rejects.toThrow()
    expect(uploadImage).not.toHaveBeenCalled()
    expect(uploadRemoteImage).not.toHaveBeenCalled()
  })

  it('keeps existing remote transfers for non-Vinted and legacy handoffs', async () => {
    await transferInitialImage(image, undefined, new AbortController().signal)
    expect(uploadRemoteImage).toHaveBeenCalledExactlyOnceWith(image.url, image.name)
    expect(loadVintedImage).not.toHaveBeenCalled()
  })

  it('preserves selected order and overflow for explicit removal; bounded file names', () => {
    const urls = Array.from(
      { length: MAX_REFERENCES + 1 },
      (_, index) => `${image.url}?i=${index}`,
    )
    const result = handoffImages({ images: urls, title: 'm'.repeat(500), source })
    expect(result.map((entry) => entry.url)).toEqual(urls)
    expect(result).toHaveLength(7)
    expect(result.every((entry) => entry.name.length <= 120)).toBe(true)
    expect(handoffImages(null)).toEqual([])
  })
})

describe('stale transfer callbacks', () => {
  it('removal and unmount abort old work and suppress late results', async () => {
    const transfers = new ReferenceTransfers()
    const ready = vi.fn()
    const failed = vi.fn()
    const pending = deferred<StoredFile>()
    let signal: AbortSignal | undefined
    const running = transfers.start(
      'selected',
      (value) => {
        signal = value
        return pending.promise
      },
      ready,
      failed,
    )
    transfers.cancelAll()
    expect(signal?.aborted).toBe(true)
    pending.resolve(stored)
    await running
    expect(ready).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  })

  it('retry of the same stable key cannot be overwritten by an older attempt', async () => {
    const transfers = new ReferenceTransfers()
    const ready = vi.fn()
    const failed = vi.fn()
    const old = deferred<StoredFile>()
    const running = transfers.start('selected', () => old.promise, ready, failed)
    await transfers.start('selected', async () => stored, ready, failed)
    old.reject(new Error('old late error'))
    await running
    expect(ready).toHaveBeenCalledExactlyOnceWith(stored)
    expect(failed).not.toHaveBeenCalled()
  })

  it('surfaces a failed transfer and allows the same selection to be retried', async () => {
    const transfers = new ReferenceTransfers()
    const ready = vi.fn()
    const failed = vi.fn()
    const error = new Error('下载失败')
    await transfers.start('selected', () => Promise.reject(error), ready, failed)
    expect(failed).toHaveBeenCalledExactlyOnceWith(error)
    await transfers.start('selected', async () => stored, ready, failed)
    expect(ready).toHaveBeenCalledExactlyOnceWith(stored)
  })
})
