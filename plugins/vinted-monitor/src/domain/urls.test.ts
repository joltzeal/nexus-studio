import { describe, expect, it } from 'vitest'

import {
  catalogueRequest,
  isVintedHost,
  itemPageUrl,
  normalizeMonitorUrl,
  wardrobeRequest,
} from './urls.js'

describe('monitor url normalization', () => {
  it('keeps a catalogue search and forces newest first', () => {
    const target = normalizeMonitorUrl(
      'https://www.vinted.fr/catalog?search_text=nike&order=relevance&price_from=10',
    )
    expect(target.kind).toBe('catalog')
    expect(target.host).toBe('vinted.fr')
    expect(target.userId).toBeNull()
    expect(target.url).toBe(
      'https://vinted.fr/catalog?search_text=nike&price_from=10&order=newest_first',
    )
  })

  it('accepts a category filter without a search term', () => {
    const target = normalizeMonitorUrl(
      'https://vinted.de/catalog?catalog%5B%5D=1234&brand_ids%5B%5D=53',
    )
    expect(target.filters).toEqual([
      ['catalog[]', '1234'],
      ['brand_ids[]', '53'],
    ])
  })

  it('reduces a wardrobe link to the member id and drops its query', () => {
    const target = normalizeMonitorUrl(
      'https://www.vinted.co.uk/member/1234567-someone?page=3',
    )
    expect(target.kind).toBe('member')
    expect(target.userId).toBe('1234567')
    expect(target.url).toBe('https://vinted.co.uk/member/1234567')
  })

  it('upgrades http to https and refuses credentials', () => {
    expect(normalizeMonitorUrl('http://vinted.it/member/42').url).toBe(
      'https://vinted.it/member/42',
    )
    expect(() => normalizeMonitorUrl('https://user:pass@vinted.it/member/42')).toThrow(
      /账号或口令/,
    )
  })

  it('rejects hosts that are not Vinted storefronts', () => {
    expect(() =>
      normalizeMonitorUrl('https://example.com/catalog?search_text=a'),
    ).toThrow(/Vinted 站点/)
    expect(isVintedHost('www.vinted.fr')).toBe(true)
    expect(isVintedHost('vinted.fr.evil.com')).toBe(false)
  })

  it('rejects pages without a collection endpoint', () => {
    expect(() => normalizeMonitorUrl('https://vinted.fr/')).toThrow(/catalog/)
    expect(() => normalizeMonitorUrl('https://vinted.fr/1234-women')).toThrow(/catalog/)
  })

  it('rejects unknown filters instead of silently dropping them', () => {
    expect(() =>
      normalizeMonitorUrl('https://vinted.fr/catalog?search_text=a&foo=1'),
    ).toThrow(/不支持的筛选参数：foo/)
  })

  it('requires a selector on a catalogue url', () => {
    expect(() =>
      normalizeMonitorUrl('https://vinted.fr/catalog?order=newest_first'),
    ).toThrow(/至少一个/)
  })
})

describe('collection endpoints', () => {
  it('builds the catalogue api request from the stored filters', () => {
    const target = normalizeMonitorUrl(
      'https://www.vinted.fr/catalog?search_text=nike&order=newest_first',
    )
    expect(catalogueRequest(target, 2, 40)).toBe(
      'https://api.vinted.fr/svc-catalogue/items?search_text=nike&page=2&per_page=40&order=newest_first',
    )
  })

  it('builds the wardrobe request on the storefront host', () => {
    const target = normalizeMonitorUrl('https://www.vinted.fr/member/777-x')
    expect(wardrobeRequest(target, 1, 20)).toBe(
      'https://vinted.fr/api/v2/wardrobe/777/items?page=1&per_page=20',
    )
  })

  it('falls back to a constructed item url', () => {
    const target = normalizeMonitorUrl('https://www.vinted.fr/member/777-x')
    expect(itemPageUrl(target, '999')).toBe('https://vinted.fr/items/999')
  })
})
