/** Concrete hostnames are shared by the manifest and download validation. */
export const VINTED_IMAGE_DOMAINS = [
  'images.vinted.net',
  ...Array.from({ length: 100 }, (_, index) => `images${index}.vinted.net`),
]
const hosts = new Set(VINTED_IMAGE_DOMAINS)

export function vintedImageUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !hosts.has(url.hostname) ||
      url.hash
    )
      return null
    return url.href
  } catch {
    return null
  }
}
