import { callPlugin } from '../call'
import { checkReference } from './prepare-reference'
import type { PhotoMetadata } from './photo-metadata'
import {
  array,
  bool,
  CHUNK_BYTES,
  identifier,
  integer,
  invalid,
  MAX_IMAGE_BYTES,
  object,
  oneOf,
  parseAborted,
  parseChunk,
  parseFileReply,
  parseMetadata,
  parsePresets,
  parseProvider,
  parseProviderCatalog,
  parseRecordPage,
  parseRecordReply,
  parseRemoved,
  text,
  unique,
} from './parse'
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
  HISTORY_UPDATE_HINT,
  message,
  PROVIDER_IMAGE_TEST_METHOD,
  PROVIDER_TRANSPORT_UPDATE_HINT,
  SIZES,
  validateAgingLevel,
  type AgingLevel,
  type GenerationRecord,
  type ImageSize,
  type GenerationSource,
  type Provider,
  type ProviderCatalog,
  type RecordPage,
  type RecordHistoryFilters,
  type RecordStatus,
  type ScenePreset,
  type ScenePlan,
  type SceneView,
  type StoredFile,
} from './types'

/** Under the 1 MiB protocol line limit once base64 and JSON overhead are added. */
const CALL_DEADLINE = 30_000
const UPLOAD_DEADLINE = 60_000

function call<T>(
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs = CALL_DEADLINE,
): Promise<T> {
  return callPlugin<T>(
    AI_IMAGE_PLUGIN_ID,
    AI_IMAGE_CAPABILITY,
    method,
    payload,
    parse,
    deadlineMs,
  )
}

function requestId(value: unknown): string {
  const id = identifier(value)
  text(id, 64, 1)
  return id
}

function allowedKeys(value: unknown, keys: readonly string[]): void {
  if (Object.keys(object(value)).some((key) => !keys.includes(key)))
    throw new Error('AI 生图请求包含不支持的字段。')
}

function submittedRecord(value: unknown): { record: GenerationRecord } {
  try {
    return parseRecordReply(value)
  } catch {
    throw new Error(
      '任务已提交，但返回资料未通过校验。请先查看记录，勿重复提交；更新 AI 生图插件后再使用。',
    )
  }
}

function model(value: unknown, required = true): string {
  const parsed = text(value, 120, required ? 1 : 0)
  if (required && !parsed.trim()) throw new Error('请选择服务商和模型。')
  return parsed
}

function imageIds(value: unknown): string[] {
  return unique(array(value, requestId, 6), (id) => id)
}

function assertRecordId(result: { record: GenerationRecord }, id: string) {
  if (result.record.id !== id) throw new Error('读取到其他生成记录，请重新读取。')
  return result
}

