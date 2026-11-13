import { describe, expect, it } from 'vitest'
import { productAddedTime, productPublicationCountLabel } from './product-picker-metadata'

const now = Date.parse('2026-11-13T00:00:00.000Z')

describe('product picker metadata from plugin facts', () => {
  it.each([
    ['2026-11-12T23:59:45.000Z', '刚刚'],
    ['2026-11-12T23:58:00.000Z', '2 分钟前'],
    ['2026-11-12T21:00:00.000Z', '3 小时前'],
    ['2026-11-11T00:00:00.000Z', '2 天前'],
    ['2026-09-14T00:00:00.000Z', '2 个月前'],
    ['2025-11-13T00:00:00.000Z', '1 年前'],
    ['2026-11-13T02:00:00.000Z', '2 小时后'],
  ])('formats %s relative to the inspection time', (createdAt, label) => {
    const result = productAddedTime(createdAt, now)
    expect(result.label).toBe(label)
    expect(result.dateTime).toBe(createdAt)
    expect(result.title).toContain(createdAt)
  })

  it.each([null, undefined, '', 'invalid', 0])(
    'preserves an unknown creation time for %j',
    (createdAt) => {
      expect(productAddedTime(createdAt, now)).toEqual({ label: '未知' })
    },
  )

  it('uses the returned count, including zero, and keeps unknown counts distinct', () => {
    expect(productPublicationCountLabel(0)).toBe('0')
    expect(productPublicationCountLabel(7)).toBe('7')
    expect(productPublicationCountLabel(undefined)).toBe('未知')
    expect(productPublicationCountLabel(null)).toBe('未知')
    expect(productPublicationCountLabel(-1)).toBe('未知')
    expect(productPublicationCountLabel(NaN)).toBe('未知')
  })
})
