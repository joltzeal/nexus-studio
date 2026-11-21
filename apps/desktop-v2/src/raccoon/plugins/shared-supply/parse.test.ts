import { describe, expect, it } from 'vitest'
import {
  parseSupplyCatalog,
  parseSupplyFavorites,
  parseSupplyProductList,
  parseSupplyStorePage,
} from './parse'

const product = {
  id: 'product-1',
  title: '相机包',
  description: '黑色',
  price: '39',
  merchantId: 'merchant-1',
  images: ['https://product.aliyizhan.com/person/photo.jpg'],
  coverUrl: 'https://product.aliyizhan.com/person/photo.jpg',
  publishedAt: '2026-11-20T00:00:00.000Z',
  raw: { id: 'product-1' },
}

describe('shared supply response parser', () => {
  it('accepts supplier-hosted merchant avatars and identifies stores by uid', () => {
    const stores = [
      { id: '', uid: 'M1', nickName: '档口一', iconUrl: 'https://product.aliyizhan.com/upload-file/logo.jpg', floor: '', houseNumber: '' },
      { id: '', uid: 'M2', nickName: '档口二', iconUrl: 'https://thirdwx.qlogo.cn/mmopen/logo/0', floor: '', houseNumber: '' },
    ]
    expect(parseSupplyStorePage({ items: stores, page: 0, pageSize: 80, hasMore: false }, 0).items).toEqual(stores)
  })

  it('still rejects a merchant avatar outside the permitted hosts and paths', () => {
    expect(() => parseSupplyStorePage({
      items: [{ id: '', uid: 'M1', nickName: '档口一', iconUrl: 'https://product.aliyizhan.com/other/logo.jpg', floor: '', houseNumber: '' }],
      page: 0, pageSize: 80, hasMore: false,
    }, 0)).toThrow('数据无效')
  })
  it('accepts a complete product page with its fixed page size', () => {
    expect(
      parseSupplyProductList(
        { items: [product], page: 0, pageSize: 30, hasMore: false },
        0,
      ).items,
    ).toEqual([product])
  })

  it('rejects duplicate product ids instead of displaying ambiguous rows', () => {
    expect(() =>
      parseSupplyProductList(
        { items: [product, product], page: 0, pageSize: 30, hasMore: false },
        0,
      ),
    ).toThrow('数据无效')
  })

  it('rejects a store page with the wrong fixed page size', () => {
    expect(() =>
      parseSupplyStorePage({ items: [], page: 0, pageSize: 30, hasMore: false }, 0),
    ).toThrow('数据无效')
  })

  it('rejects a catalog with duplicate category ids', () => {
    expect(() =>
      parseSupplyCatalog({
        categories: [
          { id: '1', name: '母婴' },
          { id: '1', name: '鞋靴' },
        ],
      }),
    ).toThrow('数据无效')
  })

  it('rejects favorites whose reported total differs from the rows', () => {
    const favorite = {
      ...product,
      favoriteId: 'favorite-1',
      savedAt: '2026-11-20T00:00:00.000Z',
    }
    expect(() =>
      parseSupplyFavorites({ items: [favorite], total: 2, storageDurable: true }),
    ).toThrow('数据无效')
  })
})
