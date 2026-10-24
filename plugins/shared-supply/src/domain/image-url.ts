export const IMAGE_HOST = 'product.aliyizhan.com'
export const IMAGE_PATH_PREFIX = '/person/'

/** Exact hosts and paths observed in the public catalogue, never arbitrary URLs. */
export function supplyImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '' || url.port !== '') return null
    const allowed =
      (url.hostname === IMAGE_HOST &&
        (url.pathname.startsWith(IMAGE_PATH_PREFIX) ||
          url.pathname.startsWith('/upload-file/'))) ||
      (url.hostname === 'thirdwx.qlogo.cn' && url.pathname.startsWith('/mmopen/'))
    if (!allowed) return null
    url.protocol = 'https:'
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}
