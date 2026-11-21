import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductDraftSchema } from '@nexus/plugin-contracts/products'
import { invoke } from '@tauri-apps/api/core'
import { productApi, productFeatures, supportsProductPage } from './api'
import { emptyProductForm, productSaveInput } from './form'
import { readProductImage, uploadProductBytes } from './images'
import type { PluginView } from '../types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const id = '00000000-0000-4000-8000-000000000001'
const stamp = '2026-11-20T12:00:00.000Z'
const data = ProductDraftSchema.parse({ name: '库存样品' })
const { imageIds: _imageIds, ...fields } = data
const product = {
  ...fields,
  id,
  sequence: 1,
  revision: 1,
  images: [],
  publicationCount: 0,
  latestPublication: null,
  source: { kind: 'manual' },
  createdAt: stamp,
  updatedAt: stamp,
}
const emptyPage = { items: [], total: 0, page: 1, pageSize: 20, storageDurable: true }
const mock = vi.mocked(invoke)

afterEach(() => mock.mockReset())

describe('desktop-v2 products boundary', () => {
  it('accepts server page clamping and forwards structured filters', async () => {
    mock.mockResolvedValueOnce(emptyPage)
    const filters = {
      page: 3,
      sourceKind: 'ai-image',
      publicationStatus: 'published',
    } as const
    await expect(productApi.list(filters)).resolves.toEqual(emptyPage)
    expect(mock).toHaveBeenCalledWith('plugin_call', {
      input: expect.objectContaining({
        id: 'studio.products',
        capability: 'product.catalog',
        method: 'products.list',
        payload: expect.objectContaining(filters),
      }),
    })
  })

  it('rejects a page whose item count does not match its total', async () => {
    mock.mockResolvedValueOnce({ ...emptyPage, total: 1 })
    await expect(productApi.list({})).rejects.toThrow('分页')
  })

  it('does not accept an unchanged revision as a successful edit', async () => {
    mock.mockResolvedValueOnce({ product, alreadySaved: false })
    await expect(productApi.save({ id, expectedRevision: 1, data })).rejects.toThrow(
      '保存结果',
    )
  })

  it('checks the deletion receipt belongs to the requested product', async () => {
    mock.mockResolvedValueOnce({
      id: '00000000-0000-4000-8000-000000000002',
      removed: true,
    })
    await expect(productApi.remove({ id, revision: 1 })).rejects.toThrow('删除结果')
  })

  it('requires image details before enabling upload, and exposes no publication writer', () => {
    expect(productFeatures.images).toContain('products.images.read')
    expect(Object.values(productFeatures).flat()).not.toContain(
      'products.publications.record',
    )
    expect(productApi).not.toHaveProperty('recordPublication')
  })

  it('keeps AI import optional but gates the base page on the complete image contract', () => {
    const plugin: PluginView = {
      id: 'studio.products',
      name: '商品管理',
      version: '1.1.1',
      apiVersion: 1,
      minCoreVersion: '0.1.35',
      capabilities: ['product.catalog'],
      granted: ['product.catalog'],
      permissions: {
        storage: 'private',
        networkDomains: [],
        wantsBrowserAccess: false,
        secrets: [],
      },
      source: 'local',
      state: 'running',
      enabled: true,
      status: null,
      lastError: null,
      storageDurable: true,
      secretSlots: [],
      sourceDirectory: null,
      methods: Object.entries(productFeatures)
        .filter(([key]) => key !== 'importAi')
        .flatMap(([, methods]) => [...methods]),
    }
    expect(supportsProductPage(plugin)).toBe(true)
    expect(supportsProductPage({ ...plugin, granted: [] })).toBe(false)
    expect(
      supportsProductPage({
        ...plugin,
        methods: plugin.methods.filter((method) => method !== 'products.upload.abort'),
      }),
    ).toBe(false)
  })

  it('checks clamped publication pages against the requested product', async () => {
    const reply = {
      productId: id,
      productName: '库存样品',
      productRevision: 1,
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    }
    mock.mockResolvedValueOnce(reply)
    await expect(
      productApi.listPublications({ productId: id, page: 3, pageSize: 50 }),
    ).resolves.toEqual(reply)
    mock.mockResolvedValueOnce({
      ...reply,
      productId: '00000000-0000-4000-8000-000000000002',
    })
    await expect(
      productApi.listPublications({ productId: id, pageSize: 50 }),
    ).rejects.toThrow('发布历史')
  })

  it('validates readiness and preserves unchanged tags containing separators', () => {
    expect(() =>
      productSaveInput({ ...emptyProductForm(), name: '商品', status: 'ready' }, [], {
        createKey: id,
      }),
    ).toThrow()
    expect(
      productSaveInput(
        { ...emptyProductForm(), name: '商品', tags: 'A,B' },
        [],
        { createKey: id },
        ['A,B'],
      ).data.tags,
    ).toEqual(['A,B'])
  })

  it('rejects image data with an inconsistent next offset', async () => {
    mock.mockResolvedValueOnce({ data: 'AQ==', total: 2, next: 2, done: true })
    await expect(
      readProductImage({
        id,
        name: 'image.png',
        mime: 'image/png',
        bytes: 2,
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('分块')
  })

  it('aborts by upload ID if the finish response is lost', async () => {
    mock.mockResolvedValueOnce({ uploadId: id, chunkSize: 192 * 1024 })
    mock.mockResolvedValueOnce({ accepted: true })
    mock.mockRejectedValueOnce(new Error('lost response'))
    mock.mockResolvedValueOnce({ aborted: true })
    await expect(
      uploadProductBytes({
        bytes: Uint8Array.of(1),
        mime: 'image/png',
        name: 'image.png',
      }),
    ).rejects.toThrow()
    expect(mock).toHaveBeenLastCalledWith('plugin_call', {
      input: expect.objectContaining({
        method: 'products.upload.abort',
        payload: { uploadId: id },
      }),
    })
  })
})
