import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import { listProductPublications } from './api'
import { publication, publicationPage } from './publication.test-data'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

const productId = publicationPage().productId

beforeEach(() => vi.mocked(callPlugin).mockReset())

describe('publication history RPC boundary', () => {
  it('reads only the requested bounded history page using contract defaults', async () => {
    const page = publicationPage()
    vi.mocked(callPlugin).mockResolvedValue(page)
    expect(await listProductPublications({ productId })).toEqual(page)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.products',
      'product.catalog',
      'products.publications.list',
      { productId, page: 1, pageSize: 20 },
      30_000,
    )
  })

  it('accepts the final page clamped by the backend and an empty history', async () => {
    const page = publicationPage({ total: 51, page: 2, pageSize: 50 })
    vi.mocked(callPlugin).mockResolvedValue(page)
    expect(await listProductPublications({ productId, page: 3, pageSize: 50 })).toEqual(
      page,
    )
    vi.mocked(callPlugin).mockResolvedValue(publicationPage({ items: [], total: 0 }))
    expect((await listProductPublications({ productId, page: 9 })).page).toBe(1)
  })

  it.each([
    ['a different product', { productId: publication.windowId }],
    ['an unclamped page', { page: 2 }],
    ['a different page size', { pageSize: 50 as const }],
    ['a zero total with records', { total: 0 }],
    ['missing records', { total: 2 }],
    ['an empty nonempty page', { items: [] }],
    ['a future product revision', { productRevision: 1 }],
    ['an unsafe link', { items: [{ ...publication, listingUrl: 'file:///item' }] }],
  ])('rejects %s instead of displaying misleading history', async (_label, patch) => {
    vi.mocked(callPlugin).mockResolvedValue(publicationPage(patch))
    await expect(listProductPublications({ productId })).rejects.toThrow()
  })

  it('rejects duplicate publication IDs even when page totals match', async () => {
    vi.mocked(callPlugin).mockResolvedValue(
      publicationPage({ items: [publication, publication], total: 2 }),
    )
    await expect(listProductPublications({ productId })).rejects.toThrow('分页')
  })

  it('rejects records outside the descending precise timestamp and UUID ordering', async () => {
    const newer = {
      ...publication,
      id: '1198ca69-4f78-4705-ac59-2d48bc790194',
      publishedAt: '2026-11-13T01:00:00.00001Z',
    }
    vi.mocked(callPlugin).mockResolvedValue(
      publicationPage({ items: [publication, newer], total: 2 }),
    )
    await expect(listProductPublications({ productId })).rejects.toThrow('分页')
    vi.mocked(callPlugin).mockResolvedValue(
      publicationPage({ items: [newer, publication], total: 2 }),
    )
    expect((await listProductPublications({ productId })).items).toEqual([
      newer,
      publication,
    ])
  })

  it.each([
    { productId: 'not-a-uuid' },
    { productId, page: 0 },
    { productId, pageSize: 10 },
  ])('validates the history query before RPC: %j', async (query) => {
    await expect(
      listProductPublications(query as Parameters<typeof listProductPublications>[0]),
    ).rejects.toThrow()
    expect(callPlugin).not.toHaveBeenCalled()
  })
})
