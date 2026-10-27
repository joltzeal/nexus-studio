import { callPlugin } from '@/lib/platform/native-plugins'
import { checkReference } from './prepare-reference'
import { providerCatalog } from './model-selection'
import {
  parseScenePlan,
  scenePlanError,
  validateScenePlanInput,
  type ScenePlanInput,
} from './scene-plan'
import {
  generationSource,
  sourceIdentity,
  sourceRequestError,
  SOURCE_UPDATE_HINT,
  type SourceIdentity,
} from './source'
import {
  AI_IMAGE_CAPABILITY,
  AI_IMAGE_PLUGIN_ID,
  type GenerationRecord,
  type GenerationSource,
  type Provider,
  type ProviderCatalog,
  type RecordPage,
  type RecordStatus,
  type ScenePreset,
  type ScenePlan,
  type SceneView,
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
  visionModel?: string
}

export async function listProviders(): Promise<ProviderCatalog> {
  return providerCatalog(await call<ProviderCatalog>('image.providers.list'))
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

export async function createScenePlan(input: ScenePlanInput): Promise<ScenePlan> {
  validateScenePlanInput(input)
  try {
    const result = await call<{ plan: unknown }>('image.plans.create', input)
    return parseScenePlan(result?.plan)
  } catch (cause) {
    throw scenePlanError(cause)
  }
}

export async function getScenePlan(id: string): Promise<ScenePlan> {
  try {
    const result = await call<{ plan: unknown }>('image.plans.get', { id })
    return parseScenePlan(result?.plan)
  } catch (cause) {
    throw scenePlanError(cause)
  }
}

export async function listRecords(
  page: number,
  size: number,
  status?: RecordStatus,
  source?: SourceIdentity,
): Promise<RecordPage> {
  const identity = source === undefined ? undefined : sourceIdentity(source)
  const sourceFilter =
    identity === undefined
      ? undefined
      : { sourcePluginId: identity.pluginId, sourceItemId: identity.itemId }
  try {
    const result = await call<RecordPage>('image.records.list', {
      page,
      size,
      ...(status === undefined ? {} : { status }),
      ...sourceFilter,
    })
    if (
      sourceFilter !== undefined &&
      (result.sourceFilter?.sourcePluginId !== sourceFilter.sourcePluginId ||
        result.sourceFilter.sourceItemId !== sourceFilter.sourceItemId ||
        !Array.isArray(result.items) ||
        result.items.some(
          (record) =>
            record.source?.pluginId !== sourceFilter.sourcePluginId ||
            record.source.itemId !== sourceFilter.sourceItemId,
        ))
    ) {
      throw new Error(SOURCE_UPDATE_HINT)
    }
    return result
  } catch (error) {
    if (sourceFilter !== undefined) throw sourceRequestError(error)
    throw error
  }
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

export function recognizeRecord(
  input:
    | { id: string; providerId: string; model: string; fileId?: string | null }
    | { id: string; retry: true },
): Promise<{ record: GenerationRecord }> {
  return call('image.records.recognize', input)
}

export function exportRecord(id: string): Promise<{ paths: string[] }> {
  return call('image.records.export', { id }, UPLOAD_DEADLINE)
}

export interface GenerateInput {
  providerId: string
  imageModel: string
  mode: GenerationRecord['mode']
  presetId: string | null
  prompt: string
  size: string
  count: number
  inputFileIds: string[]
  source?: GenerationSource
  visionProviderId?: string | null
  visionModel?: string | null
  visionFileId?: string | null
  scenePlan?: { id: string; prompt: string; views: SceneView[] }
}

export async function generate(
  input: GenerateInput,
): Promise<{ record: GenerationRecord }> {
  if (!input.providerId.trim() || !input.imageModel.trim())
    throw new Error('请选择生图服务商和模型。')
  if (
    input.mode === 'edit' &&
    !input.scenePlan &&
    (!input.visionProviderId?.trim() || !input.visionModel?.trim())
  )
    throw new Error('请选择识图服务商和模型。')
  if (
    input.scenePlan !== undefined &&
    (input.visionProviderId !== undefined ||
      input.visionModel !== undefined ||
      input.visionFileId !== undefined ||
      input.mode !== 'edit' ||
      input.count !== input.scenePlan.views.length ||
      input.count < 1 ||
      input.count > 4 ||
      input.inputFileIds.length === 0)
  ) {
    throw new Error('场景方案需使用对应参考图和视角数量，不能同时发起重复识图。')
  }
  const source = input.source === undefined ? undefined : generationSource(input.source)
  // Read-only compatibility check before a potentially paid generation. Never
  // retry without the source if an old installed package rejects the schema.
  if (source !== undefined) await listRecords(0, 1, undefined, source)
  let result: { record: GenerationRecord }
  try {
    result = await call(
      'image.generate',
      source === undefined ? input : { ...input, source },
    )
  } catch (error) {
    if (input.scenePlan !== undefined) throw scenePlanError(error)
    if (source !== undefined) throw sourceRequestError(error)
    throw error
  }
  const submittedScene = result?.record?.scenePlan
  if (
    input.scenePlan !== undefined &&
    (submittedScene?.plan?.id !== input.scenePlan.id ||
      !Array.isArray(submittedScene.views) ||
      submittedScene.views.length !== input.scenePlan.views.length ||
      submittedScene.views.some(
        (view, index) => view.id !== input.scenePlan?.views[index]?.id,
      ))
  ) {
    throw new Error(
      '生成任务已提交，但插件未保留视角方案。请先查看记录，勿重复提交；更新 AI 生图插件后再使用智能方案。',
    )
  }
  if (
    source !== undefined &&
    (result.record.source?.pluginId !== source.pluginId ||
      result.record.source.itemId !== source.itemId)
  ) {
    throw new Error(
      '生成任务已提交，但插件未保留商品来源。请先查看 AI 生图记录，勿重复提交；更新 AI 生图插件后再使用来源关联。',
    )
  }
  return result
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
export async function uploadImage(
  input: { base64: string; mime: string; name: string } | File,
  signal?: AbortSignal,
): Promise<StoredFile> {
  signal?.throwIfAborted()
  const isFile = input instanceof File
  const mime = isFile ? input.type : input.mime
  const bytes = isFile
    ? new Uint8Array(await input.arrayBuffer())
    : base64ToBytes(input.base64)
  const invalid = checkReference({ type: mime, size: bytes.byteLength })
  if (invalid !== null) throw new Error(invalid)
  signal?.throwIfAborted()
  const begun = await call<{ uploadId: string; chunkSize: number }>(
    'image.upload.begin',
    {
      mime,
      size: bytes.byteLength,
    },
  )
  try {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(begun.chunkSize) || begun.chunkSize <= 0) {
      throw new Error('AI 生图插件返回了无效的上传分块大小，请更新插件。')
    }
    const step = Math.min(CHUNK_BYTES, begun.chunkSize)
    let index = 0
    for (let offset = 0; offset < bytes.byteLength; offset += step) {
      signal?.throwIfAborted()
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
    signal?.throwIfAborted()
    const finished = await call<{ file: StoredFile }>('image.upload.finish', {
      uploadId: begun.uploadId,
      name: input.name,
    })
    signal?.throwIfAborted()
    return finished.file
  } catch (error) {
    await call('image.upload.abort', { uploadId: begun.uploadId }).catch(() => undefined)
    throw error
  }
}

/**
 * The webview cannot read a picture from a supplier's CDN (CORS), so the plugin
 * downloads it and stores it like any other upload.
 */
export function uploadRemoteImage(url: string, name?: string): Promise<StoredFile> {
  return call<{ file: StoredFile }>(
    'image.upload.remote',
    name === undefined ? { url } : { url, name },
    UPLOAD_DEADLINE,
  ).then((result) => result.file)
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
