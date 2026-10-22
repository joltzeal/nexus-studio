import { callPlugin } from '@/lib/platform/native-plugins'
import {
  AI_IMAGE_CAPABILITY,
  AI_IMAGE_PLUGIN_ID,
  type GenerationRecord,
  type Provider,
  type RecordPage,
  type RecordStatus,
  type ScenePreset,
  type StoredFile,
} from './types'

/** Under the 1 MiB protocol line limit once base64 and JSON overhead are added. */
const CHUNK_BYTES = 256 * 1024
const CALL_DEADLINE = 30_000
const UPLOAD_DEADLINE = 60_000

function call<T>(method: string, payload: unknown = {}, deadlineMs?: number): Promise<T> {
  return callPlugin<T>(
    AI_IMAGE_PLUGIN_ID,
    AI_IMAGE_CAPABILITY,
    method,
    payload,
    deadlineMs ?? CALL_DEADLINE,
  )
}

export interface ProviderInput {
  id?: string
  name: string
  kind: Provider['kind']
  baseUrl: string
  apiKey?: string
  imageModel: string
  textModel: string
  supportsVision: boolean
}

export function listProviders(): Promise<{ items: Provider[]; storageDurable: boolean }> {
  return call('image.providers.list')
}

export function saveProvider(input: ProviderInput): Promise<Provider> {
  return call('image.providers.save', input)
}

export function removeProvider(id: string): Promise<{ id: string; removed: boolean }> {
  return call('image.providers.remove', { id })
}

export function testProvider(id: string): Promise<{
  ok: boolean
  message: string
  modelCount: number | null
  durationMs: number
}> {
  return call('image.providers.test', { id }, 25_000)
}

export function listPresets(): Promise<{ presets: ScenePreset[] }> {
  return call('image.presets')
}

export function listRecords(
  page: number,
  size: number,
  status?: RecordStatus,
): Promise<RecordPage> {
  return call(
    'image.records.list',
    status === undefined ? { page, size } : { page, size, status },
  )
}

export function getRecord(id: string): Promise<{ record: GenerationRecord }> {
  return call('image.records.get', { id })
}

export function removeRecord(id: string): Promise<{ id: string; removed: boolean }> {
  return call('image.records.remove', { id })
}

export function retryRecord(id: string): Promise<{ record: GenerationRecord }> {
  return call('image.records.retry', { id })
}

export function exportRecord(id: string): Promise<{ paths: string[] }> {
  return call('image.records.export', { id }, UPLOAD_DEADLINE)
}

export interface GenerateInput {
  providerId: string
  mode: GenerationRecord['mode']
  presetId: string | null
  prompt: string
  size: string
  count: number
  inputFileIds: string[]
}

export function generate(input: GenerateInput): Promise<{ record: GenerationRecord }> {
  return call('image.generate', input)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * Uploads go through the plugin in chunks because a single JSON line is capped
 * at 1 MiB. The session is aborted on any failure so a half-written image never
 * becomes a record input.
 */
export async function uploadImage(input: {
  base64: string
  mime: string
  name: string
}): Promise<StoredFile> {
  const bytes = base64ToBytes(input.base64)
  if (bytes.byteLength === 0) throw new Error('图片内容为空')
  const begun = await call<{ uploadId: string; chunkSize: number }>(
    'image.upload.begin',
    {
      mime: input.mime,
      size: bytes.byteLength,
    },
  )
  try {
    const step = Math.min(CHUNK_BYTES, begun.chunkSize)
    let index = 0
    for (let offset = 0; offset < bytes.byteLength; offset += step) {
      await call(
        'image.upload.chunk',
        {
          uploadId: begun.uploadId,
          index,
          data: bytesToBase64(bytes.subarray(offset, offset + step)),
        },
        UPLOAD_DEADLINE,
      )
      index += 1
    }
    const finished = await call<{ file: StoredFile }>('image.upload.finish', {
      uploadId: begun.uploadId,
      name: input.name,
    })
    return finished.file
  } catch (error) {
    await call('image.upload.abort', { uploadId: begun.uploadId }).catch(() => undefined)
    throw error
  }
}

interface ChunkReply {
  data: string
  next: number
  done: boolean
  total: number
}

export async function readImageBytes(fileId: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let offset = 0
  for (;;) {
    const reply = await call<ChunkReply>(
      'image.file.chunk',
      { fileId, offset, length: CHUNK_BYTES },
      UPLOAD_DEADLINE,
    )
    parts.push(base64ToBytes(reply.data))
    offset = reply.next
    if (reply.done) break
  }
  // The sum of the parts is the exact size; `reply.total` is only the plugin's
  // own report and may disagree if a file changed under us.
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let cursor = 0
  for (const part of parts) {
    bytes.set(part, cursor)
    cursor += part.byteLength
  }
  return bytes
}

const urlCache = new Map<string, Promise<string>>()

/**
 * Object URLs are cached per file so a table row and its detail dialog share one
 * download. Deleting a record drops its entry; the browser reclaims the blob.
 */
export function imageObjectUrl(fileId: string, mime: string): Promise<string> {
  const cached = urlCache.get(fileId)
  if (cached !== undefined) return cached
  const pending = readImageBytes(fileId).then((bytes) => {
    // A plain ArrayBuffer is the only BlobPart the DOM types accept here.
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    return URL.createObjectURL(new Blob([buffer], { type: mime }))
  })
  urlCache.set(fileId, pending)
  pending.catch(() => urlCache.delete(fileId))
  return pending
}

export function forgetImage(fileId: string): void {
  const cached = urlCache.get(fileId)
  urlCache.delete(fileId)
  if (cached !== undefined) {
    void cached.then((url) => URL.revokeObjectURL(url)).catch(() => undefined)
  }
}
