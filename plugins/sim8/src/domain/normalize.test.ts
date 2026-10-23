import { describe, expect, it } from 'vitest'

import {
  normalizeAllocation,
  normalizeApps,
  normalizeCategories,
  normalizeFilterDetail,
  normalizeOrders,
  normalizePrefixes,
  normalizePurchased,
  normalizeTel,
  tokenFromUrl,
} from './normalize.js'

describe('number normalization', () => {
  it('keeps a leading plus and drops separators', () => {
    expect(normalizeTel('+1 (415) 555-0100')).toBe('+14155550100')
    expect(normalizeTel('8613800138000')).toBe('8613800138000')
    expect(normalizeTel('   ')).toBe('')
  })

  it('reads the token out of a record link', () => {
    expect(tokenFromUrl('https://api.cc/api/record?token=abc123')).toBe('abc123')
    expect(tokenFromUrl('not a url')).toBe('')
  })
})

describe('purchase payloads', () => {
  it('reads the documented list shape', () => {
    const items = normalizePurchased({
      ordernum: 'ORD-1',
      api_count: 1,
      list: [
        {
          tel: '+14155550100',
          token: 'tok',
          end_time: '2026-11-01 12:00:00',
          api: 'https://api.cc/api/record?token=tok',
        },
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      tel: '+14155550100',
      token: 'tok',
      ordernum: 'ORD-1',
      endTime: '2026-11-01 12:00:00',
    })
  })

  it('reads the untyped url_list lines and fills the token from the link', () => {
    const items = normalizePurchased({
      ordernum: 'ORD-2',
      url_list: ['+14155550101----https://api.cc/api/record?token=t2'],
    })
    expect(items).toEqual([
      expect.objectContaining({
        tel: '+14155550101',
        token: 't2',
        ordernum: 'ORD-2',
      }),
    ])
  })

  it('folds the same number reported twice into one row', () => {
    const items = normalizePurchased({
      ordernum: 'ORD-3',
      list: [{ tel: '14155550102', id: 77, api: 'https://api.cc/r?token=a' }],
      url_list: ['14155550102----https://api.cc/r?token=a'],
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.apiId).toBe(77)
  })

  it('reads the single-record answer of order/apiOnce', () => {
    const items = normalizePurchased({
      data: { id: 12, tel: '+14155550103', api: 'https://api.cc/r?token=b' },
    })
    expect(items[0]?.apiId).toBe(12)
    expect(items[0]?.token).toBe('b')
  })

  it('skips rows without a number', () => {
    expect(normalizePurchased({ list: [{ api: 'https://x' }] })).toEqual([])
  })
})

describe('catalog payloads', () => {
  it('reads categories, tolerating the undocumented item shape', () => {
    const result = normalizeCategories({ list: [{ id: 2, name: '热门' }], total: 1 })
    expect(result.items).toEqual([{ id: 2, name: '热门', count: null }])
  })

  it('reads projects with price and stock', () => {
    const result = normalizeApps({
      list: [{ id: 9, cate_id: 2, name: 'Vinted', price: 1.5, num: 320 }],
      total: 1,
    })
    expect(result.items[0]).toEqual({
      id: 9,
      cateId: 2,
      name: 'Vinted',
      price: 1.5,
      stock: 320,
    })
  })

  it('reads prefixes and totals them when the answer omits the sum', () => {
    const result = normalizePrefixes({
      list: [
        { prefix: '1415', num: 10 },
        { prefix: '1416', num: 5 },
      ],
    })
    expect(result.count).toBe(2)
    expect(result.num).toBe(15)
  })

  it('reads orders and their allocation state', () => {
    const result = normalizeOrders({
      list: [
        {
          ordernum: 'ORD-9',
          allocation_status: 'pending',
          requested_num: 5,
          allocated_num: 2,
        },
      ],
    })
    expect(result.items[0]).toMatchObject({
      ordernum: 'ORD-9',
      allocationStatus: 'pending',
      requestedNum: 5,
      allocatedNum: 2,
    })
  })

  it('reads a deferred order answer', () => {
    const state = normalizeAllocation({
      ordernum: 'ORD-10',
      allocation_status: 'processing',
      requested_num: 3,
      allocated_num: 1,
      api_count: 1,
      expire_at: '2026-11-01 00:00:00',
    })
    expect(state).toMatchObject({
      ordernum: 'ORD-10',
      allocationStatus: 'processing',
      allocatedNum: 1,
    })
  })

  it('reads a filter order detail', () => {
    const detail = normalizeFilterDetail({
      order_id: 3,
      ordernum: 'F-3',
      code: 'US',
      country: '美国',
      price: 0.02,
      num: 100,
      valid: 87,
      money: 2,
      status: 2,
    })
    expect(detail).toMatchObject({
      orderId: 3,
      countryCode: 'US',
      valid: 87,
      status: 2,
    })
  })
})
