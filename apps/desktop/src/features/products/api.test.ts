import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMAGE_CHUNK_BYTES,
  ProductDraftSchema,
  ProductSchema,
  type ProductImage,
} from '@nexus/plugin-products/contracts'
import { callPlugin } from '@/lib/platform/native-plugins'
import {
  discardProductImages,
  decodeImageBytes,
  encodeImageBytes,
  getProduct,
  importProductText,
  listProducts,
  productImageUrl,
  releaseProductImageUrls,
  removeProduct,
  saveProduct,
  uploadProductImage,
} from './api'
import { publication } from './publication.test-data'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

const id = '1198ca69-4f78-4705-ac59-2d48bc790194'
const imageId = '2198ca69-4f78-4705-ac59-2d48bc790194'
const uploadId = '3198ca69-4f78-4705-ac59-2d48bc790194'
const product = ProductSchema.parse({
  id,
  name: 'Used mug',
  revision: 1,
  sequence: 1,
  images: [],
  publicationCount: 0,
  latestPublication: null,
  source: { kind: 'manual' },
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
})
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1kAAAAASUVORK5CYII='
const png = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0))
const image: ProductImage = {
  id: imageId,
  name: 'mug.png',
  mime: 'image/png',
  bytes: png.length,
  sha256: '15dc8a5334710403842e8d1074dfe2d74d56cb8c03d30f5e239fac9413d1f92c',
}
const summary = {
  id: product.id,
  revision: product.revision,
  sequence: product.sequence,
  name: product.name,
  title: product.title,
  sku: product.sku,
  price: product.price,
  currency: product.currency,
  category: product.category,
  status: product.status,
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
  source: { kind: product.source.kind },
  cover: null,
  imageCount: 0,
  publicationCount: 0,
  latestPublication: null,
}

beforeEach(() => {
  vi.mocked(callPlugin).mockReset()
  releaseProductImageUrls()
})

