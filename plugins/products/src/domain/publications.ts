import {
  compareProductPublicationRecency,
  type ProductPublication,
} from '../contracts.js'

export function publicationListingKey(
  publication: Pick<ProductPublication, 'platform' | 'windowId' | 'listingId'>,
): string {
  return JSON.stringify([
    publication.platform,
    publication.windowId,
    publication.listingId,
  ])
}

export function latestPublication(
  publications: ProductPublication[],
): ProductPublication | null {
  return publications.reduce<ProductPublication | null>(
    (latest, publication) =>
      latest === null || compareProductPublicationRecency(publication, latest) > 0
        ? publication
        : latest,
    null,
  )
}
