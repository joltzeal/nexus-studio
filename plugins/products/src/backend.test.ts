import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IMAGE_CHUNK_BYTES,
  ImageChunkSchema,
  ProductAiReplySchema,
  ProductImportReportSchema,
  ProductPageSchema,
  ProductReplySchema,
  ProductSaveReplySchema,
  UploadBeginReplySchema,
  UploadChunkReplySchema,
  UploadFinishReplySchema,
} from './contracts.js'
import { createFileStore, createMemoryStore, createProductsPlugin } from './index.js'
import type { ProductsPluginOptions } from './index.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=',
  'base64',
)
const directories: string[] = []
const instances: ReturnType<typeof createProductsPlugin>[] = []

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'nexus-products-'))
  directories.push(directory)
  return directory
}

function harness(options: ProductsPluginOptions = {}) {
  const instance = createProductsPlugin({
    ...options,
    input: new PassThrough(),
    output: new PassThrough(),
    diagnostics: new PassThrough(),
  })
  instances.push(instance)
  const call = (method: string, payload: unknown = {}, assertAlive = () => {}) =>
    instance.plugin.call({
      requestId: randomUUID(),
      capability: 'product.catalog',
      method,
      payload,
      deadlineAt: Date.now() + 120_000,
      assertAlive,
    })
  const save = async (data: unknown, extra: Record<string, unknown> = {}) =>
    ProductSaveReplySchema.parse(
      await call('products.save', { createKey: randomUUID(), data, ...extra }),
    )
  const upload = async (bytes = png, mime = 'image/png', name = 'photo.png') => {
    const begin = UploadBeginReplySchema.parse(
      await call('products.upload.begin', { mime, size: bytes.length }),
    )
    for (let offset = 0, index = 0; offset < bytes.length; offset += begin.chunkSize) {
      expect(
        UploadChunkReplySchema.parse(
          await call('products.upload.chunk', {
            uploadId: begin.uploadId,
            index: index++,
            data: bytes.subarray(offset, offset + begin.chunkSize).toString('base64'),
          }),
        ),
      ).toEqual({ accepted: true })
    }
    return UploadFinishReplySchema.parse(
      await call('products.upload.finish', { uploadId: begin.uploadId, name }),
    ).image
  }
  return { ...instance, call, save, upload }
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

describe('product catalog transactions', () => {
  it('saves incomplete drafts without category and rejects incomplete ready products', async () => {
    const t = harness({ store: createMemoryStore() })
    const { product, alreadySaved } = await t.save({ name: 'Draft' })
    expect(alreadySaved).toBe(false)
    expect(product).toMatchObject({
      name: 'Draft',
      category: '',
      description: '',
      price: null,
      images: [],
      revision: 1,
      sequence: 1,
      source: { kind: 'manual' },
    })
    await expect(t.save({ name: 'Incomplete', status: 'ready' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    const image = await t.upload()
    const ready = await t.save({
      name: 'Complete',
      title: 'Listing',
      description: 'Description',
      price: 15,
      condition: 'Good',
      imageIds: [image.id],
      status: 'ready',
    })
    expect(ready.product.status).toBe('ready')
    expect(ready.product.category).toBe('')
  })

  it('replays a creation key with the latest hand edits and rejects stale edits and deletes', async () => {
    const t = harness()
    const createKey = randomUUID()
    const first = await t.save({ name: 'Original' }, { createKey })
    const updated = ProductSaveReplySchema.parse(
      await t.call('products.save', {
        id: first.product.id,
        expectedRevision: 1,
        data: { name: 'Hand edit', description: 'Keep this' },
      }),
    )
    expect(updated.product).toMatchObject({
      id: first.product.id,
      revision: 2,
      sequence: 1,
      name: 'Hand edit',
    })
    const replay = await t.save({ name: 'Original' }, { createKey })
    expect(replay).toEqual({ product: updated.product, alreadySaved: true })
    await expect(
      t.call('products.save', {
        id: first.product.id,
        expectedRevision: 1,
        data: { name: 'Stale' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      t.call('products.remove', { id: first.product.id, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(
      ProductReplySchema.parse(await t.call('products.get', { id: first.product.id }))
        .product,
    ).toEqual(updated.product)
  })

  it('serializes competing revisions so only one edit can commit', async () => {
    const t = harness()
    const { product } = await t.save({ name: 'Before' })
    const results = await Promise.allSettled(
      ['A', 'B'].map((name) =>
        t.call('products.save', { id: product.id, expectedRevision: 1, data: { name } }),
      ),
    )
    expect(results.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected'])
    expect(
      ProductReplySchema.parse(await t.call('products.get', { id: product.id })).product,
    ).toMatchObject({ name: 'A', revision: 2 })
  })

  it('filters before paging, clamps pages, and projects compact summaries in sequence order', async () => {
    const t = harness({ now: () => new Date('2026-11-13T00:00:00.000Z') })
    for (let index = 0; index < 25; index++)
      await t.save({
        name: `Product ${index}`,
        status: index % 2 ? 'draft' : 'archived',
        note: index % 2 ? 'needle' : '',
        description: 'Private long detail',
      })
    const page = ProductPageSchema.parse(await t.call('products.list', { page: 2 }))
    expect(page.items.map((entry) => entry.sequence)).toEqual([5, 4, 3, 2, 1])
    expect(page.total).toBe(25)
    expect(page.storageDurable).toBe(false)
    expect(page.items[0]).not.toHaveProperty('description')
    expect(page.items[0]).not.toHaveProperty('note')
    expect(page.items[0]).toMatchObject({ cover: null, imageCount: 0 })
    const filtered = ProductPageSchema.parse(
      await t.call('products.list', {
        query: 'NEEDLE',
        status: 'draft',
        sourceKind: 'manual',
        page: 100,
        pageSize: 50,
      }),
    )
    expect(filtered).toMatchObject({ total: 12, page: 1, pageSize: 50 })
    expect(filtered.items[0]?.sequence).toBe(24)
    expect(
      ProductPageSchema.parse(
        await t.call('products.list', { query: 'absent', page: 50 }),
      ),
    ).toMatchObject({ total: 0, page: 1, items: [] })
  })

  it('checks cancellation again inside queued mutations without consuming a sequence', async () => {
    const t = harness()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = t.store.mutate(async () => {
      entered()
      await gate
    })
    await blocked
    let cancelled = false
    const pending = t.call(
      'products.save',
      { createKey: randomUUID(), data: { name: 'Must not save' } },
      () => {
        if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' })
      },
    )
    cancelled = true
    release()
    await previous
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect((await t.save({ name: 'First actual save' })).product.sequence).toBe(1)
  })

  it('rejects missing image IDs instead of publishing a broken reference', async () => {
    const t = harness()
    await expect(
      t.save({ name: 'Broken', imageIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(ProductPageSchema.parse(await t.call('products.list', {})).total).toBe(0)
  })

  it('enforces an elapsed deadline even if a direct caller supplies a no-op guard', async () => {
    const t = harness()
    await expect(
      t.plugin.call({
        requestId: randomUUID(),
        capability: 'product.catalog',
        method: 'products.save',
        payload: { createKey: randomUUID(), data: { name: 'Expired' } },
        deadlineAt: Date.now() - 1,
        assertAlive() {},
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect((await t.store.read()).products).toEqual([])
  })
})

describe('owned image persistence', () => {
  it('keeps bytes, hashes, revisions, and idempotency across a real directory restart', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const image = await t.upload()
    const createKey = randomUUID()
    const { product } = await t.save(
      { name: 'Durable', imageIds: [image.id] },
      { createKey },
    )
    expect(image).toMatchObject({
      bytes: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    })
    const restarted = harness({ store: createFileStore(directory) })
    expect(await restarted.save({ name: 'Retry' }, { createKey })).toEqual({
      product,
      alreadySaved: true,
    })
    const result = ImageChunkSchema.parse(
      await restarted.call('products.images.read', {
        imageId: image.id,
        offset: 0,
        length: 17,
      }),
    )
    expect(result).toEqual({
      data: png.subarray(0, 17).toString('base64'),
      next: 17,
      done: false,
      total: png.length,
    })
    expect(
      ProductPageSchema.parse(await restarted.call('products.list', {})).storageDurable,
    ).toBe(true)
  })

  it('never discards shared references and deletes bytes only after the final product commit', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const shared = await t.upload()
    const unused = await t.upload()
    const a = (await t.save({ name: 'A', imageIds: [shared.id] })).product
    const b = (await t.save({ name: 'B', imageIds: [shared.id] })).product
    expect(
      await t.call('products.images.discard', { ids: [shared.id, unused.id] }),
    ).toEqual({ removed: 1 })
    await t.call('products.remove', { id: a.id, expectedRevision: a.revision })
    expect(
      ImageChunkSchema.parse(
        await t.call('products.images.read', { imageId: shared.id, offset: 0 }),
      ).data,
    ).toBe(png.toString('base64'))
    await t.call('products.remove', { id: b.id, expectedRevision: b.revision })
    expect(await fs.readdir(join(directory, 'images'))).toEqual([])
    await expect(
      t.call('products.images.read', { imageId: shared.id, offset: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('preserves the prior document and image bytes when the atomic document rename fails', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const image = await t.upload()
    const { product } = await t.save({ name: 'Keep', imageIds: [image.id] })
    const before = await fs.readFile(join(directory, 'products.json'), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic disk failure'))
    await expect(
      t.call('products.remove', { id: product.id, expectedRevision: product.revision }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await fs.readFile(join(directory, 'products.json'), 'utf8')).toBe(before)
    expect(await fs.readdir(join(directory, 'images'))).toHaveLength(1)
    const restarted = harness({ storageDirectory: directory })
    expect(
      ProductReplySchema.parse(await restarted.call('products.get', { id: product.id }))
        .product,
    ).toEqual(product)
  })

  it('rolls back a failed image catalog commit and never publishes its bytes', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    await t.save({ name: 'Existing' })
    const before = await fs.readFile(join(directory, 'products.json'), 'utf8')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('products.json')) throw new Error('disk failure')
      return rename(from, to)
    })
    await expect(t.upload()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await fs.readFile(join(directory, 'products.json'), 'utf8')).toBe(before)
    expect(await fs.readdir(join(directory, 'images'))).toEqual([])
  })

  it('checks cancellation after writing a temporary document and before publishing the rename', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const image = await t.upload()
    const { product } = await t.save({ name: 'Keep', imageIds: [image.id] })
    const before = await fs.readFile(join(directory, 'products.json'), 'utf8')
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode)
      if (String(path).includes('products.json.') && String(path).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          await sync()
          entered()
          await gate
        }
      }
      return handle
    })
    const controller = new AbortController()
    const pending = t.plugin.call({
      requestId: randomUUID(),
      capability: 'product.catalog',
      method: 'products.remove',
      payload: { id: product.id, expectedRevision: 1 },
      deadlineAt: Date.now() + 120_000,
      assertAlive() {},
      signal: controller.signal,
    })
    await enteredPromise
    controller.abort()
    release()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await fs.readFile(join(directory, 'products.json'), 'utf8')).toBe(before)
    expect(await fs.readdir(join(directory, 'images'))).toHaveLength(1)
    expect(
      (await fs.readdir(directory)).filter((entry) => entry.endsWith('.tmp')),
    ).toEqual([])
    expect(
      ProductReplySchema.parse(await t.call('products.get', { id: product.id })).product,
    ).toEqual(product)
  })

  it('commits a file import as one transaction and does not consume rows or sequences on failure', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    await t.save({ name: 'Existing' })
    const before = await fs.readFile(join(directory, 'products.json'), 'utf8')
    const input = { format: 'csv', content: 'name,sku\nFirst,ONE\nSecond,TWO\n' }
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic disk failure'))
    await expect(t.call('products.import', input)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(await fs.readFile(join(directory, 'products.json'), 'utf8')).toBe(before)
    const restarted = harness({ storageDirectory: directory })
    expect(
      ProductImportReportSchema.parse(await restarted.call('products.import', input)),
    ).toEqual({ total: 2, inserted: 2, skipped: 0, errors: [] })
    expect(
      ProductPageSchema.parse(await restarted.call('products.list', {})).items.map(
        (entry) => entry.sequence,
      ),
    ).toEqual([3, 2, 1])
  })

  it('does not trust claimed image hashes or mismatched reference metadata after restart', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const image = await t.upload()
    const { product } = await t.save({ name: 'Original', imageIds: [image.id] })
    const file = join(directory, 'products.json')
    const document = await t.store.read()
    document.images[0]!.sha256 = '0'.repeat(64)
    document.products[0]!.images[0]!.sha256 = '0'.repeat(64)
    await fs.writeFile(file, JSON.stringify(document))
    await expect(
      harness({ storageDirectory: directory }).call('products.get', { id: product.id }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    document.images[0]!.bytes++
    await fs.writeFile(file, JSON.stringify(document))
    const corrupted = await fs.readFile(file, 'utf8')
    await expect(
      harness({ storageDirectory: directory }).save({ name: 'Must not reset' }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await fs.readFile(file, 'utf8')).toBe(corrupted)
  })

  it('reports corrupt documents, missing files, changed bytes, and symlinks without resetting data', async () => {
    const directory = await temporaryDirectory()
    await fs.writeFile(join(directory, 'products.json'), '{corrupt')
    const corrupt = harness({ storageDirectory: directory })
    await expect(corrupt.call('products.list', {})).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(await fs.readFile(join(directory, 'products.json'), 'utf8')).toBe('{corrupt')
    await fs.rm(join(directory, 'products.json'))
    const t = harness({ storageDirectory: directory })
    const image = await t.upload()
    const { product } = await t.save({ name: 'Referenced', imageIds: [image.id] })
    const file = join(directory, 'images', `${image.id}.bin`)
    await fs.writeFile(file, Buffer.alloc(png.length))
    await expect(
      t.call('products.images.read', { imageId: image.id, offset: 0 }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await fs.rm(file)
    await expect(t.call('products.get', { id: product.id })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    const outside = join(await temporaryDirectory(), 'outside.png')
    await fs.writeFile(outside, png)
    await fs.symlink(outside, file)
    await expect(
      t.call('products.images.read', { imageId: image.id, offset: 0 }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await fs.readFile(outside)).toEqual(png)
  })

  it('rejects symlink document and image directories', async () => {
    const directory = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await fs.writeFile(join(outside, 'document'), '{}')
    await fs.symlink(join(outside, 'document'), join(directory, 'products.json'))
    await expect(
      harness({ storageDirectory: directory }).call('products.list', {}),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await fs.rm(join(directory, 'products.json'))
    await fs.symlink(outside, join(directory, 'images'))
    await expect(harness({ storageDirectory: directory }).upload()).rejects.toMatchObject(
      { code: 'UNAVAILABLE' },
    )
    expect(await fs.readdir(outside)).toEqual(['document'])
  })
})

describe('AI import idempotency', () => {
  it('deduplicates a source across restarts without overwriting hand edits or recreating a deletion', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const image = await t.upload()
    const input = {
      recordId: 'generation-record-1',
      origin: { pluginId: 'studio.shared-supply', itemId: '1', title: 'Source', url: '' },
      data: { name: 'Generated', title: 'AI title', imageIds: [image.id] },
    }
    const imported = ProductAiReplySchema.parse(await t.call('products.importAi', input))
    expect(imported.alreadyImported).toBe(false)
    expect(imported.product.source).toEqual({
      kind: 'ai-image',
      recordId: input.recordId,
      origin: input.origin,
    })
    await t.call('products.save', {
      id: imported.product.id,
      expectedRevision: 1,
      data: { name: 'Hand edited', imageIds: [image.id], note: 'Preserve' },
    })
    const restarted = harness({ storageDirectory: directory })
    const duplicate = ProductAiReplySchema.parse(
      await restarted.call('products.importAi', input),
    )
    expect(duplicate).toMatchObject({
      alreadyImported: true,
      product: {
        id: imported.product.id,
        revision: 2,
        name: 'Hand edited',
        note: 'Preserve',
      },
    })
    expect(
      await restarted.call('products.sources.find', { recordId: input.recordId }),
    ).toEqual({ product: duplicate.product })
    expect(
      ProductPageSchema.parse(
        await restarted.call('products.list', { sourceKind: 'ai-image' }),
      ).total,
    ).toBe(1)
    await restarted.call('products.remove', {
      id: imported.product.id,
      expectedRevision: 2,
    })
    expect(
      await restarted.call('products.sources.find', { recordId: input.recordId }),
    ).toEqual({ product: null })
    await expect(
      harness({ storageDirectory: directory }).call('products.importAi', input),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('does not return phantom success when a deleted create key is retried', async () => {
    const t = harness()
    const createKey = randomUUID()
    const { product } = await t.save({ name: 'Gone' }, { createKey })
    await t.call('products.remove', { id: product.id, expectedRevision: 1 })
    await expect(t.save({ name: 'Gone' }, { createKey })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(
      await t.call('products.remove', { id: product.id, expectedRevision: 1 }),
    ).toEqual({ id: product.id, removed: false })
  })
})

describe('bounded image uploads', () => {
  async function pendingUpload(t: ReturnType<typeof harness>) {
    const { uploadId } = UploadBeginReplySchema.parse(
      await t.call('products.upload.begin', { mime: 'image/png', size: png.length }),
    )
    await t.call('products.upload.chunk', {
      uploadId,
      index: 0,
      data: png.toString('base64'),
    })
    return { uploadId, name: 'recoverable.png' }
  }

  it('returns the same finished image on retry, including after a real directory restart', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const input = await pendingUpload(t)
    const first = UploadFinishReplySchema.parse(
      await t.call('products.upload.finish', input),
    )
    expect(
      await t.call('products.upload.finish', { ...input, name: 'retry.png' }),
    ).toEqual(first)
    const restarted = harness({ storageDirectory: directory })
    expect(await restarted.call('products.upload.finish', input)).toEqual(first)
    expect((await restarted.store.read()).images).toEqual([first.image])
    expect(await fs.readdir(join(directory, 'images'))).toEqual([`${first.image.id}.bin`])
  })

  it.each([false, true])(
    'recovers a lost finish reply through abort and leaves no indexed image (restart before abort: %s)',
    async (restartBeforeAbort) => {
      const directory = await temporaryDirectory()
      const t = harness({ storageDirectory: directory })
      const input = await pendingUpload(t)
      await t.call('products.upload.finish', input)
      const aborting = restartBeforeAbort ? harness({ storageDirectory: directory }) : t
      expect(
        await aborting.call('products.upload.abort', { uploadId: input.uploadId }),
      ).toEqual({ aborted: true })
      const restarted = harness({ storageDirectory: directory })
      expect((await restarted.store.read()).images).toEqual([])
      expect((await restarted.store.read()).uploadReceipts).toEqual([])
      expect(await fs.readdir(join(directory, 'images'))).toEqual([])
      expect(
        await restarted.call('products.upload.abort', { uploadId: input.uploadId }),
      ).toEqual({ aborted: false })
      await expect(restarted.call('products.upload.finish', input)).rejects.toMatchObject(
        { code: 'INVALID_REQUEST' },
      )
    },
  )

  it('clears cleanup authority at product commit so a late upload abort retains the image', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const input = await pendingUpload(t)
    const { image } = UploadFinishReplySchema.parse(
      await t.call('products.upload.finish', input),
    )
    const { product } = await t.save({ name: 'Committed', imageIds: [image.id] })
    const restarted = harness({ storageDirectory: directory })
    expect((await restarted.store.read()).uploadReceipts).toEqual([])
    expect(
      await restarted.call('products.upload.abort', { uploadId: input.uploadId }),
    ).toEqual({ aborted: false })
    expect(
      ProductReplySchema.parse(await restarted.call('products.get', { id: product.id }))
        .product,
    ).toEqual(product)
    expect(
      ImageChunkSchema.parse(
        await restarted.call('products.images.read', {
          imageId: image.id,
          offset: 0,
        }),
      ).data,
    ).toBe(png.toString('base64'))
  })

  it('clears finished upload receipts when unused images are explicitly discarded', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const input = await pendingUpload(t)
    const { image } = UploadFinishReplySchema.parse(
      await t.call('products.upload.finish', input),
    )
    expect(await t.call('products.images.discard', { ids: [image.id] })).toEqual({
      removed: 1,
    })
    const restarted = harness({ storageDirectory: directory })
    expect((await restarted.store.read()).uploadReceipts).toEqual([])
    await expect(restarted.call('products.upload.finish', input)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('preserves a finished upload for a later abort retry when cleanup cannot commit', async () => {
    const directory = await temporaryDirectory()
    const t = harness({ storageDirectory: directory })
    const input = await pendingUpload(t)
    const { image } = UploadFinishReplySchema.parse(
      await t.call('products.upload.finish', input),
    )
    const before = await fs.readFile(join(directory, 'products.json'), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic disk failure'))
    await expect(
      t.call('products.upload.abort', { uploadId: input.uploadId }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await fs.readFile(join(directory, 'products.json'), 'utf8')).toBe(before)
    expect(await fs.readdir(join(directory, 'images'))).toEqual([`${image.id}.bin`])
    const restarted = harness({ storageDirectory: directory })
    expect(
      await restarted.call('products.upload.abort', { uploadId: input.uploadId }),
    ).toEqual({ aborted: true })
    expect((await restarted.store.read()).images).toEqual([])
    expect((await restarted.store.read()).uploadReceipts).toEqual([])
  })

  it('requires canonical base64, ordered full chunks, and an exact declared length', async () => {
    const t = harness()
    const { uploadId, chunkSize } = UploadBeginReplySchema.parse(
      await t.call('products.upload.begin', {
        mime: 'image/png',
        size: IMAGE_CHUNK_BYTES + png.length,
      }),
    )
    expect(chunkSize).toBe(192 * 1024)
    for (const payload of [
      { index: 1, data: png.toString('base64') },
      { index: 0, data: 'YQ=' },
      { index: 0, data: 'YQ==\n' },
      { index: 0, data: 'YR==' },
      { index: 0, data: png.toString('base64') },
    ])
      await expect(
        t.call('products.upload.chunk', { uploadId, ...payload }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      t.call('products.upload.finish', { uploadId, name: 'early.png' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const first = Buffer.alloc(IMAGE_CHUNK_BYTES)
    png.copy(first)
    expect(
      await t.call('products.upload.chunk', {
        uploadId,
        index: 0,
        data: first.toString('base64'),
      }),
    ).toEqual({ accepted: true })
    await expect(
      t.call('products.upload.chunk', {
        uploadId,
        index: 0,
        data: first.toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await t.call('products.upload.chunk', {
      uploadId,
      index: 1,
      data: png.toString('base64'),
    })
    expect(
      UploadFinishReplySchema.parse(
        await t.call('products.upload.finish', { uploadId, name: 'large.png' }),
      ).image.bytes,
    ).toBe(IMAGE_CHUNK_BYTES + png.length)
  })

  it('validates PNG/JPEG/WebP signatures rather than claimed MIME or filename', async () => {
    const t = harness()
    await expect(t.upload(Buffer.from('<svg></svg>'))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(t.upload(png, 'image/jpeg', 'looks-like.jpg')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([12, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(4),
    ])
    expect((await t.upload(jpeg, 'image/jpeg', '../../filename.jpg')).mime).toBe(
      'image/jpeg',
    )
    expect((await t.upload(webp, 'image/webp', 'sample.webp')).mime).toBe('image/webp')
  })

  it('allows four sessions, frees aborted sessions, and expires abandoned sessions', async () => {
    let now = new Date('2026-11-13T00:00:00.000Z')
    const t = harness({ now: () => now })
    const starts = []
    for (let index = 0; index < 4; index++)
      starts.push(
        UploadBeginReplySchema.parse(
          await t.call('products.upload.begin', { mime: 'image/png', size: png.length }),
        ),
      )
    await expect(
      t.call('products.upload.begin', { mime: 'image/png', size: png.length }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(
      await t.call('products.upload.abort', { uploadId: starts[0]!.uploadId }),
    ).toEqual({ aborted: true })
    expect(
      await t.call('products.upload.abort', { uploadId: starts[0]!.uploadId }),
    ).toEqual({ aborted: false })
    await t.call('products.upload.begin', { mime: 'image/png', size: png.length })
    now = new Date(now.getTime() + 60 * 60_000)
    await expect(
      t.call('products.upload.chunk', {
        uploadId: starts[1]!.uploadId,
        index: 0,
        data: png.toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(t.upload()).resolves.toMatchObject({ bytes: png.length })
  })

  it('aborts a finishing upload while it is queued and leaves no published image', async () => {
    const t = harness()
    const { uploadId } = UploadBeginReplySchema.parse(
      await t.call('products.upload.begin', { mime: 'image/png', size: png.length }),
    )
    await t.call('products.upload.chunk', {
      uploadId,
      index: 0,
      data: png.toString('base64'),
    })
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocker = t.store.mutate(async () => {
      entered()
      await gate
    })
    await enteredPromise
    const finishing = t.call('products.upload.finish', { uploadId, name: 'cancel.png' })
    const aborting = t.call('products.upload.abort', { uploadId })
    release()
    expect(await aborting).toEqual({ aborted: true })
    await blocker
    await expect(finishing).rejects.toMatchObject({ code: 'CANCELLED' })
    expect((await t.store.read()).images).toEqual([])
  })
})
