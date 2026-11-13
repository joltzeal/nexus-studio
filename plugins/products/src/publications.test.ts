import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProductAiReplySchema,
  ProductImportReportSchema,
  ProductPageSchema,
  ProductPublicationPageSchema,
  ProductPublicationReplySchema,
  ProductPublicationSchema,
  ProductReplySchema,
  ProductSaveReplySchema,
} from './contracts.js'
import { latestPublication } from './domain/publications.js'
import { createProductsPlugin, type ProductsPluginOptions } from './index.js'
import type { StoreDocument } from './store/private-store.js'

const directories: string[] = []
const instances: ReturnType<typeof createProductsPlugin>[] = []
const recordedAt = '2026-11-13T12:00:00.000Z'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=',
  'base64',
)

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'nexus-products-publications-'))
  directories.push(directory)
  return directory
}

function harness(options: ProductsPluginOptions = {}) {
  const instance = createProductsPlugin({
    now: () => new Date(recordedAt),
    ...options,
    input: new PassThrough(),
    output: new PassThrough(),
    diagnostics: new PassThrough(),
  })
  instances.push(instance)
  const call = (method: string, payload: unknown = {}) =>
    instance.plugin.call({
      requestId: randomUUID(),
      capability: 'product.catalog',
      method,
      payload,
      deadlineAt: Date.now() + 120_000,
      assertAlive() {},
    })
  const create = async (name = 'Publication product', createKey = randomUUID()) =>
    ProductSaveReplySchema.parse(
      await call('products.save', { createKey, data: { name } }),
    ).product
  const get = async (id: string) =>
    ProductReplySchema.parse(await call('products.get', { id })).product
  const history = async (productId: string) =>
    ProductPublicationPageSchema.parse(
      await call('products.publications.list', { productId, pageSize: 50 }),
    ).items
  return { ...instance, call, create, get, history }
}

