import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductSchema } from '@nexus/plugin-products/contracts'
import { callPlugin, listPlugins, type PluginView } from '@/lib/platform/native-plugins'
import { getRecord } from '@/features/ai-image/api'
import { discardProductImages, uploadProductBytes } from './api'
import { importGenerationProduct } from './ai-import'

vi.mock('@/lib/platform/native-plugins', () => ({
  callPlugin: vi.fn(),
  listPlugins: vi.fn(),
}))
vi.mock('@/features/ai-image/api', () => ({ getRecord: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  discardProductImages: vi.fn(),
  uploadProductBytes: vi.fn(),
}))

const productId = '1198ca69-4f78-4705-ac59-2d48bc790194'
const imageId = '2198ca69-4f78-4705-ac59-2d48bc790194'
const recordId = 'generation-1'
const image = {
  id: imageId,
  name: 'mug.png',
  mime: 'image/png' as const,
  bytes: 3,
  sha256: 'a'.repeat(64),
}
const product = ProductSchema.parse({
  id: productId,
  name: 'Used mug',
  title: 'Used mug',
  revision: 1,
  sequence: 1,
  images: [image],
  publicationCount: 0,
  latestPublication: null,
  source: { kind: 'ai-image', recordId, origin: null },
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
})

function plugin(id: string, capability: string, methods: string[]): PluginView {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.29',
    capabilities: [capability],
    granted: [capability],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: '/controlled-plugin',
    state: 'running',
    enabled: true,
    methods,
    status: { pid: 1 },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
  }
}
const catalog = [
  plugin('studio.products', 'product.catalog', [
    'products.sources.find',
    'products.importAi',
    'products.upload.begin',
    'products.upload.chunk',
    'products.upload.finish',
    'products.upload.abort',
    'products.images.discard',
  ]),
  plugin('studio.ai-image', 'image.provider', ['image.records.get', 'image.file.chunk']),
]
const record = {
  id: recordId,
  status: 'success',
  stage: 'done',
  title: 'Used mug',
  description: 'A used mug.',
  outputs: [{ id: 'output-1', name: 'mug.png', mime: 'image/png', bytes: 3 }],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(listPlugins).mockResolvedValue(catalog)
  // A controlled IPC fixture deliberately contains only fields consumed by the bridge.
  vi.mocked(getRecord).mockImplementation(
    async () => ({ record }) as Awaited<ReturnType<typeof getRecord>>,
  )
  vi.mocked(uploadProductBytes).mockResolvedValue(image)
  vi.mocked(discardProductImages).mockResolvedValue()
  vi.mocked(callPlugin).mockImplementation(async (_id, _capability, method) => {
    if (method === 'products.sources.find') return { product: null }
    if (method === 'image.file.chunk')
      return { data: 'AQID', next: 3, total: 3, done: true }
    if (method === 'products.importAi') return { product, alreadyImported: false }
    throw new Error('Unexpected method')
  })
})