function assertGenerationAccepted(
  record: GenerationRecord,
  input: {
    providerId: string
    imageModel: string
    mode: string
    count: number
    size: string
    inputFileIds: string[]
  },
): void {
  if (
    record.providerId !== input.providerId ||
    record.imageModel !== input.imageModel ||
    record.mode !== input.mode ||
    record.count !== input.count ||
    record.size !== input.size ||
    record.inputs.length !== input.inputFileIds.length ||
    record.inputs.some((file, index) => file.id !== input.inputFileIds[index])
  )
    throw new Error(
      '任务已提交，但插件返回的模型或参考图与请求不同。请先查看记录，勿重复提交。',
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
  imageTimeoutSeconds?: number | undefined
  imageResponseMode?: Provider['imageResponseMode'] | undefined
}

export async function listProviders(): Promise<ProviderCatalog> {
  return call('image.providers.list', {}, parseProviderCatalog)
}

export async function saveProvider(input: ProviderInput): Promise<Provider> {
  allowedKeys(input, [
    'id',
    'name',
    'kind',
    'baseUrl',
    'apiKey',
    'imageModel',
    'visionModel',
    'imageTimeoutSeconds',
    'imageResponseMode',
  ])
  if (input.id !== undefined) requestId(input.id)
  if (!text(input.name, 60, 1).trim()) throw new Error('请填写服务商名称。')
  oneOf(input.kind, ['openai', 'openai_compatible'])
  const url = new URL(text(input.baseUrl, 300, 8))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    return invalid()
  model(input.imageModel, false)
  if (input.visionModel !== undefined) model(input.visionModel, false)
  if (input.apiKey !== undefined) text(input.apiKey, 400)
  if (input.imageTimeoutSeconds !== undefined)
    integer(input.imageTimeoutSeconds, 60, 3600)
  if (input.imageResponseMode !== undefined)
    oneOf(input.imageResponseMode, ['auto', 'stream', 'json'])
  if (
    (input.imageTimeoutSeconds !== undefined || input.imageResponseMode !== undefined) &&
    (await listProviders()).transportSettingsVersion !== 1
  ) {
    throw new Error(PROVIDER_TRANSPORT_UPDATE_HINT)
  }
  const result = await call('image.providers.save', input, parseProvider)
  if (input.id !== undefined && result.id !== input.id)
    throw new Error('服务商保存结果不一致，请刷新确认。')
  return result
}

export function removeProvider(id: string): Promise<{ id: string; removed: boolean }> {
  requestId(id)
  return call('image.providers.remove', { id }, (value) => {
    const result = parseRemoved(value)
    if (result.id !== id) return invalid()
    return result
  })
}

export function testProvider(id: string): Promise<{
  ok: boolean
  message: string
  modelCount: number | null
  durationMs: number
}> {
  requestId(id)
  return call(
    'image.providers.test',
    { id },
    (value) => {
      const row = object(value)
      return {
        ok: bool(row.ok),
        message: text(row.message, 4096),
        modelCount: row.modelCount === null ? null : integer(row.modelCount),
        durationMs: integer(row.durationMs),
      }
    },
    25_000,
  )
}

export interface ProviderImageTestInput {
  id: string
  model: string
  mode: GenerationRecord['mode']
  agingLevel?: AgingLevel
  prompt: string
  size: ImageSize
  inputFileIds: string[]
  photoMetadata?: PhotoMetadata
}

export async function testProviderImage(
  input: ProviderImageTestInput,
): Promise<{ record: GenerationRecord }> {
  allowedKeys(input, [
    'id',
    'model',
    'mode',
    'agingLevel',
    'prompt',
    'size',
    'inputFileIds',
    'photoMetadata',
  ])
  validateAgingLevel(input.agingLevel)
  requestId(input.id)
  model(input.model)
  imageIds(input.inputFileIds)
  if (input.photoMetadata !== undefined) {
    parseMetadata(input.photoMetadata)
    if ((await listProviders()).photoMetadataVersion !== 1)
      throw new Error('请更新 AI 生图插件后使用 EXIF 模板。')
  }
  if (!input.id.trim() || !input.model.trim()) {
    throw new Error('请先保存服务商和生图模型。')
  }
  if (!input.prompt.trim() || input.prompt.length > 12000) {
    throw new Error('请填写测试提示词，最多 12000 字符，不会自动截断。')
  }
  if (
    !['generate', 'edit'].includes(input.mode) ||
    !SIZES.some((size) => size.value === input.size) ||
    input.inputFileIds.length !== (input.mode === 'edit' ? 1 : 0) ||
    input.inputFileIds.some((id) => !id.trim())
  ) {
    throw new Error(
      '请选择有效的测试方式与尺寸；文生图不带参考图，图生图需要一张参考图。',
    )
  }
  const result = await call(PROVIDER_IMAGE_TEST_METHOD, input, submittedRecord)
  assertGenerationAccepted(result.record, {
    ...input,
    providerId: input.id,
    imageModel: input.model,
    count: 1,
  })
  assertAcceptedAgingLevel(input.agingLevel, result?.record?.agingLevel)
  return result
}

export function listPresets(): Promise<{ presets: ScenePreset[] }> {
  return call('image.presets', {}, parsePresets)
}

export async function createScenePlan(input: ScenePlanInput): Promise<ScenePlan> {
  allowedKeys(input, [
    'providerId',
    'model',
    'inputFileId',
    'requirements',
    'count',
    'agingLevel',
  ])
  validateScenePlanInput(input)
  requestId(input.providerId)
  requestId(input.inputFileId)
  model(input.model)
  try {
    const plan = await call('image.plans.create', input, (value) => {
      try {
        return parseScenePlan(object(value).plan)
      } catch {
        throw new Error(
          '识图任务已提交，但返回资料未通过校验。请先查看已有方案，勿重复提交。',
        )
      }
    })
    if (
      plan.providerId !== input.providerId ||
      plan.model !== input.model ||
      plan.inputFileId !== input.inputFileId ||
      plan.count !== input.count ||
      plan.requirements !== input.requirements
    )
      return invalid()
    assertAcceptedAgingLevel(input.agingLevel, plan.agingLevel)
    return plan
  } catch (cause) {
    throw scenePlanError(cause)
  }
}

export async function getScenePlan(id: string): Promise<ScenePlan> {
  requestId(id)
  try {
    const plan = await call('image.plans.get', { id }, (value) =>
      parseScenePlan(object(value).plan),
    )
    if (plan.id !== id) return invalid()
    return plan
  } catch (cause) {
    throw scenePlanError(cause)
  }
}

export async function listRecords(
  page: number,
  size: number,
  status?: RecordStatus,
  source?: SourceIdentity,
  filters: RecordHistoryFilters = {},
): Promise<RecordPage> {
  allowedKeys(filters, ['query', 'kind', 'activity'])
  integer(page, 0, 1000)
  integer(size, 1, 100)
  if (status !== undefined) oneOf(status, ['running', 'success', 'failed'])
  if (filters.kind !== undefined)
    oneOf(filters.kind, ['batch', 'scene', 'single', 'provider-test'])
  if (filters.activity !== undefined) oneOf(filters.activity, ['queued', 'active'])
  if (filters.query !== undefined) text(filters.query, 200)
  const identity = source === undefined ? undefined : sourceIdentity(source)
  const sourceFilter =
    identity === undefined
      ? undefined
      : { sourcePluginId: identity.pluginId, sourceItemId: identity.itemId }
  const query = filters.query?.trim()
  if (query !== undefined && query.length > 200)
    throw new Error('搜索内容最多 200 字符。')
  const historyFilters: RecordHistoryFilters = {
    ...(query ? { query } : {}),
    ...(filters.kind === undefined ? {} : { kind: filters.kind }),
    ...(filters.activity === undefined ? {} : { activity: filters.activity }),
  }
  const hasHistoryFilters = Object.keys(historyFilters).length > 0
  try {
    const result = await call(
      'image.records.list',
      {
        page,
        size,
        ...(status === undefined ? {} : { status }),
        ...sourceFilter,
        ...historyFilters,
      },
      parseRecordPage,
    )
    if (
      result.page !== page ||
      result.pageSize !== size ||
      result.items.some((record) => status !== undefined && record.status !== status)
    )
      return invalid()
    if (
      hasHistoryFilters &&
      Object.entries(historyFilters).some(
        ([key, value]) =>
          result.historyFilters?.[key as keyof RecordHistoryFilters] !== value,
      )
    )
      throw new Error(HISTORY_UPDATE_HINT)
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
    if (
      hasHistoryFilters &&
      /INVALID_REQUEST|请求参数无效|未声明该方法|不支持该方法/.test(message(error))
    )
      throw Object.assign(new Error(HISTORY_UPDATE_HINT), { cause: error })
    if (sourceFilter !== undefined) throw sourceRequestError(error)
    throw error
  }
}

export function getRecord(id: string): Promise<{ record: GenerationRecord }> {
  requestId(id)
  return call('image.records.get', { id }, (value) =>
    assertRecordId(parseRecordReply(value), id),
  )
}

export function removeRecord(id: string): Promise<{ id: string; removed: boolean }> {
  requestId(id)
  return call('image.records.remove', { id }, (value) => {
    const result = parseRemoved(value)
    if (result.id !== id) return invalid()
    return result
  })
}

export function retryRecord(id: string): Promise<{ record: GenerationRecord }> {
  requestId(id)
  return call('image.records.retry', { id }, (value) =>
    assertRecordId(submittedRecord(value), id),
  )
}

export function recognizeRecord(
  input:
    | { id: string; providerId: string; model: string; fileId?: string | null }
    | { id: string; retry: true },
): Promise<{ record: GenerationRecord }> {
  allowedKeys(input, ['id', 'retry', 'providerId', 'model', 'fileId'])
  requestId(input.id)
  if ('retry' in input) {
    if (
      input.retry !== true ||
      Object.keys(input).some((key) => !['id', 'retry'].includes(key))
    )
      return invalid()
  } else {
    requestId(input.providerId)
    model(input.model)
    if (input.fileId != null) requestId(input.fileId)
  }
  return call('image.records.recognize', input, (value) =>
    assertRecordId(submittedRecord(value), input.id),
  )
}

export function exportRecord(id: string): Promise<{ paths: string[] }> {
  requestId(id)
  return call(
    'image.records.export',
    { id },
    (value) => ({ paths: array(object(value).paths, (path) => text(path, 4096, 1), 4) }),
    UPLOAD_DEADLINE,
  )
}

export interface GenerateInput {
  providerId: string
  imageModel: string
  mode: GenerationRecord['mode']
  agingLevel?: AgingLevel
  photoMetadata?: PhotoMetadata
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
  allowedKeys(input, [
    'providerId',
    'imageModel',
    'mode',
    'agingLevel',
    'photoMetadata',
    'presetId',
    'prompt',
    'size',
    'count',
    'inputFileIds',
    'source',
    'visionProviderId',
    'visionModel',
    'visionFileId',
    'scenePlan',
  ])
  validateAgingLevel(input.agingLevel)
  requestId(input.providerId)
  model(input.imageModel)
  oneOf(input.mode, ['generate', 'edit'])
  oneOf(
    input.size,
    SIZES.map((entry) => entry.value),
  )
  integer(input.count, 1, 4)
  imageIds(input.inputFileIds)
  text(input.prompt, 12000)
  if (input.presetId !== null) requestId(input.presetId)
  if (input.photoMetadata !== undefined) parseMetadata(input.photoMetadata)
  if (input.visionProviderId != null) requestId(input.visionProviderId)
  if (input.visionModel != null) model(input.visionModel)
  if (
    input.visionFileId != null &&
    !input.inputFileIds.includes(requestId(input.visionFileId))
  )
    throw new Error('已选识图图片不在参考图中。')
  if (input.mode === 'edit' && input.inputFileIds.length === 0)
    throw new Error('请添加参考图片。')
  if (
    input.mode === 'generate' &&
    (input.inputFileIds.length ||
      input.visionProviderId != null ||
      input.visionModel != null)
  )
    throw new Error('文生图不使用参考图或识图模型。')
  if (input.scenePlan !== undefined) {
    allowedKeys(input.scenePlan, ['id', 'prompt', 'views'])
    requestId(input.scenePlan.id)
    text(input.scenePlan.prompt, 6000, 1)
    const views = unique(
      array(
        input.scenePlan.views,
        (value) => {
          const view = object(value)
          allowedKeys(view, ['id', 'label', 'prompt'])
          return {
            id: requestId(view.id),
            label: text(view.label, 120, 1),
            prompt: text(view.prompt, 4000, 1),
          }
        },
        4,
      ),
      (view) => view.id,
    )
    if (!views.length || views.some((view) => !view.label.trim() || !view.prompt.trim()))
      return invalid()
  }
  if (input.photoMetadata && (await listProviders()).photoMetadataVersion !== 1)
    throw new Error('请更新 AI 生图插件后使用 EXIF 模板。')
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
      submittedRecord,
    )
  } catch (error) {
    if (input.scenePlan !== undefined) throw scenePlanError(error)
    if (source !== undefined) throw sourceRequestError(error)
    throw error
  }
  assertGenerationAccepted(result.record, input)
  assertAcceptedAgingLevel(input.agingLevel, result?.record?.agingLevel)
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

