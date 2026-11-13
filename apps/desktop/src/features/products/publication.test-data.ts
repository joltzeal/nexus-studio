import type {
  ProductPublication,
  ProductPublicationPage,
} from '@nexus/plugin-products/contracts'

export const publication: ProductPublication = {
  id: '3198ca69-4f78-4705-ac59-2d48bc790194',
  operationId: '4198ca69-4f78-4705-ac59-2d48bc790194',
  windowId: '5198ca69-4f78-4705-ac59-2d48bc790194',
  windowName: '英国店铺窗口',
  platform: 'Vinted',
  listingId: 'item-2',
  listingUrl: 'https://example.com/items/2',
  productRevision: 2,
  publishedAt: '2026-11-13T01:00:00.000Z',
  recordedAt: '2026-11-13T01:01:00.000Z',
}

export function publicationPage(
  overrides: Partial<ProductPublicationPage> = {},
): ProductPublicationPage {
  return {
    productId: '1198ca69-4f78-4705-ac59-2d48bc790194',
    productName: 'Published mug',
    productRevision: 3,
    items: [publication],
    total: 1,
    page: 1,
    pageSize: 20,
    ...overrides,
  }
}

export function publicationRecords(count: number): ProductPublication[] {
  return Array.from({ length: count }, (_, index) => ({
    ...publication,
    id: `${String(index + 100).padStart(8, '0')}-4f78-4705-ac59-2d48bc790194`,
    operationId: `${String(index + 200).padStart(8, '0')}-4f78-4705-ac59-2d48bc790194`,
    listingId: `history-item-${index}`,
    listingUrl: `https://example.com/history/${index}`,
  })).reverse()
}
