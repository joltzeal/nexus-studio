import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProductAiReplySchema,
  ProductPageSchema,
  ProductPublicationPageSchema,
  ProductPublicationReplySchema,
  ProductPublicationSchema,
  ProductReplySchema,
  ProductSaveReplySchema,
  ProductSourceReplySchema,
} from '../contracts.js'
import { startProductsPlugin, type ProductsPluginOptions } from '../index.js'
import { DEFAULT_MAX_LINE_BYTES } from './protocol.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=',
  'base64',
)
const directories: string[] = []
const cleanups: (() => Promise<void>)[] = []

interface RpcReply {
  requestId: string
  ok: boolean
  result?: unknown
  error?: { code: string }
}

function harness(options: ProductsPluginOptions = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const diagnostics = new PassThrough()
  const pending = new Map<string, (reply: RpcReply) => void>()
  const sizes: number[] = []
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  output.on('data', (bytes: Buffer) => {
    buffered += decoder.write(bytes)
    let newline: number
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      const reply = JSON.parse(line) as RpcReply
      sizes.push(Buffer.byteLength(line, 'utf8') + 1)
      pending.get(reply.requestId)?.(reply)
      pending.delete(reply.requestId)
    }
  })
  const instance = startProductsPlugin({ ...options, input, output, diagnostics })
  input.write('{"type":"handshake","protocolVersion":1}\n')
  cleanups.push(async () => {
    await instance.stop()
    input.destroy()
    output.destroy()
    diagnostics.destroy()
  })
  const call = (method: string, payload: unknown) =>
    new Promise<RpcReply>((resolve) => {
      const requestId = randomUUID()
      pending.set(requestId, resolve)
      input.write(
        `${JSON.stringify({
          protocolVersion: 1,
          requestId,
          capability: 'product.catalog',
          method,
          deadlineMs: 5000,
          payload,
        })}\n`,
      )
    })
  const success = async (method: string, payload: unknown) => {
    const reply = await call(method, payload)
    expect(reply).toMatchObject({ ok: true })
    expect(sizes.at(-1)).toBeLessThanOrEqual(DEFAULT_MAX_LINE_BYTES)
    return reply.result
  }
  return { ...instance, call, success, sizes }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

function maximumPublication(productId: string, index: number, text = '界') {
  const timestamp = new Date(Date.parse('2026-11-13T10:00:00.000Z') + index)
    .toISOString()
    .replace('Z', `${'0'.repeat(40)}Z`)
  const data = {
    operationId: randomUUID(),
    windowId: randomUUID(),
    windowName: '窗'.padEnd(200, text),
    platform: '台'.padEnd(80, text),
    listingId: String(index).padStart(200, text),
    listingUrl: `https://example.invalid/${index}/`.padEnd(2048, '界'),
    productRevision: 1,
    publishedAt: timestamp,
  }
  return {
    input: { ...data, productId },
    publication: ProductPublicationSchema.parse({
      ...data,
      id: randomUUID(),
      recordedAt: timestamp,
    }),
  }
}

function maximumMetadata(text = '界') {
  return {
    name: '名'.padEnd(200, text),
    title: '题'.padEnd(500, text),
    description: '仅在描述出现'.padEnd(6000, text),
    sku: '货'.padEnd(80, text),
    price: 1,
    currency: 'USD',
    category: '类'.padEnd(200, text),
    condition: '况'.padEnd(120, text),
    brand: '牌'.padEnd(120, text),
    size: '码'.padEnd(120, text),
    tags: Array.from({ length: 20 }, () => '仅在标签出现'.padEnd(64, text)),
    note: '注'.padEnd(2000, text),
    status: 'draft',
  }
}

