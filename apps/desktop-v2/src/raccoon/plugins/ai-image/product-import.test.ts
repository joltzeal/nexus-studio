import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductSchema } from '@nexus/plugin-contracts/products'
import { pluginApi } from '../api'
import type { PluginView } from '../types'
import { getRecord, readImageBytes } from './api'
import { callProducts } from '../products/api'
import { discardProductImages, uploadProductBytes } from '../products/images'
import { importGenerationProduct } from './product-import'
import { makeSceneRecord } from './scene-plan.test-data'

vi.mock('../api', () => ({ pluginApi: { list: vi.fn() } }))
vi.mock('./api', () => ({ getRecord: vi.fn(), readImageBytes: vi.fn() }))
vi.mock('../products/api', () => ({ callProducts: vi.fn() }))
vi.mock('../products/images', () => ({
  discardProductImages: vi.fn(),
  uploadProductBytes: vi.fn(),
}))

const image = {
  id: '2198ca69-4f78-4705-ac59-2d48bc790194',
  name: 'mug.png',
  mime: 'image/png' as const,
  bytes: 3,
  sha256: 'a'.repeat(64),
}
const product = ProductSchema.parse({
  id: '1198ca69-4f78-4705-ac59-2d48bc790194',
  name: 'Used mug',
  title: 'Used mug',
  description: 'A used mug.',
  revision: 1,
  sequence: 1,
  images: [image],
  platformFacts: { vinted: [] },
  publicationCount: 0,
  latestPublication: null,
  source: { kind: 'ai-image', recordId: 'record', origin: null },
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
    enabled: true,
    state: 'running',
    methods,
    storageDurable: true,
    source: '/controlled-plugin',
    installation: 'installed',
    runtimeGeneration: 'process-1',
    status: { pid: 1 },
    lastError: null,
    sourceDirectory: null,
    secretSlots: [],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
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
function record() {
  return {
    ...makeSceneRecord(),
    status: 'success' as const,
    scenePlan: undefined,
    title: 'Used mug',
    description: 'A used mug.',
    outputs: [{ id: 'output-1', name: 'mug.png', mime: 'image/png', bytes: 3 }],
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(pluginApi.list).mockResolvedValue(catalog)
  vi.mocked(getRecord).mockResolvedValue({ record: record() })
  vi.mocked(readImageBytes).mockResolvedValue(new Uint8Array([1, 2, 3]))
  vi.mocked(uploadProductBytes).mockResolvedValue(image)
  vi.mocked(discardProductImages).mockResolvedValue()
  vi.mocked(callProducts).mockImplementation(async (method) => {
    if (method === 'products.sources.find') return { product: null }
    if (method === 'products.importAi') return { product, alreadyImported: false }
    throw new Error('Unexpected RPC')
  })
})

describe('AI generation product import', () => {
  it('copies all bytes into one draft and preserves full listing text and source', async () => {
    const fullTitle = 'A'.repeat(201)
    vi.mocked(getRecord).mockResolvedValue({ record: { ...record(), title: fullTitle } })
    const saved = { ...product, name: fullTitle.slice(0, 200), title: fullTitle }
    vi.mocked(callProducts)
      .mockResolvedValueOnce({ product: null })
      .mockResolvedValueOnce({ product: saved, alreadyImported: false })
    expect(await importGenerationProduct('record')).toEqual({
      product: saved,
      alreadyImported: false,
    })
    expect(uploadProductBytes).toHaveBeenCalledExactlyOnceWith(
      { bytes: new Uint8Array([1, 2, 3]), name: 'mug.png', mime: 'image/png' },
      undefined,
    )
    expect(callProducts).toHaveBeenCalledWith(
      'products.importAi',
      expect.objectContaining({
        recordId: 'record',
        data: expect.objectContaining({
          name: 'A'.repeat(200),
          title: fullTitle,
          imageIds: [image.id],
        }),
      }),
    )
    expect(getRecord).toHaveBeenCalledTimes(2)
  })

  it('rejects a new import receipt that omits copied images', async () => {
    vi.mocked(callProducts)
      .mockResolvedValueOnce({ product: null })
      .mockResolvedValueOnce({
        product: { ...product, images: [] },
        alreadyImported: false,
      })
    await expect(importGenerationProduct('record')).rejects.toThrow('导入结果')
    expect(discardProductImages).toHaveBeenCalledWith([image.id])
  })

  it('returns an already imported product without copying or overwriting it', async () => {
    vi.mocked(callProducts).mockResolvedValue({ product })
    expect(await importGenerationProduct('record')).toEqual({
      product,
      alreadyImported: true,
    })
    expect(getRecord).not.toHaveBeenCalled()
    expect(uploadProductBytes).not.toHaveBeenCalled()
  })

  it('stops on process replacement and cleans up copied images when the source changes', async () => {
    vi.mocked(pluginApi.list)
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce([
        { ...catalog[0]!, runtimeGeneration: 'process-2' },
        catalog[1]!,
      ])
    await expect(importGenerationProduct('record')).rejects.toThrow('重启或更新')
    expect(uploadProductBytes).not.toHaveBeenCalled()
    vi.mocked(pluginApi.list).mockResolvedValue(catalog)
    vi.mocked(getRecord)
      .mockResolvedValueOnce({ record: record() })
      .mockResolvedValueOnce({ record: { ...record(), title: 'Changed' } })
    await expect(importGenerationProduct('record')).rejects.toThrow('发生变化')
    expect(discardProductImages).toHaveBeenCalledWith([image.id])
    expect(
      vi
        .mocked(callProducts)
        .mock.calls.some(([method]) => method === 'products.importAi'),
    ).toBe(false)
  })

  it('rejects mismatched sizes and cancellation before uploading', async () => {
    vi.mocked(readImageBytes).mockResolvedValue(new Uint8Array([1]))
    await expect(importGenerationProduct('record')).rejects.toThrow('大小与记录不一致')
    expect(uploadProductBytes).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort()
    await expect(
      importGenerationProduct('record', { signal: controller.signal }),
    ).rejects.toThrow()
  })
})