function publicationInput(productId: string, overrides: Record<string, unknown> = {}) {
  return {
    productId,
    operationId: randomUUID(),
    windowId: randomUUID(),
    windowName: 'Raccoon test window',
    platform: 'test-market',
    listingId: 'synthetic-listing-1',
    listingUrl: 'https://example.invalid/listings/synthetic-listing-1',
    productRevision: 1,
    publishedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(instances.splice(0).map((instance) => instance.stop()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('confirmed product publications', () => {
  it('clamps empty history pages and rejects missing or deleted products', async () => {
    const t = harness()
    const product = await t.create()
    expect(
      ProductPublicationPageSchema.parse(
        await t.call('products.publications.list', { productId: product.id, page: 100 }),
      ),
    ).toEqual({
      productId: product.id,
      productName: product.name,
      productRevision: 1,
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })
    await expect(
      t.call('products.publications.list', { productId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await t.call('products.remove', { id: product.id, expectedRevision: 1 })
    await expect(
      t.call('products.publications.list', { productId: product.id }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('pages history by exact time and UUID with current product metadata and the default 20 items', async () => {
    const t = harness()
    const product = await t.create()
    const ids = Array.from(
      { length: 23 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    )
    await t.store.mutate((document) => {
      const stored = document.products[0]!
      stored.name = 'Renamed product'
      stored.revision = 24
      for (let index = 0; index < 23; index++) {
        const publication = {
          ...publicationInput(product.id, {
            publishedAt:
              index === 21
                ? '2026-11-13T11:00:00.0002Z'
                : index === 22
                  ? '2026-11-13T10:59:59.999Z'
                  : '2026-11-13T11:00:00Z',
          }),
          id: ids[index]!,
          recordedAt,
        }
        Reflect.deleteProperty(publication, 'productId')
        stored.publications.push(publication)
        document.publicationReceipts.push({ productId: stored.id, publication })
      }
    })
    const expected = [ids[21]!, ...ids.slice(0, 21).reverse(), ids[22]!]
    const first = ProductPublicationPageSchema.parse(
      await t.call('products.publications.list', { productId: product.id }),
    )
    const last = ProductPublicationPageSchema.parse(
      await t.call('products.publications.list', { productId: product.id, page: 999 }),
    )
    expect(first).toMatchObject({
      productName: 'Renamed product',
      productRevision: 24,
      total: 23,
      page: 1,
      pageSize: 20,
    })
    expect(first.items.map((entry) => entry.id)).toEqual(expected.slice(0, 20))
    expect(last).toMatchObject({ page: 2, pageSize: 20 })
    expect(last.items.map((entry) => entry.id)).toEqual(expected.slice(20))
    expect((await t.get(product.id)).latestPublication?.id).toBe(ids[21])
    expect(
      ProductPublicationPageSchema.parse(
        await t.call('products.publications.list', {
          productId: product.id,
          page: 999,
          pageSize: 50,
        }),
      ).items.map((entry) => entry.id),
    ).toEqual(expected)
  })

  it('atomically records a confirmed result and replays the same record after restart', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const product = await t.create()
    expect(product).toMatchObject({
      status: 'draft',
      publicationCount: 0,
      latestPublication: null,
    })
    expect(product).not.toHaveProperty('publications')
    const input = publicationInput(product.id)
    const first = await t.call('products.publications.record', input)
    expect(first).toMatchObject({
      alreadyRecorded: false,
      product: {
        id: product.id,
        revision: 2,
        sequence: 1,
        status: 'draft',
        source: { kind: 'manual' },
        images: [],
        publicationCount: 1,
        latestPublication: {
          operationId: input.operationId,
          windowId: input.windowId,
          windowName: input.windowName,
          platform: input.platform,
          listingId: input.listingId,
          listingUrl: input.listingUrl,
          productRevision: 1,
          publishedAt: input.publishedAt,
          recordedAt,
        },
      },
    })
    const saved = ProductPublicationReplySchema.parse(first).product
    expect(saved.latestPublication?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const before = await fs.readFile(join(directory, 'products.json'), 'utf8')
    await t.stop()
    const restarted = harness({
      storageDirectory: directory,
      now: () => new Date('2026-11-14T12:00:00.000Z'),
    })
    expect(await restarted.get(product.id)).toEqual(saved)
    expect(await restarted.history(product.id)).toEqual([saved.latestPublication])
    expect(await restarted.call('products.publications.record', input)).toEqual({
      product: saved,
      alreadyRecorded: true,
    })
    expect(await fs.readFile(join(directory, 'products.json'), 'utf8')).toBe(before)
  })

  it('records an older immutable revision after draft edits and preserves it through later saves', async () => {
    const t = harness()
    const product = await t.create()
    const edited = ProductSaveReplySchema.parse(
      await t.call('products.save', {
        id: product.id,
        expectedRevision: 1,
        data: { name: 'New draft contents', status: 'archived' },
      }),
    ).product
    const input = publicationInput(product.id)
    const published = ProductPublicationReplySchema.parse(
      await t.call('products.publications.record', input),
    ).product
    expect(published).toMatchObject({
      revision: edited.revision + 1,
      name: 'New draft contents',
      status: 'archived',
      publicationCount: 1,
      latestPublication: { productRevision: 1 },
    })
    const saved = ProductSaveReplySchema.parse(
      await t.call('products.save', {
        id: product.id,
        expectedRevision: published.revision,
        data: { name: 'Another draft', status: 'draft' },
      }),
    ).product
    expect(saved.latestPublication).toEqual(published.latestPublication)
    expect(await t.history(product.id)).toEqual([published.latestPublication])
    expect(await t.call('products.publications.record', input)).toEqual({
      product: saved,
      alreadyRecorded: true,
    })
    await expect(
      t.call(
        'products.publications.record',
        publicationInput(product.id, { productRevision: saved.revision + 1 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      t.call('products.save', {
        id: product.id,
        expectedRevision: edited.revision,
        data: { name: 'Stale editor' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await t.get(product.id)).toEqual(saved)
  })

  it.each([
    { windowId: randomUUID() },
    { windowName: 'Changed window snapshot' },
    { windowName: 'Raccoon test window ' },
    { platform: 'another-test-market' },
    { listingId: 'different-listing' },
    { listingUrl: 'https://example.invalid/listings/different-listing' },
    { productRevision: 2 },
    { publishedAt: '2026-11-13T11:00:00.000Z' },
  ])('rejects an operation retry with changed data: %j', async (change) => {
    const t = harness()
    const product = await t.create()
    const input = publicationInput(product.id)
    const first = await t.call('products.publications.record', input)
    await expect(
      t.call('products.publications.record', { ...input, ...change }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await t.get(product.id)).toEqual(
      ProductPublicationReplySchema.parse(first).product,
    )
  })

  it('rejects cross-product operation reuse and duplicate platform/window/listing identities', async () => {
    const t = harness()
    const a = await t.create('A')
    const b = await t.create('B')
    const input = publicationInput(a.id)
    await t.call('products.publications.record', input)
    for (const payload of [
      { ...input, productId: b.id },
      { ...input, operationId: randomUUID() },
      { ...input, productId: b.id, operationId: randomUUID() },
    ])
      await expect(t.call('products.publications.record', payload)).rejects.toMatchObject(
        { code: 'INVALID_REQUEST' },
      )
    expect((await t.get(a.id)).publicationCount).toBe(1)
    expect((await t.get(b.id)).publicationCount).toBe(0)
    for (const change of [
      { platform: 'another-market' },
      { windowId: randomUUID() },
      { listingId: 'another-listing' },
    ])
      await t.call('products.publications.record', {
        ...input,
        ...change,
        operationId: randomUUID(),
      })
    expect((await t.get(a.id)).publicationCount).toBe(4)
  })

  it('serializes concurrent retries and competing operations without duplicate appends', async () => {
    const t = harness()
    const product = await t.create()
    const input = publicationInput(product.id)
    const results = await Promise.all([
      t.call('products.publications.record', input),
      t.call('products.publications.record', input),
    ])
    expect(results[0]).toMatchObject({ alreadyRecorded: false })
    expect(results[1]).toMatchObject({ alreadyRecorded: true })
    expect(ProductPublicationReplySchema.parse(results[0]).product).toEqual(
      ProductPublicationReplySchema.parse(results[1]).product,
    )
    const competing = publicationInput(product.id, { listingId: 'second-listing' })
    const conflicts = await Promise.allSettled([
      t.call('products.publications.record', competing),
      t.call('products.publications.record', {
        ...competing,
        operationId: randomUUID(),
      }),
    ])
    expect(conflicts.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await t.get(product.id)).toMatchObject({
      revision: 3,
      publicationCount: 2,
    })
    expect(
      new Set((await t.history(product.id)).map((entry) => entry.operationId)),
    ).toEqual(new Set([input.operationId, competing.operationId]))
  })

  it('leaves disk and memory unchanged on a failed commit and allows the operation to retry', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const product = await t.create()
    const input = publicationInput(product.id)
    const before = await fs.readFile(join(directory, 'products.json'), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic disk failure'))
    await expect(t.call('products.publications.record', input)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(await t.get(product.id)).toEqual(product)
    expect(await fs.readFile(join(directory, 'products.json'), 'utf8')).toBe(before)
    expect(
      (await fs.readdir(directory)).filter((entry) => entry.endsWith('.tmp')),
    ).toEqual([])
    const restarted = harness({ storageDirectory: directory })
    expect(await restarted.get(product.id)).toEqual(product)
    const retry = await restarted.call('products.publications.record', input)
    expect(retry).toMatchObject({
      alreadyRecorded: false,
      product: {
        revision: 2,
        publicationCount: 1,
        latestPublication: { operationId: input.operationId },
      },
    })
    await restarted.stop()
    expect(
      await harness({ storageDirectory: directory }).call(
        'products.publications.record',
        input,
      ),
    ).toMatchObject({ alreadyRecorded: true, product: { revision: 2 } })
  })

  it('keeps operation and listing tombstones after deletion without replaying a deleted creation', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const createKey = randomUUID()
    const product = await t.create('Deleted publication', createKey)
    const input = publicationInput(product.id)
    const saved = ProductPublicationReplySchema.parse(
      await t.call('products.publications.record', input),
    ).product
    await t.call('products.remove', {
      id: product.id,
      expectedRevision: saved.revision,
    })
    await t.stop()
    const restarted = harness({ storageDirectory: directory })
    const other = await restarted.create('Different product')
    for (const payload of [
      input,
      { ...input, productId: other.id },
      { ...input, productId: other.id, operationId: randomUUID() },
    ])
      await expect(
        restarted.call('products.publications.record', payload),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      restarted.create('Deleted publication', createKey),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await restarted.get(other.id)).toMatchObject({
      publicationCount: 0,
      latestPublication: null,
    })
    expect(
      ProductPageSchema.parse(
        await restarted.call('products.list', { publicationStatus: 'published' }),
      ),
    ).toMatchObject({ total: 0, items: [] })
  })

  it('filters publication history before paging and searches historical window and listing snapshots', async () => {
    const t = harness()
    const unpublished = await t.create('Unpublished')
    const published = await t.create('Published')
    const input = publicationInput(published.id, { windowName: 'Historical window' })
    const first = ProductPublicationReplySchema.parse(
      await t.call('products.publications.record', input),
    ).product
    await t.call(
      'products.publications.record',
      publicationInput(published.id, {
        windowName: 'More recent window',
        listingId: 'recent-synthetic-listing',
        publishedAt: '2026-11-13T11:00:00.000Z',
      }),
    )
    const latest = (await t.get(published.id)).latestPublication
    for (let index = 0; index < 22; index++) await t.create(`Other ${index}`)
    const page = ProductPageSchema.parse(
      await t.call('products.list', {
        publicationStatus: 'unpublished',
        page: 2,
      }),
    )
    expect(page).toMatchObject({ total: 23, page: 2 })
    expect(page.items).toHaveLength(3)
    expect(page.items.at(-1)).toMatchObject({
      id: unpublished.id,
      publicationCount: 0,
      latestPublication: null,
    })
    for (const query of ['HISTORICAL WINDOW', input.windowId, input.listingId]) {
      const filtered = await t.call('products.list', {
        publicationStatus: 'published',
        status: 'draft',
        sourceKind: 'manual',
        query,
      })
      expect(filtered).toMatchObject({
        total: 1,
        items: [
          {
            id: published.id,
            publicationCount: 2,
            latestPublication: latest,
          },
        ],
      })
      const parsed = ProductPageSchema.parse(filtered)
      expect(parsed.items[0]).not.toHaveProperty('publications')
    }
    expect(await t.history(published.id)).toContainEqual(first.latestPublication)
    expect(
      ProductPageSchema.parse(
        await t.call('products.list', { publicationStatus: 'published', page: 10 }),
      ),
    ).toMatchObject({ total: 1, page: 1 })
  })

  it('selects the latest by publication time with a deterministic UUID tie rather than append order', async () => {
    const t = harness()
    const product = await t.create()
    for (const publishedAt of [
      '2026-11-13T11:00:00Z',
      '2026-11-13T11:00:00.000Z',
      '2026-11-13T10:59:59.999Z',
    ]) {
      ProductPublicationReplySchema.parse(
        await t.call(
          'products.publications.record',
          publicationInput(product.id, { publishedAt }),
        ),
      )
    }
    const publications = (await t.store.read()).products[0]!.publications
    const expected = [publications[0]!, publications[1]!].sort((a, b) =>
      a.id.localeCompare(b.id),
    )[1]!
    const page = ProductPageSchema.parse(await t.call('products.list'))
    expect(page.items[0]).toMatchObject({
      revision: 4,
      publicationCount: 3,
      latestPublication: expected,
    })
    expect(page.items[0]).not.toHaveProperty('publications')
  })

  it('retains publication history and file receipts through edits, reimport, and deletion', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const input = { format: 'csv', content: 'name,sku\nImported,SYNTHETIC-SKU\n' }
    expect(
      ProductImportReportSchema.parse(await t.call('products.import', input)),
    ).toMatchObject({ inserted: 1 })
    const product = ProductPageSchema.parse(await t.call('products.list')).items[0]!
    const published = ProductPublicationReplySchema.parse(
      await t.call('products.publications.record', publicationInput(product.id)),
    ).product
    const edited = ProductSaveReplySchema.parse(
      await t.call('products.save', {
        id: product.id,
        expectedRevision: published.revision,
        data: { name: 'Edited imported product' },
      }),
    ).product
    await t.stop()
    const restarted = harness({ storageDirectory: directory })
    expect(await restarted.call('products.import', input)).toMatchObject({
      inserted: 0,
      skipped: 1,
    })
    expect(await restarted.get(product.id)).toEqual(edited)
    expect(edited.latestPublication).toEqual(published.latestPublication)
    expect(await restarted.history(product.id)).toEqual([published.latestPublication])
    expect(edited.source).toEqual(published.source)
    await restarted.call('products.remove', {
      id: product.id,
      expectedRevision: edited.revision,
    })
    expect(await restarted.call('products.import', input)).toMatchObject({
      inserted: 0,
      skipped: 1,
    })
  })

  it('retains AI source receipts and owned images when a published import is retried', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const image = await t.store.putImage(png, { mime: 'image/png', name: 'test.png' })
    const input = {
      recordId: 'synthetic-publication-source',
      data: { name: 'AI import', imageIds: [image.id] },
    }
    const imported = ProductAiReplySchema.parse(
      await t.call('products.importAi', input),
    ).product
    const published = ProductPublicationReplySchema.parse(
      await t.call('products.publications.record', publicationInput(imported.id)),
    ).product
    await t.stop()
    const restarted = harness({ storageDirectory: directory })
    expect(await restarted.call('products.importAi', input)).toEqual({
      product: published,
      alreadyImported: true,
    })
    expect(
      await restarted.call('products.sources.find', { recordId: input.recordId }),
    ).toEqual({ product: published })
    expect((await restarted.store.read()).products[0]?.images).toEqual([image])
    await restarted.call('products.remove', {
      id: imported.id,
      expectedRevision: published.revision,
    })
    expect(await fs.readdir(join(directory, 'images'))).toEqual([])
    expect(
      await restarted.call('products.sources.find', { recordId: input.recordId }),
    ).toEqual({ product: null })
    await expect(restarted.call('products.importAi', input)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('does not let ordinary saves or imports author or clear publication records', async () => {
    const t = harness()
    const product = await t.create()
    const saved = ProductPublicationReplySchema.parse(
      await t.call('products.publications.record', publicationInput(product.id)),
    ).product
    await expect(
      t.call('products.save', {
        id: product.id,
        expectedRevision: saved.revision,
        data: { name: 'Clear publications', publications: [] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(
      await t.call('products.import', {
        format: 'json',
        content: JSON.stringify([{ name: 'Injected publication', publications: [] }]),
      }),
    ).toMatchObject({ inserted: 0, skipped: 1, errors: [{ row: 1 }] })
    expect(await t.get(product.id)).toEqual(saved)
  })

  it('prevents a cancelled publication from committing after writing its temporary file', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const product = await t.create()
    const input = publicationInput(product.id)
    const before = await fs.readFile(join(directory, 'products.json'), 'utf8')
    const controller = new AbortController()
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode)
      if (String(path).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          await sync()
          controller.abort()
        }
      }
      return handle
    })
    await expect(
      t.plugin.call({
        requestId: randomUUID(),
        capability: 'product.catalog',
        method: 'products.publications.record',
        payload: input,
        deadlineAt: Date.now() + 120_000,
        assertAlive() {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await t.get(product.id)).toEqual(product)
    expect(await fs.readFile(join(directory, 'products.json'), 'utf8')).toBe(before)
    expect(
      (await fs.readdir(directory)).filter((entry) => entry.endsWith('.tmp')),
    ).toEqual([])
    vi.restoreAllMocks()
    expect(await t.call('products.publications.record', input)).toMatchObject({
      alreadyRecorded: false,
      product: { revision: 2 },
    })
  })

  const corruptions: {
    name: string
    change: (document: StoreDocument) => void
  }[] = [
    {
      name: 'missing product history',
      change: (document) => {
        Reflect.deleteProperty(document.products[0]!, 'publications')
      },
    },
    {
      name: 'missing publication receipts',
      change: (document) => {
        Reflect.deleteProperty(document, 'publicationReceipts')
      },
    },
    {
      name: 'history without its receipt',
      change: (document) => {
        document.publicationReceipts = []
      },
    },
    {
      name: 'receipt without its live history',
      change: (document) => {
        document.products[0]!.publications = []
      },
    },
    {
      name: 'receipt snapshot mismatch',
      change: (document) => {
        document.publicationReceipts[0]!.publication.windowName = 'Changed on disk'
      },
    },
    {
      name: 'duplicate history entry',
      change: (document) => {
        document.products[0]!.publications.push(
          structuredClone(document.products[0]!.publications[0]!),
        )
      },
    },
    {
      name: 'duplicate receipt ID',
      change: (document) => {
        document.publicationReceipts.push(
          structuredClone(document.publicationReceipts[0]!),
        )
      },
    },
    {
      name: 'duplicate operation ID',
      change: (document) => {
        const duplicate = structuredClone(document.publicationReceipts[0]!)
        duplicate.publication.id = randomUUID()
        duplicate.publication.listingId = 'another-listing'
        document.publicationReceipts.push(duplicate)
      },
    },
    {
      name: 'duplicate listing identity',
      change: (document) => {
        const duplicate = structuredClone(document.publicationReceipts[0]!)
        duplicate.publication.id = randomUUID()
        duplicate.publication.operationId = randomUUID()
        document.publicationReceipts.push(duplicate)
      },
    },
    {
      name: 'future snapshot revision',
      change: (document) => {
        document.products[0]!.publications[0]!.productRevision = 3
        document.publicationReceipts[0]!.publication.productRevision = 3
      },
    },
    {
      name: 'publication tombstone without any product source receipt',
      change: (document) => {
        document.products = []
        document.receipts = []
      },
    },
  ]

  it.each(corruptions)(
    'rejects $name on restart without resetting or overwriting the file',
    async ({ change }) => {
      const directory = await temporaryDirectory()
      const t = harness({ storageDirectory: directory })
      const product = await t.create()
      await t.call('products.publications.record', publicationInput(product.id))
      const document = await t.store.read()
      change(document)
      await t.stop()
      const file = join(directory, 'products.json')
      const corrupted = JSON.stringify(document)
      await fs.writeFile(file, corrupted)
      const restarted = harness({ storageDirectory: directory })
      await expect(restarted.call('products.list')).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
      await expect(restarted.create('Must not overwrite')).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
      expect(await fs.readFile(file, 'utf8')).toBe(corrupted)
    },
  )
})

describe('publication chronology', () => {
  it('orders ISO instants at their full fractional precision before breaking ties by UUID', () => {
    const earlier = ProductPublicationSchema.parse({
      id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      operationId: randomUUID(),
      windowId: randomUUID(),
      windowName: 'Precision test window',
      platform: 'test-market',
      listingId: 'earlier',
      listingUrl: 'https://example.invalid/earlier',
      productRevision: 1,
      publishedAt: '2026-11-13T10:00:00.0001Z',
      recordedAt,
    })
    const later = {
      ...earlier,
      id: '00000000-0000-4000-8000-000000000000',
      listingId: 'later',
      publishedAt: '2026-11-13T10:00:00.0002Z',
    }
    expect(latestPublication([earlier, later])).toEqual(later)
    expect(latestPublication([later, earlier])).toEqual(later)
  })
})
