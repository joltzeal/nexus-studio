import { describe, expect, it } from 'vitest'
import {
  ImageChunkSchema,
  ProductDraftSchema,
  ProductPageSchema,
  ProductPlatformFactsSchema,
  ProductPublicationPageSchema,
  ProductPublicationSchema,
  ProductSaveSchema,
  ProductSchema,
} from './products'

const ids = {
  product: '1198ca69-4f78-4705-ac59-2d48bc790194',
  image: '2198ca69-4f78-4705-ac59-2d48bc790194',
  publication: '3198ca69-4f78-4705-ac59-2d48bc790194',
  operation: '4198ca69-4f78-4705-ac59-2d48bc790194',
  window: '5198ca69-4f78-4705-ac59-2d48bc790194',
}
const now = '2026-11-14T00:00:00.000Z'
const image = {
  id: ids.image,
  name: 'fixture.webp',
  mime: 'image/webp',
  bytes: 12,
  sha256: 'a'.repeat(64),
}
const publication = {
  id: ids.publication,
  operationId: ids.operation,
  windowId: ids.window,
  windowName: 'Fixture window',
  platform: 'Vinted',
  listingId: '123',
  listingUrl: 'https://www.vinted.com/items/123',
  productRevision: 1,
  publishedAt: now,
  recordedAt: now,
}

describe('standalone product DTO contracts', () => {
  it('parses current product details with explicit market facts and image metadata', () => {
    const product = ProductSchema.parse({
      id: ids.product,
      revision: 2,
      sequence: 3,
      name: 'Fixture shirt',
      platformFacts: {
        vinted: [
          {
            platformOrigin: 'https://www.vinted.com',
            catalogId: 123,
            catalogRevision: 'b'.repeat(64),
            attributes: { color: 'Blue' },
          },
        ],
      },
      images: [image],
      publicationCount: 1,
      latestPublication: publication,
      source: { kind: 'manual' },
      createdAt: now,
      updatedAt: now,
    })
    expect(product.platformFacts.vinted).toEqual([
      {
        platformOrigin: 'https://www.vinted.com',
        catalogId: 123,
        catalogRevision: 'b'.repeat(64),
        attributes: { color: 'Blue' },
      },
    ])
    expect(product.images).toEqual([image])
    expect(product.latestPublication).toEqual(publication)
  })

  it('requires explicit product detail facts instead of silently discarding them', () => {
    expect(
      ProductSchema.safeParse({
        id: ids.product,
        revision: 1,
        sequence: 1,
        name: 'Fixture',
        images: [],
        publicationCount: 0,
        latestPublication: null,
        source: { kind: 'manual' },
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(false)
  })

  it('validates ready drafts and distinguishes create identity from edit revision', () => {
    const data = {
      name: 'Fixture shirt',
      title: 'Used cotton shirt',
      description: 'Used shirt with a small mark.',
      price: 12,
      condition: 'Good',
      imageIds: [ids.image],
      status: 'ready',
    }
    expect(ProductDraftSchema.parse(data).platformFacts).toEqual({ vinted: [] })
    expect(ProductSaveSchema.safeParse({ createKey: ids.operation, data }).success).toBe(
      true,
    )
    expect(
      ProductSaveSchema.safeParse({ id: ids.product, expectedRevision: 2, data }).success,
    ).toBe(true)
    expect(ProductSaveSchema.safeParse({ id: ids.product, data }).success).toBe(false)
    expect(ProductSaveSchema.safeParse({ data }).success).toBe(false)
    expect(
      ProductDraftSchema.safeParse({ ...data, imageIds: [ids.image, ids.image] }).success,
    ).toBe(false)
    expect(ProductDraftSchema.safeParse({ ...data, price: null }).success).toBe(false)
  })

  it.each([
    'http://www.vinted.com',
    'https://www.vinted.com/member/123',
    'https://www.vinted.com.evil.invalid',
    'https://user:pass@www.vinted.com',
  ])('rejects an invalid market origin: %s', (platformOrigin) => {
    expect(
      ProductPlatformFactsSchema.safeParse({
        vinted: [
          { platformOrigin, catalogId: null, catalogRevision: null, attributes: {} },
        ],
      }).success,
    ).toBe(false)
  })

  it('rejects duplicate market facts and a catalog revision without a category', () => {
    const market = {
      platformOrigin: 'https://www.vinted.com',
      catalogId: null,
      catalogRevision: null,
      attributes: {},
    }
    expect(
      ProductPlatformFactsSchema.safeParse({ vinted: [market, market] }).success,
    ).toBe(false)
    expect(
      ProductPlatformFactsSchema.safeParse({
        vinted: [{ ...market, catalogRevision: 'a'.repeat(64) }],
      }).success,
    ).toBe(false)
  })

  it('accepts strict page replies and preserves publication timestamp precision', () => {
    const precise = { ...publication, publishedAt: '2026-11-14T00:00:00.123456789Z' }
    expect(ProductPublicationSchema.parse(precise).publishedAt).toBe(
      '2026-11-14T00:00:00.123456789Z',
    )
    expect(
      ProductPublicationPageSchema.parse({
        productId: ids.product,
        productName: 'Fixture',
        productRevision: 2,
        items: [precise],
        total: 1,
        page: 1,
        pageSize: 20,
      }).items,
    ).toEqual([precise])
    const empty = { items: [], total: 0, page: 1, pageSize: 20, storageDurable: true }
    expect(ProductPageSchema.parse(empty)).toEqual(empty)
    expect(ProductPageSchema.safeParse({ ...empty, implementation: {} }).success).toBe(
      false,
    )
  })

  it('rejects credential-bearing publication links and oversized image chunks', () => {
    expect(
      ProductPublicationSchema.safeParse({
        ...publication,
        listingUrl: 'https://user:pass@www.vinted.com/items/123',
      }).success,
    ).toBe(false)
    expect(
      ImageChunkSchema.safeParse({
        data: 'A'.repeat(262_145),
        next: 1,
        done: false,
        total: 12,
      }).success,
    ).toBe(false)
  })
})
