import { describe, expect, it } from 'vitest'

import {
  favoritesCsv,
  imageUrls,
  merchantRecord,
  productRecord,
  publishedAt,
} from './product.js'

const raw = {
  id: 9001,
  title: '春季风衣',
  description: '轻薄外套',
  price: '129.00',
  uid: 'M123',
  createdTime: 1_700_000_000,
  pics: {
    picList: [
      'https://product.aliyizhan.com/person/a.jpg?x=1#frag',
      'http://product.aliyizhan.com/person/b.jpg',
      'https://evil.example/person/c.jpg',
      'https://product.aliyizhan.com/other/d.jpg',
      'not a url',
      'https://product.aliyizhan.com/person/a.jpg?x=1',
    ],
  },
}

describe('imageUrls', () => {
  it('keeps only the supplier host and the product path', () => {
    expect(imageUrls(raw)).toEqual([
      'https://product.aliyizhan.com/person/a.jpg?x=1',
      'https://product.aliyizhan.com/person/b.jpg',
    ])
  })

  it('falls back to videoThumb and tolerates a missing pics object', () => {
    expect(
      imageUrls({ pics: { videoThumb: ['https://product.aliyizhan.com/person/v.jpg'] } }),
    ).toEqual(['https://product.aliyizhan.com/person/v.jpg'])
    expect(imageUrls({})).toEqual([])
    expect(imageUrls({ pics: [] })).toEqual([])
  })
})

describe('publishedAt', () => {
  it('reads seconds and milliseconds', () => {
    expect(publishedAt({ createdTime: 1_700_000_000 })).toBe('2023-11-14T22:13:20.000Z')
    expect(publishedAt({ createdTime: '1700000000000' })).toBe('2023-11-14T22:13:20.000Z')
  })

  it('refuses values outside the plausible range instead of inventing a date', () => {
    expect(publishedAt({ createdTime: 0 })).toBeNull()
    expect(publishedAt({ createdTime: 9_999_999_999_999 })).toBeNull()
    expect(publishedAt({ createdTime: 'yesterday' })).toBeNull()
    expect(publishedAt({})).toBeNull()
  })
})

describe('productRecord', () => {
  it('normalises numbers to strings and keeps the raw payload', () => {
    const record = productRecord(raw)
    expect(record.id).toBe('9001')
    expect(record.merchantId).toBe('M123')
    expect(record.price).toBe('129.00')
    expect(record.coverUrl).toBe('https://product.aliyizhan.com/person/a.jpg?x=1')
    expect(record.raw).toBe(raw)
  })

  it('falls back to holder for the merchant and to an empty cover', () => {
    const record = productRecord({ id: '1', title: 't', holder: 'H9' })
    expect(record.merchantId).toBe('H9')
    expect(record.coverUrl).toBe('')
    expect(record.publishedAt).toBeNull()
  })
})

describe('merchantRecord', () => {
  it('normalises the observed logo hosts to HTTPS and rejects arbitrary remote content', () => {
    expect(
      merchantRecord({ iconUrl: 'http://product.aliyizhan.com/upload-file/logo.jpg' })
        .iconUrl,
    ).toBe('https://product.aliyizhan.com/upload-file/logo.jpg')
    expect(
      merchantRecord({ iconUrl: 'https://thirdwx.qlogo.cn/mmopen/logo/0' }).iconUrl,
    ).toBe('https://thirdwx.qlogo.cn/mmopen/logo/0')
    expect(merchantRecord({ iconUrl: 'https://evil.example/logo.svg' }).iconUrl).toBe('')
  })

  it('keeps the six fields the page renders', () => {
    expect(
      merchantRecord({
        id: 7,
        uid: 'M7',
        nickName: '七号铺',
        floor: '2F',
        houseNumber: 'B12',
      }),
    ).toEqual({
      id: '7',
      uid: 'M7',
      nickName: '七号铺',
      iconUrl: '',
      floor: '2F',
      houseNumber: 'B12',
    })
  })
})

describe('favoritesCsv', () => {
  it('starts with a BOM, uses CRLF and quotes every cell', () => {
    const csv = favoritesCsv([
      {
        ...productRecord(raw),
        favoriteId: 'f1',
        savedAt: '2026-10-22T00:00:00.000Z',
      },
    ])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('\r\n')
    expect(csv.split('\r\n')[0]).toContain('"商品标题"')
    expect(csv).toContain('"春季风衣"')
  })

  it('neutralises a value that a spreadsheet would run as a formula', () => {
    const csv = favoritesCsv([
      {
        ...productRecord({ id: '1', title: '=HYPERLINK("x")' }),
        favoriteId: 'f1',
        savedAt: '2026-10-22T00:00:00.000Z',
      },
    ])
    expect(csv).toContain('"\'=HYPERLINK(""x"")"')
  })
})