function assertAcceptedAgingLevel(
  expected: AgingLevel | undefined,
  actual: AgingLevel | undefined,
): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error(
      '任务已提交，但插件未保留所选做旧程度。请先查看记录，勿重复提交；更新 AI 生图插件后再使用。',
    )
  }
}

function base64ToBytes(base64: string): Uint8Array {
  if (
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw new Error('图片分块编码无效。')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  if (bytesToBase64(bytes) !== base64) throw new Error('图片分块编码无效。')
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
  photoMetadata?: PhotoMetadata,
): Promise<StoredFile> {
  signal?.throwIfAborted()
  const isFile = input instanceof File
  const mime = isFile ? input.type : input.mime
  text(input.name, 120, 1)
  if (!isFile) text(input.base64, Math.ceil((8 * 1024 * 1024) / 3) * 4, 1)
  const bytes = isFile
    ? new Uint8Array(await input.arrayBuffer())
    : base64ToBytes(input.base64)
  const referenceError = checkReference({ type: mime, size: bytes.byteLength })
  if (referenceError !== null) throw new Error(referenceError)
  if (photoMetadata !== undefined) parseMetadata(photoMetadata)
  if (photoMetadata && (await listProviders()).photoMetadataVersion !== 1)
    throw new Error('请更新 AI 生图插件后使用 EXIF 模板。')
  signal?.throwIfAborted()
  const begun = await call(
    'image.upload.begin',
    {
      mime,
      size: bytes.byteLength,
    },
    (value) => {
      const row = object(value)
      return { uploadId: requestId(row.uploadId), chunkSize: row.chunkSize }
    },
  )
  try {
    signal?.throwIfAborted()
    if (
      typeof begun.chunkSize !== 'number' ||
      !Number.isSafeInteger(begun.chunkSize) ||
      begun.chunkSize < Math.ceil(bytes.byteLength / 10_000) ||
      begun.chunkSize > CHUNK_BYTES
    ) {
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
        (value) => {
          const row = object(value)
          if (
            requestId(row.uploadId) !== begun.uploadId ||
            integer(row.received, 1, bytes.byteLength) !==
              Math.min(offset + step, bytes.byteLength) ||
            integer(row.size, 1, bytes.byteLength) !== bytes.byteLength
          )
            return invalid()
          return { received: row.received }
        },
        UPLOAD_DEADLINE,
      )
      index += 1
    }
    signal?.throwIfAborted()
    const finished = await call(
      'image.upload.finish',
      {
        uploadId: begun.uploadId,
        name: input.name,
        ...(photoMetadata === undefined ? {} : { photoMetadata }),
      },
      parseFileReply,
    )
    if (
      photoMetadata === undefined &&
      (finished.file.bytes !== bytes.byteLength || finished.file.mime !== mime)
    )
      throw new Error('保存的图片与上传内容不一致。')
    if (photoMetadata !== undefined && finished.file.mime !== 'image/jpeg')
      throw new Error('EXIF 图片输出格式无效。')
    signal?.throwIfAborted()
    return finished.file
  } catch (error) {
    await call('image.upload.abort', { uploadId: begun.uploadId }, parseAborted).catch(
      () => undefined,
    )
    throw error
  }
}

