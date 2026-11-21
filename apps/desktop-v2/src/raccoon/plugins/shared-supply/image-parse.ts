export const SUPPLY_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const SUPPLY_IMAGE_MAX_CHUNK = 256 * 1024
export const SUPPLY_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

function row(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('图片传输数据无效，请刷新或更新共享货源插件。')
  return value as Record<string, unknown>
}

export function parseSupplyImageMeta(value: unknown) {
  const data = row(value)
  if (
    typeof data.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      data.id,
    ) ||
    typeof data.size !== 'number' ||
    !Number.isSafeInteger(data.size) ||
    data.size <= 0 ||
    data.size > SUPPLY_IMAGE_MAX_BYTES ||
    typeof data.chunkSize !== 'number' ||
    !Number.isSafeInteger(data.chunkSize) ||
    data.chunkSize <= 0 ||
    data.chunkSize > SUPPLY_IMAGE_MAX_CHUNK ||
    typeof data.mime !== 'string' ||
    !SUPPLY_IMAGE_MIMES.has(data.mime)
  )
    throw new Error('图片传输数据无效，请刷新或更新共享货源插件。')
  return { id: data.id, size: data.size, chunkSize: data.chunkSize, mime: data.mime }
}

export function parseSupplyImageChunk(value: unknown) {
  const data = row(value)
  if (
    typeof data.offset !== 'number' ||
    !Number.isSafeInteger(data.offset) ||
    data.offset < 0 ||
    typeof data.data !== 'string' ||
    data.data === ''
  ) {
    throw new Error('图片传输数据无效，请刷新或更新共享货源插件。')
  }
  return { offset: data.offset, data: data.data }
}

export function parseSupplyImageClose(value: unknown) {
  const data = row(value)
  if (data.closed !== true)
    throw new Error('图片传输数据无效，请刷新或更新共享货源插件。')
  return { closed: true as const }
}
