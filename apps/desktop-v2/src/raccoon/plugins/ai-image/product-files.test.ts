import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadProductBytes } from '../products/images'

const rpc = vi.hoisted(() =>
  vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
)
vi.mock('../call', () => ({
  callPlugin: vi.fn(
    async <T>(
      _id: string,
      _capability: string,
      method: string,
      payload: unknown,
      parse: (value: unknown) => T,
    ) => parse(await rpc(method, payload)),
  ),
}))

const uploadId = '1198ca69-4f78-4705-ac59-2d48bc790194'
const image = {
  id: '2198ca69-4f78-4705-ac59-2d48bc790194',
  name: 'mug.png',
  mime: 'image/png',
  bytes: 3,
  sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
}
const input = { bytes: new Uint8Array([1, 2, 3]), name: image.name, mime: image.mime }

beforeEach(() => {
  rpc.mockReset().mockImplementation(async (method) => {
    if (method === 'products.upload.begin') return { uploadId, chunkSize: 2 }
    if (method === 'products.upload.chunk') return { accepted: true }
    if (method === 'products.upload.finish') return { image }
    if (method === 'products.images.discard') return { removed: 1 }
    if (method === 'products.upload.abort') return { aborted: true }
    throw new Error('Unexpected RPC')
  })
})

describe('public product image transfer', () => {
  it('uses the public contract and verifies saved bytes, MIME and digest', async () => {
    expect(await uploadProductBytes(input)).toEqual(image)
    expect(rpc).toHaveBeenCalledWith('products.upload.chunk', {
      uploadId,
      index: 0,
      data: 'AQI=',
    })
    expect(rpc).toHaveBeenCalledWith('products.upload.chunk', {
      uploadId,
      index: 1,
      data: 'Aw==',
    })
  })

  it('cleans up a finished image whose hash does not match', async () => {
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) =>
      method === 'products.upload.finish'
        ? { image: { ...image, sha256: 'a'.repeat(64) } }
        : original(method, payload),
    )
    await expect(uploadProductBytes(input)).rejects.toThrow('上传内容不一致')
    expect(rpc).toHaveBeenCalledWith('products.images.discard', { ids: [image.id] })
  })

  it('aborts after cancellation or an invalid chunk acknowledgement', async () => {
    const controller = new AbortController()
    rpc.mockImplementation(async (method) => {
      if (method === 'products.upload.begin') {
        controller.abort()
        return { uploadId, chunkSize: 2 }
      }
      return { aborted: true }
    })
    await expect(uploadProductBytes(input, controller.signal)).rejects.toThrow()
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'products.upload.begin',
      'products.upload.abort',
    ])
    rpc.mockReset().mockImplementation(async (method) => {
      if (method === 'products.upload.begin') return { uploadId, chunkSize: 2 }
      if (method === 'products.upload.chunk') return { accepted: false }
      return { aborted: true }
    })
    await expect(uploadProductBytes(input)).rejects.toThrow()
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'products.upload.begin',
      'products.upload.chunk',
      'products.upload.abort',
    ])
  })
})
