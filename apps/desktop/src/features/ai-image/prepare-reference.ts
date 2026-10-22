/**
 * Reference photos are re-encoded in the page before they reach the plugin: a
 * 12 MP phone photo would otherwise blow through the chunk budget for no gain,
 * since image models resample to their own working size anyway.
 */
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
export const MAX_REFERENCE_EDGE = 1536
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
const QUALITIES = [0.86, 0.72, 0.6] as const

export function checkReference(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_TYPES.includes(file.type as (typeof ACCEPTED_TYPES)[number])) {
    return '只支持 JPEG、PNG、WebP 图片。'
  }
  if (file.size === 0) return '图片内容为空。'
  if (file.size > MAX_REFERENCE_BYTES) return '图片不能超过 8 MB。'
  return null
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    // `from-image` applies the EXIF orientation so phone photos are not sideways.
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

function targetSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= MAX_REFERENCE_EDGE) return { width, height }
  const scale = MAX_REFERENCE_EDGE / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality)
  })
}

export interface PreparedReference {
  base64: string
  mime: 'image/jpeg'
  name: string
  width: number
  height: number
  bytes: number
}

export async function prepareReference(file: File): Promise<PreparedReference> {
  const invalid = checkReference(file)
  if (invalid !== null) throw new Error(invalid)

  const source = await decode(file)
  const size = targetSize(source.width, source.height)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (context === null) {
    if ('close' in source) source.close()
    throw new Error('当前环境无法处理图片。')
  }
  // JPEG has no alpha: fill white so transparent PNGs do not turn black.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(source, 0, 0, size.width, size.height)
  if ('close' in source) source.close()

  let blob: Blob | null = null
  for (const quality of QUALITIES) {
    blob = await encode(canvas, quality)
    if (blob !== null && blob.size <= 1.5 * 1024 * 1024) break
  }
  if (blob === null) throw new Error('图片转码失败。')

  const buffer = new Uint8Array(await blob.arrayBuffer())
  const chunk = 0x8000
  let binary = ''
  for (let offset = 0; offset < buffer.length; offset += chunk) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + chunk))
  }
  const stem = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'reference'
  return {
    base64: btoa(binary),
    mime: 'image/jpeg',
    name: `${stem}.jpg`,
    width: size.width,
    height: size.height,
    bytes: buffer.byteLength,
  }
}