describe('generation to independent product import', () => {
  it('preserves a long listing title while using a bounded internal product name', async () => {
    const title = 'A'.repeat(201)
    vi.mocked(getRecord).mockResolvedValue({
      record: { ...record, title },
    } as Awaited<ReturnType<typeof getRecord>>)
    await importGenerationProduct(recordId)
    expect(callPlugin).toHaveBeenCalledWith(
      'studio.products',
      'product.catalog',
      'products.importAi',
      expect.objectContaining({
        data: expect.objectContaining({ name: 'A'.repeat(200), title }),
      }),
      30_000,
    )
  })
  it('copies all images and submits one draft retaining the source record', async () => {
    const onProgress = vi.fn()
    expect(await importGenerationProduct(recordId, { onProgress })).toEqual({
      product,
      alreadyImported: false,
    })
    expect(uploadProductBytes).toHaveBeenCalledExactlyOnceWith(
      {
        bytes: new Uint8Array([1, 2, 3]),
        name: 'mug.png',
        mime: 'image/png',
      },
      undefined,
    )
    expect(callPlugin).toHaveBeenCalledWith(
      'studio.products',
      'product.catalog',
      'products.importAi',
      {
        recordId,
        origin: null,
        data: expect.objectContaining({
          name: 'Used mug',
          title: 'Used mug',
          description: 'A used mug.',
          status: 'draft',
          price: null,
          category: '',
          imageIds: [imageId],
        }),
      },
      30_000,
    )
    expect(onProgress).toHaveBeenLastCalledWith({
      stage: 'saving',
      completed: 1,
      total: 1,
    })
    expect(discardProductImages).not.toHaveBeenCalled()
  })

  it('returns an existing product without reading AI or overwriting edits', async () => {
    vi.mocked(listPlugins).mockResolvedValue([catalog[0]!])
    vi.mocked(callPlugin).mockResolvedValue({
      product: { ...product, title: 'Manually edited title' },
    })
    expect((await importGenerationProduct(recordId)).alreadyImported).toBe(true)
    expect(getRecord).not.toHaveBeenCalled()
    expect(uploadProductBytes).not.toHaveBeenCalled()
  })

  it('discards only newly uploaded files when the same record wins a concurrent import', async () => {
    const uploaded = { ...image, id: '3198ca69-4f78-4705-ac59-2d48bc790194' }
    vi.mocked(uploadProductBytes).mockResolvedValue(uploaded)
    vi.mocked(callPlugin).mockImplementation(async (_id, _capability, method) => {
      if (method === 'products.sources.find') return { product: null }
      if (method === 'image.file.chunk')
        return { data: 'AQID', next: 3, total: 3, done: true }
      return { product, alreadyImported: true }
    })
    expect((await importGenerationProduct(recordId)).alreadyImported).toBe(true)
    expect(discardProductImages).toHaveBeenCalledExactlyOnceWith([uploaded.id])
  })

  it('cleans partial imports on a missing later image and does not commit', async () => {
    vi.mocked(getRecord).mockResolvedValue({
      record: {
        ...record,
        outputs: [...record.outputs, { ...record.outputs[0], id: 'missing' }],
      },
    } as Awaited<ReturnType<typeof getRecord>>)
    vi.mocked(callPlugin).mockImplementation(
      async (_id, _capability, method, payload) => {
        if (method === 'products.sources.find') return { product: null }
        if (
          method === 'image.file.chunk' &&
          (payload as { fileId: string }).fileId === 'output-1'
        )
          return { data: 'AQID', next: 3, total: 3, done: true }
        throw new Error('Image no longer exists')
      },
    )
    await expect(importGenerationProduct(recordId)).rejects.toThrow(
      'Image no longer exists',
    )
    expect(discardProductImages).toHaveBeenCalledExactlyOnceWith([imageId])
    expect(
      vi.mocked(callPlugin).mock.calls.some((call) => call[2] === 'products.importAi'),
    ).toBe(false)
  })

  it('stops before writes if either required plugin is disabled or has no capability grant', async () => {
    vi.mocked(listPlugins).mockResolvedValue([
      { ...catalog[0]!, granted: [] },
      catalog[1]!,
    ])
    await expect(importGenerationProduct(recordId)).rejects.toThrow('商品')
    expect(callPlugin).not.toHaveBeenCalled()
    expect(uploadProductBytes).not.toHaveBeenCalled()
  })

  it('rejects active generations, nonprogressing reads and a replaced process', async () => {
    vi.mocked(getRecord).mockResolvedValue({
      record: { ...record, status: 'running' },
    } as Awaited<ReturnType<typeof getRecord>>)
    await expect(importGenerationProduct(recordId)).rejects.toThrow('完成')
    vi.mocked(getRecord).mockResolvedValue({ record } as Awaited<
      ReturnType<typeof getRecord>
    >)
    vi.mocked(callPlugin).mockImplementation(async (_id, _capability, method) => {
      if (method === 'products.sources.find') return { product: null }
      return { data: 'AQID', next: 0, total: 3, done: false }
    })
    await expect(importGenerationProduct(recordId)).rejects.toThrow()
    expect(uploadProductBytes).not.toHaveBeenCalled()
    vi.mocked(listPlugins)
      .mockResolvedValue(catalog)
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce([{ ...catalog[0]!, status: { pid: 2 } }, catalog[1]!])
    await expect(importGenerationProduct(recordId)).rejects.toThrow('重启')
  })

  it('retains a committed product when cancellation arrives with the commit reply', async () => {
    const controller = new AbortController()
    vi.mocked(callPlugin).mockImplementation(async (_id, _capability, method) => {
      if (method === 'products.sources.find') return { product: null }
      if (method === 'image.file.chunk')
        return { data: 'AQID', next: 3, total: 3, done: true }
      controller.abort()
      return { product, alreadyImported: false }
    })
    expect(
      (await importGenerationProduct(recordId, { signal: controller.signal })).product.id,
    ).toBe(productId)
    expect(discardProductImages).not.toHaveBeenCalled()
  })
})
