import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ProductDraftSchema,
  ProductPublicationInputSchema,
  ProductPublicationPageSchema,
  ProductPublicationQuerySchema,
  ProductPublicationSchema,
  ProductQuerySchema,
  ProductSchema,
  ProductSummarySchema,
} from './contracts.js'

describe('product catalog contract', () => {
  it('allows a ready product without a category', () => {
    const result = ProductDraftSchema.safeParse({
      name: 'Tin sign',
      title: 'Floral tin wall sign',
      description: 'Used on our hallway wall. Light marks around the edge.',
      price: 18,
      condition: 'Good',
      imageIds: ['2ab99e47-0f16-4d85-adc6-e3a2245e7ac4'],
      status: 'ready',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.category).toBe('')
  })

  it('keeps incomplete manual products as drafts', () => {
    expect(ProductDraftSchema.parse({ name: 'New product' }).status).toBe('draft')
    expect(
      ProductDraftSchema.safeParse({ name: 'New product', status: 'ready' }).success,
    ).toBe(false)
  })

  it('requires bounded publication metadata and rejects embedded histories in public products', () => {
    const product = {
      name: 'Unreleased product',
      id: '2ab99e47-0f16-4d85-adc6-e3a2245e7ac4',
      revision: 1,
      sequence: 1,
      images: [],
      source: { kind: 'manual' },
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
    }
    expect(ProductSchema.safeParse(product).success).toBe(false)
    expect(ProductSchema.safeParse({ ...product, publications: [] }).success).toBe(false)
    expect(
      ProductSchema.safeParse({
        ...product,
        publicationCount: 0,
        latestPublication: null,
      }).success,
    ).toBe(true)
    for (const field of ['createdAt', 'updatedAt'])
      expect(
        ProductSchema.safeParse({
          ...product,
          publicationCount: 0,
          latestPublication: null,
          [field]: '2026-11-13T10:00:00.'.padEnd(64, '0') + 'Z',
        }).success,
      ).toBe(false)
    const summary = { ...product, cover: null, imageCount: 0 }
    Reflect.deleteProperty(summary, 'images')
    expect(ProductSummarySchema.safeParse(summary).success).toBe(false)
  })

  it('accepts publication filters independently of the preparation status', () => {
    for (const publicationStatus of ['published', 'unpublished'])
      expect(
        ProductQuerySchema.safeParse({
          publicationStatus,
          status: 'draft',
        }).success,
      ).toBe(true)
    expect(ProductQuerySchema.safeParse({ publicationStatus: 'ready' }).success).toBe(
      false,
    )
  })
})

describe('confirmed publication contract', () => {
  const input = {
    productId: randomUUID(),
    operationId: randomUUID(),
    windowId: randomUUID(),
    windowName: 'Test window',
    platform: 'test-market',
    listingId: 'synthetic-listing',
    listingUrl: 'https://example.invalid/listings/synthetic-listing',
    productRevision: 1,
    publishedAt: '2026-11-13T10:00:00.000Z',
  }

  it('validates caller input separately from the server-owned ID and recording time', () => {
    expect(ProductPublicationInputSchema.parse(input)).toEqual(input)
    const data = { ...input }
    Reflect.deleteProperty(data, 'productId')
    const publication = {
      ...data,
      id: randomUUID(),
      recordedAt: '2026-11-13T12:00:00.000Z',
    }
    expect(ProductPublicationSchema.parse(publication)).toEqual(publication)
    expect(ProductPublicationSchema.safeParse(data).success).toBe(false)
    for (const extra of [
      { id: randomUUID() },
      { recordedAt: publication.recordedAt },
      { unexpected: true },
    ])
      expect(
        ProductPublicationInputSchema.safeParse({ ...input, ...extra }).success,
      ).toBe(false)
    expect(
      ProductPublicationInputSchema.safeParse({
        ...input,
        listingUrl: 'http://example.invalid/listings/synthetic-listing',
      }).success,
    ).toBe(true)
    expect(
      ProductPublicationInputSchema.safeParse({
        ...input,
        listingUrl: 'https://example.invalid/\u{1f600}',
      }).success,
    ).toBe(true)
  })

  it.each([
    { productId: 'not-a-uuid' },
    { operationId: 'not-a-uuid' },
    { windowId: 'vendor-environment-id' },
    { windowName: '' },
    { windowName: '   ' },
    { windowName: 'w'.repeat(201) },
    { platform: '' },
    { platform: 'p'.repeat(81) },
    { listingId: '' },
    { listingId: 'l'.repeat(201) },
    { listingUrl: 'javascript:alert(1)' },
    { listingUrl: 'ftp://example.invalid/listing' },
    { listingUrl: '/relative/listing' },
    { listingUrl: 'https:example.invalid/listing' },
    { listingUrl: 'https://example.invalid/line\nbreak' },
    { listingUrl: 'https://example.invalid/line\rbreak' },
    { listingUrl: 'https://example.invalid/\u0000' },
    { listingUrl: 'https://example.invalid/\u007f' },
    { listingUrl: 'https://example.invalid\\listing' },
    { listingUrl: 'https://example.invalid/\ud800' },
    { listingUrl: 'https://example.invalid/\udfff' },
    { listingUrl: 'https://user@example.invalid/listing' },
    { listingUrl: 'https://user:password@example.invalid/listing' },
    { listingUrl: `https://example.invalid/${'x'.repeat(2048)}` },
    { productRevision: 0 },
    { productRevision: -1 },
    { productRevision: 1.5 },
    { publishedAt: '2026-11-13' },
    { publishedAt: 'not-a-time' },
  ])('rejects invalid confirmed publication input: %j', (change) => {
    expect(ProductPublicationInputSchema.safeParse({ ...input, ...change }).success).toBe(
      false,
    )
  })

  it('accepts 64-character ISO timestamps and rejects 65-character fractions', () => {
    const timestamp = '2026-11-13T10:00:00.'.padEnd(63, '0') + 'Z'
    expect(timestamp).toHaveLength(64)
    const data = { ...input }
    Reflect.deleteProperty(data, 'productId')
    const publication = {
      ...data,
      id: randomUUID(),
      publishedAt: timestamp,
      recordedAt: timestamp,
    }
    expect(ProductPublicationSchema.safeParse(publication).success).toBe(true)
    for (const field of ['publishedAt', 'recordedAt'])
      expect(
        ProductPublicationSchema.safeParse({
          ...publication,
          [field]: timestamp.replace('Z', '0Z'),
        }).success,
      ).toBe(false)
    expect(
      ProductPublicationInputSchema.safeParse({
        ...input,
        publishedAt: timestamp.replace('Z', '0Z'),
      }).success,
    ).toBe(false)
  })

  it('validates history query defaults and bounds response pages to 50 publications', () => {
    expect(ProductPublicationQuerySchema.parse({ productId: input.productId })).toEqual({
      productId: input.productId,
      page: 1,
      pageSize: 20,
    })
    for (const extra of [
      { productId: 'vendor-id' },
      { page: 0 },
      { page: 1.5 },
      { pageSize: 51 },
      { unexpected: true },
    ])
      expect(
        ProductPublicationQuerySchema.safeParse({ productId: input.productId, ...extra })
          .success,
      ).toBe(false)
    const data = { ...input }
    Reflect.deleteProperty(data, 'productId')
    const publication = { ...data, id: randomUUID(), recordedAt: input.publishedAt }
    const page = {
      productId: input.productId,
      productName: 'Product',
      productRevision: 1,
      items: Array.from({ length: 50 }, () => publication),
      total: 51,
      page: 1,
      pageSize: 50,
    }
    expect(ProductPublicationPageSchema.safeParse(page).success).toBe(true)
    expect(
      ProductPublicationPageSchema.safeParse({
        ...page,
        items: [...page.items, publication],
      }).success,
    ).toBe(false)
  })
})