describe('product RPC boundary', () => {
  it('uses backend pagination and validates matching page and unique records', async () => {
    const page = {
      items: [summary],
      total: 21,
      page: 2,
      pageSize: 20,
      storageDurable: true,
    }
    vi.mocked(callPlugin).mockResolvedValue(page)
    expect(await listProducts({ page: 2, query: ' mug ' })).toEqual(page)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.products',
      'product.catalog',
      'products.list',
      { page: 2, pageSize: 20, query: 'mug' },
      30_000,
    )
    vi.mocked(callPlugin).mockResolvedValue({ ...page, page: 1 })
    await expect(listProducts({ page: 2 })).rejects.toThrow('分页')
    vi.mocked(callPlugin).mockResolvedValue({
      ...page,
      items: [page.items[0], page.items[0]],
    })
    await expect(listProducts({ page: 2 })).rejects.toThrow()
  })

  it('accepts a page clamped after the last product on the final page was removed', async () => {
    vi.mocked(callPlugin).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      storageDurable: true,
    })
    expect((await listProducts({ page: 2 })).page).toBe(1)
  })

  it('sends the independent publication filter and rejects backend rows that do not match it', async () => {
    const page = {
      items: [
        { ...summary, revision: 3, publicationCount: 1, latestPublication: publication },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      storageDurable: true,
    }
    vi.mocked(callPlugin).mockResolvedValue(page)
    expect(await listProducts({ publicationStatus: 'published' })).toEqual(page)
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.products',
      'product.catalog',
      'products.list',
      { query: '', page: 1, pageSize: 20, publicationStatus: 'published' },
      30_000,
    )
    await expect(listProducts({ publicationStatus: 'unpublished' })).rejects.toThrow(
      '分页',
    )
    vi.mocked(callPlugin).mockResolvedValue({ ...page, items: [summary] })
    await expect(listProducts({ publicationStatus: 'published' })).rejects.toThrow('分页')
    expect((await listProducts({ publicationStatus: 'unpublished' })).items).toEqual([
      summary,
    ])
  })

  it.each([
    { publicationCount: 1, latestPublication: null },
    { publicationCount: 0, latestPublication: publication },
  ])('rejects inconsistent publication count and latest usage: %j', async (patch) => {
    vi.mocked(callPlugin).mockResolvedValue({
      items: [{ ...summary, ...patch }],
      total: 1,
      page: 1,
      pageSize: 20,
      storageDurable: true,
    })
    await expect(listProducts({})).rejects.toThrow('分页')
  })

  it.each(['manual', 'import', 'ai-image'] as const)(
    'accepts a slim %s summary with only the source kind',
    async (sourceKind) => {
      const page = {
        items: [{ ...summary, source: { kind: sourceKind } }],
        total: 1,
        page: 1,
        pageSize: 20,
        storageDurable: true,
      }
      vi.mocked(callPlugin).mockResolvedValue(page)
      expect(await listProducts({ sourceKind })).toEqual(page)
    },
  )

  it('reads a bounded publication overview and rejects unbounded or malformed detail replies', async () => {
    const published = {
      ...product,
      revision: 3,
      publicationCount: 370,
      latestPublication: publication,
    }
    vi.mocked(callPlugin).mockResolvedValue({ product: published })
    expect(await getProduct(id)).toEqual(published)
    vi.mocked(callPlugin).mockResolvedValue({
      product: {
        ...published,
        latestPublication: { ...publication, listingUrl: 'javascript:alert(1)' },
      },
    })
    await expect(getProduct(id)).rejects.toThrow()
    vi.mocked(callPlugin).mockResolvedValue({
      product: { ...published, publications: [publication] },
    })
    await expect(getProduct(id)).rejects.toThrow()
  })

  it('accepts bounded edit replies without requesting publication history', async () => {
    const data = ProductDraftSchema.parse({ name: 'Used mug' })
    const saved = {
      ...product,
      revision: 4,
      publicationCount: 370,
      latestPublication: publication,
    }
    vi.mocked(callPlugin).mockResolvedValue({ product: saved, alreadySaved: false })
    expect(await saveProduct({ id, expectedRevision: 3, data })).toEqual(saved)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.products',
      'product.catalog',
      'products.save',
      { id, expectedRevision: 3, data },
      30_000,
    )
  })

  it('requires a revision for edits and stable create key for new products', async () => {
    const data = ProductDraftSchema.parse({ name: 'Used mug' })
    await expect(saveProduct({ data })).rejects.toThrow()
    expect(callPlugin).not.toHaveBeenCalled()
    vi.mocked(callPlugin).mockResolvedValue({ product, alreadySaved: false })
    expect(await saveProduct({ createKey: id, data })).toEqual(product)
  })

  it('rejects mismatched product, mutation and import replies', async () => {
    vi.mocked(callPlugin).mockResolvedValue({ product: { ...product, id: imageId } })
    await expect(getProduct(id)).rejects.toThrow()
    vi.mocked(callPlugin).mockResolvedValue({ id: imageId, removed: true })
    await expect(removeProduct(product)).rejects.toThrow()
    vi.mocked(callPlugin).mockResolvedValue({
      total: 1,
      inserted: 2,
      skipped: 0,
      errors: [],
    })
    await expect(importProductText('json', '[{"name":"Mug"}]')).rejects.toThrow()
    vi.mocked(callPlugin).mockResolvedValue({ removed: 2 })
    await expect(discardProductImages([imageId])).rejects.toThrow()
  })

  it('does not report changed form values as saved when a previous create already committed', async () => {
    vi.mocked(callPlugin).mockResolvedValue({ product, alreadySaved: true })
    await expect(
      saveProduct({
        createKey: id,
        data: ProductDraftSchema.parse({ name: 'Updated after an interrupted save' }),
      }),
    ).rejects.toThrow('已创建')
  })

  it('accepts import errors as a subset of skipped rows', async () => {
    const report = {
      total: 2,
      inserted: 1,
      skipped: 1,
      errors: [{ row: 3, message: '商品名称不能为空' }],
    }
    vi.mocked(callPlugin).mockResolvedValue(report)
    expect(await importProductText('csv', 'name\nMug\n')).toEqual(report)
  })
})

