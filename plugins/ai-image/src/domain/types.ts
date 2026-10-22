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
  textModel: string
  supportsVision: boolean
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
  textModel: string
  supportsVision: boolean
  hasApiKey: boolean
  apiKeyHint: string
  createdAt: string
  updatedAt: string
}

export type GenerationMode = 'generate' | 'edit'
export type RecordStatus = 'running' | 'success' | 'failed'
export type RecordStage = 'queued' | 'copy' | 'image' | 'done'

/** A file the plugin owns under its private `images/` directory. */
export interface StoredFile {
  id: string
  name: string
  mime: string
  bytes: number
}

export interface GenerationRecord {
  id: string
  createdAt: string
  updatedAt: string
  status: RecordStatus
  stage: RecordStage
  mode: GenerationMode
  /** The final prompt sent to the image model, already composed with the preset. */
  prompt: string
  presetId: string | null
  presetLabel: string | null
  size: string
  count: number
  providerId: string
  providerName: string
  providerKind: ProviderKind
  imageModel: string
  textModel: string
  inputs: StoredFile[]
  outputs: StoredFile[]
  title: string | null
  description: string | null
  /** Image-stage failure. A failed record keeps its prompt and inputs so retry works. */
  error: string | null
  /** Copy-stage failure. The image can still succeed, so it is reported separately. */
  copyError: string | null
  durationMs: number | null
}

export const MAX_RECORDS = 120
export const MAX_INPUT_BYTES = 8 * 1024 * 1024
export const UPLOAD_CHUNK_BYTES = 192 * 1024

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
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
    textModel: record.textModel,
    supportsVision: record.supportsVision,
    hasApiKey: record.apiKey !== '',
    apiKeyHint: apiKeyHint(record.apiKey),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
