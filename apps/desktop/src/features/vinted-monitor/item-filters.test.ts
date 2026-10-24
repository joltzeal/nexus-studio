import { describe, expect, it } from 'vitest'
import {
  EMPTY_FILTERS,
  itemFilterParams,
  nextFavouriteOrder,
  safeExternalUrl,
  sourceCountry,
} from './item-filters'

describe('Vinted item query filters', () => {
  it('preserves zero likes and explicit unstarred instead of dropping falsy filters', () => {
    expect(
      itemFilterParams({
        ...EMPTY_FILTERS,
        monitorId: 'monitor-1',
        starred: 'false',
        favouriteCountOp: 'eq',
        favouriteCount: '0',
      }),
    ).toEqual({
      monitorId: 'monitor-1',
      starred: false,
      favouriteCountOp: 'eq',
      favouriteCount: 0,
    })
  })

  it('distinguishes absent like counts from zero and ignores stale numeric inputs for null checks', () => {
    expect(
      itemFilterParams({
        ...EMPTY_FILTERS,
        favouriteCountOp: 'isNull',
        favouriteCount: '42',
        favouriteCountEnd: '60',
      }),
    ).toEqual({ favouriteCountOp: 'isNull' })
  })

  it('accepts one-sided ranges and rejects reversed or empty bounds', () => {
    expect(
      itemFilterParams({
        ...EMPTY_FILTERS,
        favouriteCountOp: 'between',
        favouriteCountEnd: '20',
      }),
    ).toEqual({ favouriteCountOp: 'between', favouriteCountEnd: 20 })
    expect(() =>
      itemFilterParams({
        ...EMPTY_FILTERS,
        favouriteCountOp: 'between',
        favouriteCount: '20',
        favouriteCountEnd: '0',
      }),
    ).toThrow('下限不能大于上限')
    expect(() =>
      itemFilterParams({ ...EMPTY_FILTERS, favouriteCountOp: 'between' }),
    ).toThrow('至少填写')
  })

  it('does not silently convert invalid or unsafe counts', () => {
    for (const value of ['', '-1', '1.2', '1e3', '9007199254740992']) {
      expect(() =>
        itemFilterParams({
          ...EMPTY_FILTERS,
          favouriteCountOp: 'eq',
          favouriteCount: value,
        }),
      ).toThrow()
    }
    expect(() => itemFilterParams({ ...EMPTY_FILTERS, externalId: '123/456' })).toThrow(
      '商品 ID',
    )
  })

  it('cycles global sort through ascending, descending, then collected order', () => {
    expect(nextFavouriteOrder('collected_desc')).toBe('favourite_asc')
    expect(nextFavouriteOrder('favourite_asc')).toBe('favourite_desc')
    expect(nextFavouriteOrder('favourite_desc')).toBe('collected_desc')
  })

  it('keeps external links inert when their scheme or credentials are unsafe', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('https://user:secret@vinted.fr/items/1')).toBeNull()
    expect(safeExternalUrl('https://vinted.fr/items/1')).toBe('https://vinted.fr/items/1')
    expect(sourceCountry('www.vinted.co.uk')).toBe('英国')
    expect(sourceCountry('vinted.fr')).toBe('法国')
  })
})
