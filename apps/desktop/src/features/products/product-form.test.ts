import { describe, expect, it } from 'vitest'
import { ProductSaveSchema, ProductSchema } from '@nexus/plugin-contracts/products'
import {
  emptyProductForm,
  productError,
  productForm,
  productSaveInput,
} from './product-form'

const createKey = '741204de-e426-4a97-9d1a-a8b420e6eac4'

describe('product editor submission', () => {
  it('keeps category, English copy and price optional in a new draft', () => {
    const input = productSaveInput({ ...emptyProductForm(), name: '备用商品' }, [], {
      createKey,
    })

    expect(ProductSaveSchema.safeParse(input).success).toBe(true)
    expect(input.data).toMatchObject({
      category: '',
      title: '',
      description: '',
      price: null,
      status: 'draft',
      platformFacts: { vinted: [] },
    })
  })

  it('keeps the edit revision and image order, including the selected main image', () => {
    const imageIds = [
      '7789c134-f3fe-4b63-bb41-dd259979ea21',
      '93321469-1d55-407c-90da-9c683823258c',
    ]
    const input = productSaveInput(
      { ...emptyProductForm(), name: 'Edited', price: '12.50', tags: '衣物, summer' },
      imageIds,
      { id: createKey, expectedRevision: 4 },
    )

    expect(input.expectedRevision).toBe(4)
    expect(input.createKey).toBeUndefined()
    expect(input.data.imageIds).toEqual(imageIds)
    expect(input.data.price).toBe(12.5)
    expect(input.data.tags).toEqual(['衣物', 'summer'])
  })

  it('does not turn an invalid price into an empty or zero price', () => {
    expect(() =>
      productSaveInput({ ...emptyProductForm(), name: 'Draft', price: 'abc' }, [], {
        createKey,
      }),
    ).toThrow('价格')
  })

  it('preserves existing tags containing separators when only other fields change', () => {
    const tags = ['cotton, silk', 'summer']
    const input = productSaveInput(
      { ...emptyProductForm(), name: 'Edited name', tags: tags.join(', ') },
      [],
      { id: createKey, expectedRevision: 4 },
      tags,
    )
    expect(input.data.tags).toEqual(tags)
  })

  it('turns contract errors into readable field feedback rather than a JSON dump', () => {
    const invalid = ProductSaveSchema.safeParse({
      createKey,
      data: { name: '', status: 'ready', imageIds: [] },
    })
    expect(invalid.success).toBe(false)
    if (invalid.success) throw new Error('Expected an invalid draft')
    const message = productError(invalid.error)
    expect(message).toContain('商品名称')
    expect(message).toContain('英文标题')
    expect(message).not.toContain('"code"')
    expect(message).not.toContain('Too small')
  })

  it('preserves each market and confirmed attributes through unrelated text edits', () => {
    const platformFacts = {
      vinted: [
        {
          platformOrigin: 'https://www.vinted.com',
          catalogId: 1904,
          catalogRevision: 'a'.repeat(64),
          attributes: { 'Material / fabric': 'Cotton, silk', Color: 'Blue' },
        },
        {
          platformOrigin: 'https://www.vinted.co.uk',
          catalogId: null,
          catalogRevision: null,
          attributes: { Size: 'M' },
        },
      ],
    }
    const product = ProductSchema.parse({
      id: createKey,
      revision: 4,
      sequence: 1,
      name: 'Before',
      category: 'Clothing',
      platformFacts,
      images: [],
      source: { kind: 'manual' },
      publicationCount: 0,
      latestPublication: null,
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
    })
    const input = productSaveInput({ ...productForm(product), name: 'After' }, [], {
      id: product.id,
      expectedRevision: 4,
    })
    expect(input.data.platformFacts).toEqual(platformFacts)
    expect(input.data.category).toBe('Clothing')
    expect(input.data).not.toHaveProperty('vintedFacts')
    expect(input.data).not.toHaveProperty('publicationCount')
  })

  it('converts explicit optional fallback and observed facts without inferring other fields', () => {
    const input = productSaveInput(
      {
        ...emptyProductForm(),
        name: 'Shirt',
        vintedFacts: [
          {
            platformOrigin: 'https://www.vinted.com',
            catalogId: '1904',
            catalogRevision: '',
            attributes: [{ name: ' Material ', value: ' Cotton ' }],
          },
        ],
      },
      [],
      { createKey },
    )
    expect(input.data).toMatchObject({
      category: '',
      brand: '',
      size: '',
      platformFacts: {
        vinted: [
          {
            platformOrigin: 'https://www.vinted.com',
            catalogId: 1904,
            catalogRevision: null,
            attributes: { Material: 'Cotton' },
          },
        ],
      },
    })
    expect(ProductSaveSchema.safeParse(input).success).toBe(true)
  })

  it.each(['0', '-2', '1.5', '1e3', 'unknown', '9007199254740992'])(
    'rejects an invalid manual catalog ID before saving: %s',
    (catalogId) => {
      expect(() =>
        productSaveInput(
          {
            ...emptyProductForm(),
            name: 'Shirt',
            vintedFacts: [
              {
                platformOrigin: 'https://www.vinted.com',
                catalogId,
                catalogRevision: '',
                attributes: [],
              },
            ],
          },
          [],
          { createKey },
        ),
      ).toThrow('分类 ID')
    },
  )

  it('rejects half-filled and duplicate attribute rows instead of silently losing manual input', () => {
    for (const attributes of [
      [{ name: 'Material', value: '' }],
      [{ name: '', value: 'Cotton' }],
      [
        { name: 'Material', value: 'Cotton' },
        { name: ' Material ', value: 'Silk' },
      ],
    ]) {
      expect(() =>
        productSaveInput(
          {
            ...emptyProductForm(),
            name: 'Shirt',
            vintedFacts: [
              {
                platformOrigin: 'https://www.vinted.com',
                catalogId: '',
                catalogRevision: '',
                attributes,
              },
            ],
          },
          [],
          { createKey },
        ),
      ).toThrow('属性')
    }
  })
})
