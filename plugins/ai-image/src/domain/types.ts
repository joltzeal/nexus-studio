/** The two providers the plugin supports. Website task channels are out of scope. */
export type ProviderKind = 'openai' | 'openai_compatible'

export interface ProviderRecord {
  id: string
  name: string
  kind: ProviderKind
  /** Normalised to include the API version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl: string
  /**
   * Stored as plain text in the plugin's private document, by explicit product
   * decision: the user owns the key and the page can show it back. It is never
   * written to logs and never leaves the plugin except as an auth header.
   */
  apiKey: string
  imageModel: string
  /** Missing legacy values are read as empty, never inferred from another model. */
  visionModel: string
  createdAt: string
  updatedAt: string
}

/** What the page receives: the key itself is replaced by a presence flag and a hint. */
export interface ProviderView {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  imageModel: string
  visionModel: string
  hasApiKey: boolean
  apiKeyHint: string
  createdAt: string
  updatedAt: string
}

export type GenerationMode = 'generate' | 'edit'
export type RecordStatus = 'running' | 'success' | 'failed'
export type RecordStage = 'queued' | 'vision' | 'copy' | 'image' | 'done'

export interface ModelSelection {
  providerId: string
  model: string
}

export interface ModelSelections {
  image: ModelSelection | null
  vision: ModelSelection | null
}

export interface VisionResult {
  title: string
  description: string
  prompt: string
}

/** A file the plugin owns under its private `images/` directory. */
export interface StoredFile {
  id: string
  name: string
  mime: string
  bytes: number
}

export interface VisionRecord {
  providerId: string
  providerName: string
  providerKind: ProviderKind
  model: string
  /** Exactly one of this record's inputs, resolved before the job starts. */
  inputFileId: string
  description: string | null
  /** Optional only for historical recognition results. */
  title?: string | null
  prompt?: string | null
}

export interface OutputVisionRecord {
  providerId: string
  providerName: string
  providerKind: ProviderKind
  model: string
  outputFileId: string
  status: RecordStatus
  description: string | null
  title?: string | null
  prompt?: string | null
  error: string | null
}

/** Public source metadata, never included in model requests. */
export interface GenerationSource {
  pluginId: string
  itemId: string
  title: string
  url: string
}

export interface SceneView {
  id: string
  label: string
  prompt: string
}

export interface ScenePlanResult {
  title: string
  description: string
  product: string
  material: string
  observations: string
  uncertainties: string
  presetId: string
  reason: string
  prompt: string
  views: SceneView[]
}

/** Older plans did not return listing text; reading them must not invent it. */
export type StoredScenePlanResult = Omit<ScenePlanResult, 'title' | 'description'> &
  Partial<Pick<ScenePlanResult, 'title' | 'description'>>

export interface ScenePlan {
  id: string
  createdAt: string
  updatedAt: string
  status: RecordStatus
  providerId: string
  providerName: string
  providerKind: ProviderKind
  model: string
  inputFileId: string
  requirements: string
  count: number
  result: StoredScenePlanResult | null
  error: string | null
}

export interface SceneViewRecord extends SceneView {
  status: 'queued' | RecordStatus
  outputFileId: string | null
  error: string | null
  effectivePrompt: string
}

export interface GenerationRecord {
  id: string
  purpose?: 'provider-test'
  /** Absent on legacy records and generations started without a source. */
  source?: GenerationSource
  scenePlan?: {
    plan: ScenePlan
    prompt: string
    views: SceneViewRecord[]
  }
  createdAt: string
  updatedAt: string
  status: RecordStatus
  stage: RecordStage
  mode: GenerationMode
  /** The final prompt sent to the image model, already composed with the preset. */
  prompt: string
  /** Preset + user constraints before recognition, reused unchanged on retry. */
  basePrompt?: string
  presetId: string | null
  presetLabel: string | null
  size: string
  count: number
  providerId: string
  providerName: string
  providerKind: ProviderKind
  imageModel: string
  /** Historical fields only: never used for new model requests. */
  textModel?: string
  copySupportsVision?: boolean
  /** Missing on legacy records means no separate recognition request. */
  vision?: VisionRecord | null
  outputVision?: OutputVisionRecord | null
  inputs: StoredFile[]
  outputs: StoredFile[]
  title: string | null
  description: string | null
  /** Recognition/image failure. Keeps model and input selections for retry. */
  error: string | null
  /** Historical copy-stage failure, retained without running a copy model. */
  copyError?: string | null
  durationMs: number | null
}

/**
 * List-only projection; get/retry and the stored record retain complete data.
 * Prompt/source-title previews are capped at 500/120 serialized UTF-8 bytes.
 * Source identifiers and URLs are unchanged. No copy, reference, or plan text
 * is returned here; consumers open get for the complete record.
 */
export interface GenerationSummary extends Pick<
  GenerationRecord,
  | 'id'
  | 'purpose'
  | 'source'
  | 'createdAt'
  | 'updatedAt'
  | 'status'
  | 'stage'
  | 'mode'
  | 'prompt'
  | 'presetId'
  | 'presetLabel'
  | 'size'
  | 'count'
  | 'providerId'
  | 'providerName'
  | 'providerKind'
  | 'imageModel'
  | 'title'
  | 'durationMs'
> {
  outputs: Pick<StoredFile, 'id' | 'mime'>[]
  scenePlan?: { views: Pick<SceneViewRecord, 'status' | 'outputFileId'>[] }
  outputVision?: Pick<OutputVisionRecord, 'status'> | null
}

export const MAX_RECORDS = 120
export const MAX_PLANS = 120
export const MAX_INPUT_BYTES = 8 * 1024 * 1024
export const UPLOAD_CHUNK_BYTES = 192 * 1024

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/**
 * A remote image is identified by its bytes, not its `content-type`: CDNs that
 * serve photos as `application/octet-stream` are common enough that trusting the
 * header would reject perfectly good product pictures.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

export function extensionFor(mime: string): string | null {
  return MIME_EXTENSIONS[mime] ?? null
}

export function mimeFor(extension: string): string {
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  return 'application/octet-stream'
}

/** `sk-abcdef123456` becomes `sk-…3456`; short keys are masked entirely. */
export function apiKeyHint(apiKey: string): string {
  if (apiKey === '') return ''
  if (apiKey.length <= 8) return '已填写'
  return `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`
}

export function providerView(record: ProviderRecord): ProviderView {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    baseUrl: record.baseUrl,
    imageModel: record.imageModel,
    visionModel: record.visionModel,
    hasApiKey: record.apiKey !== '',
    apiKeyHint: apiKeyHint(record.apiKey),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
