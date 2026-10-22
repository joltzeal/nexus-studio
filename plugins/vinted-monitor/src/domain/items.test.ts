import { describe, expect, it } from 'vitest'

import { UpstreamError } from './errors.js'
import { parseItemsPage } from './items.js'

const itemUrl = (id: string) => `https://vinted.fr/items/${id}`

describe('listing payload parsing', () => {
  it('reads the fields the page shows', () => {
    const page = parseItemsPage(
      {
        items: [
          {
            id: 1234,
            title: '  Nike Air  ',
            price: { amount: '25.0', currency_code: 'eur' },
            brand_title: 'Nike',
            size_title: 'M / 38',
            status: 'Good',
            url: 'https://www.vinted.fr/items/1234-nike-air',
            photo: { url: 'https://images.vinted.net/a.jpg' },
            user: { login: 'someone' },
            created_at_ts: '1700000000',
          },
        ],
        pagination: { current_page: 1, total_pages: 3 },
      },
      20,
      itemUrl,
    )
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      id: '1234',
      title: 'Nike Air',
      price: '25.0',
      currency: 'EUR',
      brand: 'Nike',
      size: 'M / 38',
      condition: 'Good',
      seller: 'someone',
      imageUrl: 'https://images.vinted.net/a.jpg',
    })
    expect(page.items[0]?.listedAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(page.hasMore).toBe(true)
    expect(page.invalid).toBe(0)
  })

  it('falls back to a constructed url when the payload has none', () => {
    const page = parseItemsPage(
      {
        items: [{ id: '77', title: 'x' }],
        pagination: { current_page: 3, total_pages: 3 },
      },
      20,
      itemUrl,
    )
    expect(page.items[0]?.url).toBe('https://vinted.fr/items/77')
    expect(page.items[0]?.imageUrl).toBe('')
    expect(page.hasMore).toBe(false)
  })

  it('counts entries without a usable id as invalid', () => {
    const page = parseItemsPage(
      { items: [{ title: 'no id' }, { id: 'abc' }, { id: '5' }] },
      3,
      itemUrl,
    )
    expect(page.items.map((item) => item.id)).toEqual(['5'])
    expect(page.invalid).toBe(2)
  })

  it('treats a full page without pagination as "maybe more"', () => {
    const items = Array.from({ length: 5 }, (_, index) => ({ id: String(index) }))
    expect(parseItemsPage({ items }, 5, itemUrl).hasMore).toBe(true)
    expect(parseItemsPage({ items }, 10, itemUrl).hasMore).toBe(false)
  })

  it('rejects a payload without an items array', () => {
    expect(() => parseItemsPage({}, 20, itemUrl)).toThrow(UpstreamError)
    expect(() => parseItemsPage({ items: 'nope' }, 20, itemUrl)).toThrow(UpstreamError)
    expect(() => parseItemsPage(null, 20, itemUrl)).toThrow(UpstreamError)
  })

  it('ignores a non-http photo url', () => {
    const page = parseItemsPage(
      { items: [{ id: '1', photo: { url: 'javascript:alert(1)' } }] },
      1,
      itemUrl,
    )
    expect(page.items[0]?.imageUrl).toBe('')
  })
})