describe('owned product image transfers', () => {
  it('roundtrips a maximum protocol chunk without truncating binary bytes', () => {
    const bytes = Uint8Array.from(
      { length: IMAGE_CHUNK_BYTES },
      (_, index) => index % 256,
    )
    const encoded = encodeImageBytes(bytes)
    expect(decodeImageBytes(encoded)).toEqual(bytes)
    expect(() => decodeImageBytes(`${encoded.slice(0, -1)}*`)).toThrow()
  })
  it('uploads ordered chunks then verifies the saved image metadata', async () => {
    vi.mocked(callPlugin)
      .mockResolvedValueOnce({ uploadId, chunkSize: IMAGE_CHUNK_BYTES })
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ image })
    const file = new File([png], 'mug.png', { type: 'image/png' })
    expect(await uploadProductImage(file)).toEqual(image)
    expect(vi.mocked(callPlugin).mock.calls.map((call) => call[2])).toEqual([
      'products.upload.begin',
      'products.upload.chunk',
      'products.upload.finish',
    ])
    expect(vi.mocked(callPlugin).mock.calls[1]?.[3]).toEqual({
      uploadId,
      index: 0,
      data: pngBase64,
    })
  })

  it('aborts a partial upload on cancellation without submitting a product', async () => {
    const controller = new AbortController()
    vi.mocked(callPlugin).mockImplementation(async (_id, _capability, method) => {
      if (method === 'products.upload.begin') {
        controller.abort()
        return { uploadId, chunkSize: IMAGE_CHUNK_BYTES }
      }
      if (method === 'products.upload.abort') return { aborted: true }
      throw new Error('Unexpected call')
    })
    await expect(
      uploadProductImage(
        new File([png], 'mug.png', { type: 'image/png' }),
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(vi.mocked(callPlugin).mock.calls.map((call) => call[2])).toEqual([
      'products.upload.begin',
      'products.upload.abort',
    ])
  })

  it('rejects forged upload metadata and discards the uncommitted image', async () => {
    vi.mocked(callPlugin)
      .mockResolvedValueOnce({ uploadId, chunkSize: IMAGE_CHUNK_BYTES })
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ image: { ...image, sha256: '0'.repeat(64) } })
      .mockResolvedValueOnce({ removed: 1 })
    await expect(
      uploadProductImage(new File([png], 'mug.png', { type: 'image/png' })),
    ).rejects.toThrow()
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.products',
      'product.catalog',
      'products.images.discard',
      { ids: [imageId] },
      30_000,
    )
  })

  it.each([
    { next: 0, done: false },
    { next: png.length - 1, done: true },
    { total: png.length + 1, done: true },
    { data: '*invalid*' },
  ])('rejects invalid or nonprogressing chunks: %j', async (patch) => {
    vi.mocked(callPlugin).mockResolvedValue({
      data: pngBase64,
      next: png.length,
      done: true,
      total: png.length,
      ...patch,
    })
    await expect(productImageUrl(image)).rejects.toThrow()
    expect(callPlugin).toHaveBeenCalledTimes(1)
  })

  it('verifies content digest before creating a URL and allows retry after failure', async () => {
    const reply = {
      data: pngBase64,
      next: png.length,
      done: true,
      total: png.length,
    }
    vi.mocked(callPlugin).mockResolvedValue(reply)
    await expect(productImageUrl({ ...image, sha256: '0'.repeat(64) })).rejects.toThrow()
    const url = await productImageUrl(image)
    expect(url.startsWith('blob:')).toBe(true)
    expect(await productImageUrl(image)).toBe(url)
    expect(callPlugin).toHaveBeenCalledTimes(2)
  })
})
