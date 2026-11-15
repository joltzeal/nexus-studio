import { describe, expect, it } from 'vitest'
import { compareProductPublicationRecency } from './publication-order'
import { publication } from './publication.test-data'

describe('publication display ordering', () => {
  it('orders by published time before using record identity', () => {
    const earlier = {
      ...publication,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      publishedAt: '2026-11-13T00:00:00.000Z',
    }
    const later = {
      ...publication,
      id: '11111111-1111-4111-8111-111111111111',
      publishedAt: '2026-11-14T00:00:00.000Z',
    }
    expect(compareProductPublicationRecency(earlier, later)).toBeLessThan(0)
    expect(compareProductPublicationRecency(later, earlier)).toBeGreaterThan(0)
  })

  it('compares submillisecond fractions without rounding', () => {
    const earlier = { ...publication, publishedAt: '2026-11-14T00:00:00.123456788Z' }
    const later = { ...publication, publishedAt: '2026-11-14T00:00:00.123456789Z' }
    expect(compareProductPublicationRecency(earlier, later)).toBeLessThan(0)
  })

  it('uses stable record identity for equal instants with different precision', () => {
    const first = {
      ...publication,
      id: '11111111-1111-4111-8111-111111111111',
      publishedAt: '2026-11-14T00:00:00.1000Z',
    }
    const second = {
      ...publication,
      id: '22222222-2222-4222-8222-222222222222',
      publishedAt: '2026-11-14T00:00:00.1Z',
    }
    expect(compareProductPublicationRecency(first, second)).toBeLessThan(0)
    expect(compareProductPublicationRecency(first, first)).toBe(0)
  })
})
