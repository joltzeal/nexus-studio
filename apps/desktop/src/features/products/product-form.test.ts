import { describe, expect, it } from 'vitest'
import { ProductSaveSchema } from '@nexus/plugin-products/contracts'
import { emptyProductForm, productError, productSaveInput } from './product-form'

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
})