/**
 * The webview cannot read a picture from a supplier's CDN (CORS), so the plugin
 * downloads it and stores it like any other upload.
 */
export async function uploadRemoteImage(
  url: string,
  name?: string,
  photoMetadata?: PhotoMetadata,
): Promise<StoredFile> {
  const parsed = new URL(text(url, 2048, 8))
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    return invalid()
  if (name !== undefined) text(name, 120)
  if (photoMetadata !== undefined) parseMetadata(photoMetadata)
  if (photoMetadata && (await listProviders()).photoMetadataVersion !== 1)
    throw new Error('请更新 AI 生图插件后使用 EXIF 模板。')
  return call(
    'image.upload.remote',
    {
      url,
      ...(name === undefined ? {} : { name }),
      ...(photoMetadata === undefined ? {} : { photoMetadata }),
    },
    parseFileReply,
    UPLOAD_DEADLINE,
  ).then((result) => result.file)
}

export async function readImageBytes(
  fileId: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  requestId(fileId)
  signal?.throwIfAborted()
  const parts: Uint8Array[] = []
  let offset = 0
  let total: number | undefined
  for (let index = 0; index < Math.ceil(MAX_IMAGE_BYTES / CHUNK_BYTES); index += 1) {
    signal?.throwIfAborted()
    const reply = await call(
      'image.file.chunk',
      { fileId, offset, length: CHUNK_BYTES },
      parseChunk,
      UPLOAD_DEADLINE,
    )
    signal?.throwIfAborted()
    const bytes = base64ToBytes(reply.data)
    if (total !== undefined && reply.total !== total)
      throw new Error('图片读取期间大小发生变化。')
    total = reply.total
    if (
      bytes.byteLength !== Math.min(CHUNK_BYTES, total - offset) ||
      bytes.byteLength === 0 ||
      reply.next !== offset + bytes.byteLength ||
      reply.next > total ||
      reply.done !== (reply.next === total)
    )
      throw new Error('图片分块不完整或读取进度无效。')
    parts.push(bytes)
    offset = reply.next
    if (reply.done) break
  }
  if (total === undefined || offset !== total) throw new Error('图片读取未完成。')
  signal?.throwIfAborted()
  const bytes = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    bytes.set(part, cursor)
    cursor += part.byteLength
  }
  return bytes
}

