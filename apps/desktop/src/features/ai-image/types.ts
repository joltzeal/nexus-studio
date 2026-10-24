export const AI_IMAGE_PLUGIN_ID = 'studio.ai-image'
export const AI_IMAGE_CAPABILITY = 'image.provider'

export type ProviderKind = 'openai' | 'openai_compatible'
export type RecordStatus = 'running' | 'success' | 'failed'
export type RecordStage = 'queued' | 'vision' | 'copy' | 'image' | 'done'
export type GenerationMode = 'generate' | 'edit'

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  imageModel: string
  textModel: string
  visionModel?: string
  supportsVision: boolean
  hasApiKey: boolean
  apiKeyHint: string
  createdAt: string
  updatedAt: string
}

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
  prompt: string
  basePrompt?: string
  presetId: string | null
  presetLabel: string | null
  size: string
  count: number
  providerId: string
  providerName: string
  providerKind: ProviderKind
  imageModel: string
  textModel: string
  copySupportsVision?: boolean
  vision?: {
    providerId: string
    providerName: string
    providerKind: ProviderKind
    model: string
    inputFileId: string
    description: string | null
  } | null
  outputVision?: {
    providerId: string
    providerName: string
    providerKind: ProviderKind
    model: string
    outputFileId: string
    status: RecordStatus
    description: string | null
    error: string | null
  } | null
  inputs: StoredFile[]
  outputs: StoredFile[]
  title: string | null
  description: string | null
  error: string | null
  copyError: string | null
  durationMs: number | null
}

export interface ScenePreset {
  id: string
  label: string
  /** Older installed plugin packages may not yet include categories. */
  category?: string
  hint: string
  prompt: string
}

export interface RecordPage {
  items: GenerationRecord[]
  total: number
  page: number
  pageSize: number
  storageDurable: boolean
}

export const PROVIDER_KINDS: { value: ProviderKind; label: string; hint: string }[] = [
  {
    value: 'openai',
    label: 'OpenAI 官方',
    hint: 'api.openai.com，使用官方生图与文案模型',
  },
  {
    value: 'openai_compatible',
    label: 'OpenAI 兼容',
    hint: '自建网关或第三方兼容接口，需填写基础地址',
  },
]

export const SIZES: { value: string; label: string }[] = [
  { value: '1024x1024', label: '方形 1024 × 1024' },
  { value: '1024x1536', label: '竖图 1024 × 1536' },
  { value: '1536x1024', label: '横图 1536 × 1024' },
  { value: 'auto', label: '由模型决定' },
]

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** Tauri rejects with the command's `Err(String)`, which is not an `Error`. */
export function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '请求失败，请稍后重试'
}

export function statusText(record: GenerationRecord): string {
  if (record.outputVision?.status === 'running') return '正在识别成片'
  if (record.status === 'success') return '已生成'
  if (record.status === 'failed') return '失败'
  if (record.stage === 'vision') return '正在识别参考图'
  if (record.stage === 'copy') return '正在写文案'
  if (record.stage === 'image') return '正在生成图片'
  return '排队中'
}

export function recordTitle(record: GenerationRecord): string {
  if (record.title !== null && record.title !== '') return record.title
  if (record.presetLabel !== null) return record.presetLabel
  return record.mode === 'edit' ? '改图' : '文生图'
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} 毫秒`
  return `${(ms / 1000).toFixed(1)} 秒`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
