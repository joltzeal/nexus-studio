import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadImage, uploadRemoteImage } from './api'
import { prepareReference } from './prepare-reference'
import {
  handoffImages,
  ReferenceTransfers,
  transferInitialImage,
} from './reference-transfer'

vi.mock('./api', () => ({ uploadImage: vi.fn(), uploadRemoteImage: vi.fn() }))
vi.mock('./prepare-reference', () => ({ prepareReference: vi.fn() }))

const source = {
  pluginId: 'studio.vinted-monitor',
  itemId: 'vinted.fr:123',
  title: 'Mug',
  url: 'https://www.vinted.fr/items/123',
}
const image = { name: 'mug-1', url: 'https://images.example.test/selected.webp' }
const stored = { id: 'stored', name: 'mug.jpg', mime: 'image/jpeg', bytes: 8 }
const prepared = {
  base64: '/9j/2Q==',
  mime: 'image/jpeg' as const,
  name: 'mug.jpg',
  width: 100,
  height: 100,
  bytes: 4,
}

beforeEach(() => {
  vi.mocked(uploadImage).mockReset().mockResolvedValue(stored)
  vi.mocked(uploadRemoteImage).mockReset().mockResolvedValue(stored)
  vi.mocked(prepareReference).mockReset().mockResolvedValue(prepared)
})
afterEach(() => vi.unstubAllGlobals())

describe('controlled reference transfers', () => {
  it('requires the injected monitor route and never fetches or falls back on failure', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    await expect(transferInitialImage(image, source, signal)).rejects.toThrow('受控图片')
    const loadVintedImage = vi.fn().mockRejectedValue(new Error('采集代理失败'))
    await expect(
      transferInitialImage(image, source, signal, undefined, { loadVintedImage }),
    ).rejects.toThrow('采集代理失败')
    expect(fetch).not.toHaveBeenCalled()
    expect(uploadRemoteImage).not.toHaveBeenCalled()
    expect(uploadImage).not.toHaveBeenCalled()
  })

  it('normalizes Vinted routing and converts the controlled response before chunk upload', async () => {
    const signal = new AbortController().signal
    const loadVintedImage = vi
      .fn()
      .mockResolvedValue(new Blob(['fixture'], { type: 'image/webp' }))
    await expect(
      transferInitialImage(
        image,
        { ...source, pluginId: ` ${source.pluginId} ` },
        signal,
        undefined,
        { loadVintedImage },
      ),
    ).resolves.toEqual(stored)
    expect(loadVintedImage).toHaveBeenCalledExactlyOnceWith(
      source.itemId,
      image.url,
      signal,
    )
    expect(prepareReference).toHaveBeenCalledWith(expect.any(File), signal)
    expect(uploadImage).toHaveBeenCalledExactlyOnceWith(prepared, signal)
    expect(uploadRemoteImage).not.toHaveBeenCalled()
  })

  it('suppresses late conversion uploads and stale callbacks', async () => {
    const controller = new AbortController()
    const loadVintedImage = vi
      .fn()
      .mockResolvedValue(new Blob(['fixture'], { type: 'image/webp' }))
    vi.mocked(prepareReference).mockImplementation(async () => {
      controller.abort()
      return prepared
    })
    await expect(
      transferInitialImage(image, source, controller.signal, undefined, {
        loadVintedImage,
      }),
    ).rejects.toThrow()
    expect(uploadImage).not.toHaveBeenCalled()
    const transfers = new ReferenceTransfers()
    const ready = vi.fn()
    const failed = vi.fn()
    let resolve!: (value: typeof stored) => void
    const old = new Promise<typeof stored>((done) => {
      resolve = done
    })
    const first = transfers.start('selection', () => old, ready, failed)
    await transfers.start('selection', async () => stored, ready, failed)
    resolve(stored)
    await first
    expect(ready).toHaveBeenCalledExactlyOnceWith(stored)
    expect(failed).not.toHaveBeenCalled()
  })

  it('preserves handoff selection order, overflow and the ordinary remote route', async () => {
    const images = Array.from({ length: 7 }, (_, index) => `${image.url}?index=${index}`)
    expect(
      handoffImages({ images, title: source.title }).map((item) => item.url),
    ).toEqual(images)
    await transferInitialImage(image, undefined, new AbortController().signal)
    expect(uploadRemoteImage).toHaveBeenCalledExactlyOnceWith(image.url, image.name)
  })
})