const urlCache = new Map<
  string,
  { promise: Promise<string>; controller: AbortController; mime: string }
>()

/**
 * Object URLs are cached per file so a table row and its detail dialog share one
 * download. Deleting a record drops its entry; the browser reclaims the blob.
 */
export function imageObjectUrl(fileId: string, mime: string): Promise<string> {
  requestId(fileId)
  oneOf(mime, ['image/jpeg', 'image/png', 'image/webp'])
  const cached = urlCache.get(fileId)
  if (cached !== undefined) {
    if (cached.mime !== mime)
      return Promise.reject(new Error('图片格式与现有记录不一致。'))
    return cached.promise
  }
  const controller = new AbortController()
  const pending = readImageBytes(fileId, controller.signal).then((bytes) => {
    controller.signal.throwIfAborted()
    // A plain ArrayBuffer is the only BlobPart the DOM types accept here.
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    return URL.createObjectURL(new Blob([buffer], { type: mime }))
  })
  urlCache.set(fileId, { promise: pending, controller, mime })
  pending.catch(() => {
    if (urlCache.get(fileId)?.promise === pending) urlCache.delete(fileId)
  })
  return pending
}

export function forgetImage(fileId: string): void {
  const cached = urlCache.get(fileId)
  urlCache.delete(fileId)
  if (cached !== undefined) {
    cached.controller.abort()
    void cached.promise.then((url) => URL.revokeObjectURL(url)).catch(() => undefined)
  }
}