describe('publication RPC response boundaries', () => {
  it('rejects unsafe listing URLs before changing publication history through the real RPC', async () => {
    const t = harness()
    const product = ProductSaveReplySchema.parse(
      await t.success('products.save', {
        createKey: randomUUID(),
        data: { name: 'URL boundary product' },
      }),
    ).product
    for (const listingUrl of [
      ...Array.from(
        { length: 32 },
        (_, code) => `https://example.invalid/a${String.fromCharCode(code)}b`,
      ),
      'https://example.invalid/a\u007fb',
      'https://example.invalid\\listing',
      'https://example.invalid/\ud800',
      'https://example.invalid/\udfff',
      'https://user:password@example.invalid/listing',
    ]) {
      const input = maximumPublication(product.id, 0).input
      expect(
        await t.call('products.publications.record', { ...input, listingUrl }),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    }
    expect(
      ProductReplySchema.parse(await t.success('products.get', { id: product.id }))
        .product,
    ).toEqual(product)
    expect((await t.store.read()).publicationReceipts).toEqual([])
  })

  it.each(['manual', 'ai-image'] as const)(
    'keeps 370 maximum-field %s publications durable and readable through bounded RPC replies',
    async (source) => {
      const directory = await fs.mkdtemp(join(tmpdir(), 'nexus-products-rpc-boundary-'))
      directories.push(directory)
      const t = harness({ storageDirectory: directory })
      const image = await t.store.putImage(png, {
        mime: 'image/png',
        name: '图'.repeat(200),
      })
      const data = { ...maximumMetadata(), imageIds: [image.id] }
      const createInput = { createKey: randomUUID(), data }
      const aiInput = { recordId: 'synthetic-boundary-source', data }
      const product =
        source === 'manual'
          ? ProductSaveReplySchema.parse(await t.success('products.save', createInput))
              .product
          : ProductAiReplySchema.parse(await t.success('products.importAi', aiInput))
              .product
      const history = Array.from({ length: 370 }, (_, index) =>
        maximumPublication(product.id, index),
      )
      await t.store.mutate((document) => {
        const stored = document.products.find((entry) => entry.id === product.id)!
        stored.publications = history.slice(0, 369).map((entry) => entry.publication)
        stored.revision += 369
        document.publicationReceipts.push(
          ...stored.publications.map((publication) => ({
            productId: stored.id,
            publication,
          })),
        )
      })
      expect(
        Buffer.byteLength(JSON.stringify((await t.store.read()).products[0]), 'utf8'),
      ).toBeGreaterThan(DEFAULT_MAX_LINE_BYTES)

      const input = history[369]!.input
      const recorded = ProductPublicationReplySchema.parse(
        await t.success('products.publications.record', input),
      )
      expect(recorded).toMatchObject({
        alreadyRecorded: false,
        product: { revision: 371, publicationCount: 370 },
      })
      expect(recorded.product).not.toHaveProperty('publications')
      const recordBytes = t.sizes.at(-1)!
      expect(await t.success('products.publications.record', input)).toEqual({
        product: recorded.product,
        alreadyRecorded: true,
      })
      expect(
        ProductReplySchema.parse(await t.success('products.get', { id: product.id }))
          .product,
      ).toEqual(recorded.product)

      const saved = ProductSaveReplySchema.parse(
        await t.success('products.save', {
          id: product.id,
          expectedRevision: 371,
          data: { ...data, name: 'Edited bounded product' },
        }),
      ).product
      expect(saved).toMatchObject({ revision: 372, publicationCount: 370 })
      expect(saved).not.toHaveProperty('publications')
      if (source === 'manual') {
        expect(await t.success('products.save', createInput)).toEqual({
          product: saved,
          alreadySaved: true,
        })
      } else {
        expect(await t.success('products.importAi', aiInput)).toEqual({
          product: saved,
          alreadyImported: true,
        })
        expect(
          ProductSourceReplySchema.parse(
            await t.success('products.sources.find', { recordId: aiInput.recordId }),
          ).product,
        ).toEqual(saved)
      }
      await t.stop()

      const restarted = harness({ storageDirectory: directory })
      expect(
        ProductReplySchema.parse(
          await restarted.success('products.get', { id: product.id }),
        ).product,
      ).toEqual(saved)
      expect(await restarted.success('products.publications.record', input)).toEqual({
        product: saved,
        alreadyRecorded: true,
      })
      expect(
        await restarted.success('products.publications.record', history[0]!.input),
      ).toEqual({ product: saved, alreadyRecorded: true })

      const readIds: string[] = []
      const stored = (await restarted.store.read()).products[0]!
      expect(stored.publications).toHaveLength(370)
      expect((await restarted.store.read()).publicationReceipts).toHaveLength(370)
      for (let page = 1; page <= 8; page++) {
        const result = ProductPublicationPageSchema.parse(
          await restarted.success('products.publications.list', {
            productId: product.id,
            page,
            pageSize: 50,
          }),
        )
        expect(result).toMatchObject({
          productId: product.id,
          productName: saved.name,
          productRevision: 372,
          total: 370,
          page,
          pageSize: 50,
        })
        expect(result.items).toHaveLength(page === 8 ? 20 : 50)
        readIds.push(...result.items.map((entry) => entry.id))
      }
      expect(readIds).toEqual([...stored.publications].reverse().map((entry) => entry.id))
      expect(new Set(readIds).size).toBe(370)
      for (const payload of [
        { ...history[0]!.input, windowName: 'Changed old operation' },
        { ...history[0]!.input, operationId: randomUUID() },
      ])
        expect(
          await restarted.call('products.publications.record', payload),
        ).toMatchObject({
          ok: false,
          error: { code: 'INVALID_REQUEST' },
        })
      const file = join(directory, 'products.json')
      const before = await fs.readFile(file, 'utf8')
      const next = maximumPublication(product.id, 370).input
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic disk failure'))
      expect(await restarted.call('products.publications.record', next)).toMatchObject({
        ok: false,
        error: { code: 'UNAVAILABLE' },
      })
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      expect(
        ProductReplySchema.parse(
          await restarted.success('products.get', { id: product.id }),
        ).product,
      ).toEqual(saved)
      expect(await restarted.success('products.publications.record', next)).toMatchObject(
        {
          alreadyRecorded: false,
          product: { revision: 373, publicationCount: 371 },
        },
      )
      expect(Math.max(...t.sizes, ...restarted.sizes)).toBeLessThanOrEqual(
        DEFAULT_MAX_LINE_BYTES,
      )
      console.info(
        `RPC ${source}: record ${recordBytes} bytes; largest reply ${Math.max(...t.sizes, ...restarted.sizes)} bytes`,
      )
    },
  )

  it.each(['界', '\u0000'])(
    'returns 50 maximum UTF-8 or escaped-control summaries and history entries within the RPC line limit (%j)',
    async (text) => {
      const t = harness()
      const image = await t.store.putImage(png, {
        mime: 'image/png',
        name: '图'.padEnd(200, text),
      })
      const origin = {
        pluginId: 'p'.repeat(253),
        itemId: '源'.padEnd(200, text),
        title: '题'.padEnd(500, text),
        url: 'https://example.invalid/'.padEnd(2048, '界'),
      }
      const first = ProductAiReplySchema.parse(
        await t.success('products.importAi', {
          recordId: 'synthetic-maximum-source-0',
          origin,
          data: { ...maximumMetadata(text), imageIds: [image.id] },
        }),
      ).product
      await t.store.mutate((document) => {
        const template = structuredClone(document.products[0]!)
        const timestamp = '2026-11-13T10:00:00.'.padEnd(63, '0') + 'Z'
        template.createdAt = timestamp
        template.updatedAt = timestamp
        document.products = []
        document.receipts = []
        for (let index = 0; index < 50; index++) {
          const product = {
            ...structuredClone(template),
            id: index === 0 ? first.id : randomUUID(),
            sequence: index + 1,
            revision: 2,
            source: {
              kind: 'ai-image' as const,
              recordId: `synthetic-maximum-source-${index}`,
              origin,
            },
          }
          const publication = maximumPublication(product.id, index, text).publication
          product.publications = [publication]
          document.products.push(product)
          document.receipts.push({
            kind: 'ai',
            key: product.source.recordId,
            productId: product.id,
          })
          document.publicationReceipts.push({ productId: product.id, publication })
        }
        const product = document.products[0]!
        for (let index = 50; index < 99; index++) {
          const publication = maximumPublication(product.id, index, text).publication
          product.publications.push(publication)
          document.publicationReceipts.push({ productId: product.id, publication })
        }
        product.revision = 51
        document.nextSequence = 51
      })
      const page = ProductPageSchema.parse(
        await t.success('products.list', { pageSize: 50 }),
      )
      expect(page).toMatchObject({ total: 50, page: 1, pageSize: 50 })
      expect(page.items).toHaveLength(50)
      expect(page.items[0]?.source).toEqual({ kind: 'ai-image' })
      for (const key of [
        'condition',
        'brand',
        'size',
        'tags',
        'description',
        'note',
        'images',
        'publications',
      ])
        expect(page.items[0]).not.toHaveProperty(key)
      const listBytes = t.sizes.at(-1)!
      for (const query of ['仅在描述出现', '仅在标签出现'])
        expect(
          ProductPageSchema.parse(
            await t.success('products.list', { query, pageSize: 50 }),
          ).total,
        ).toBe(50)
      const history = ProductPublicationPageSchema.parse(
        await t.success('products.publications.list', {
          productId: first.id,
          pageSize: 50,
        }),
      )
      expect(history.items).toHaveLength(50)
      expect(history.total).toBe(50)
      const historyBytes = t.sizes.at(-1)!
      expect(
        ProductReplySchema.parse(await t.success('products.get', { id: first.id }))
          .product.source,
      ).toEqual({ kind: 'ai-image', recordId: 'synthetic-maximum-source-0', origin })
      console.info(
        `RPC maximum text ${JSON.stringify(text)}: list ${listBytes} bytes; history ${historyBytes} bytes; largest reply ${Math.max(...t.sizes)} bytes`,
      )
    },
  )
})
