/**
 * The supplier's image search only accepts JPEG, while the reference
 * implementation accepted JPEG/PNG/WebP and re-encoded them server-side with
 * Pillow. Here the page does that conversion: decode with the EXIF orientation
 * applied, draw on a canvas, export JPEG. It is the same normalisation, just on
 * the client.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MIN_IMAGE_EDGE = 100
export const MAX_IMAGE_EDGE = 8000
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

const JPEG_QUALITY = 0.88

export function checkImageFile(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_TYPES.includes(file.type as (typeof ACCEPTED_TYPES)[number])) {
    return '只支持 JPEG、PNG、WebP 图片。'
  }
  if (file.size === 0) return '图片内容为空。'
  if (file.size > MAX_IMAGE_BYTES) return '图片不能超过 5 MB。'
  return null
}

/** `btoa` only takes a binary string, so the buffer is converted in chunks. */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunk = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

function checkEdges(width: number, height: number): string | null {
  const shortest = Math.min(width, height)
  const longest = Math.max(width, height)
  if (shortest < MIN_IMAGE_EDGE)
    return `图片至少 ${MIN_IMAGE_EDGE} × ${MIN_IMAGE_EDGE} 像素。`
  if (longest > MAX_IMAGE_EDGE) return `图片边长不能超过 ${MAX_IMAGE_EDGE} 像素。`
  return null
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    // `from-image` applies the EXIF orientation, matching Pillow's exif_transpose.
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Returns a base64 JPEG payload plus the pixel size it was converted from. */
export async function prepareJpeg(
  file: File,
): Promise<{ base64: string; width: number; height: number }> {
  const invalid = checkImageFile(file)
  if (invalid !== null) throw new Error(invalid)

  const source = await decode(file)
  const width = source.width
  const height = source.height
  const edges = checkEdges(width, height)
  if (edges !== null) {
    if ('close' in source) source.close()
    throw new Error(edges)
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) {
    if ('close' in source) source.close()
    throw new Error('当前环境无法处理图片。')
  }
  context.drawImage(source, 0, 0, width, height)
  if ('close' in source) source.close()

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/jpeg', JPEG_QUALITY)
  })
  if (blob === null) throw new Error('图片转码失败。')
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('转换后的图片超过 5 MB。')
  return { base64: toBase64(await blob.arrayBuffer()), width, height }
}
