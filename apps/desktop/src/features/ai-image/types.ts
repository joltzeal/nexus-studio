import type { GenerationSource } from '@/lib/page-handoff'

export type { GenerationSource } from '@/lib/page-handoff'

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
  visionModel?: string
  hasApiKey: boolean
  apiKeyHint: string
  createdAt: string
  updatedAt: string
}

export interface ModelSelection {
  providerId: string
  model: string
}

export interface ModelSelections {
  image: ModelSelection | null
  vision: ModelSelection | null
}

export interface ProviderCatalog {
  items: Provider[]
  storageDurable: boolean
  modelConfigVersion: number
  selections: ModelSelections
}

export interface StoredFile {
  id: string
  name: string
  mime: string
  bytes: number
}

export interface SceneView {
  id: string
  label: string
  prompt: string
}

export interface ScenePlanResult {
  /** Absent only in plans saved by older plugin versions. */
  title?: string
  description?: string
  product: string
  material: string
  observations: string
  uncertainties: string
  presetId: string
  reason: string
  prompt: string
  views: SceneView[]
}

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
  result: ScenePlanResult | null
  error: string | null
}

export interface SceneViewRecord extends SceneView {
  status: 'queued' | 'running' | 'success' | 'failed'
  outputFileId: string | null
  error: string | null
  effectivePrompt: string
}

export function viewStatusText(status: SceneViewRecord['status']): string {
  return { queued: '等待生成', running: '正在生成', success: '已完成', failed: '失败' }[
    status
  ]
}

export interface GenerationRecord {
  id: string
  source?: GenerationSource
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
  /** Retained only when reading historical records. */
  textModel?: string
  copySupportsVision?: boolean
  scenePlan?: {
    plan: ScenePlan
    prompt: string
    views: SceneViewRecord[]
  }
  vision?: {
    providerId: string
    providerName: string
    providerKind: ProviderKind
    model: string
    inputFileId: string
    title?: string | null
    description: string | null
    prompt?: string | null
  } | null
  outputVision?: {
    providerId: string
    providerName: string
    providerKind: ProviderKind
    model: string
    outputFileId: string
    status: RecordStatus
    title?: string | null
    description: string | null
    prompt?: string | null
    error: string | null
  } | null
  inputs: StoredFile[]
  outputs: StoredFile[]
  title: string | null
  description: string | null
  error: string | null
  copyError?: string | null
  durationMs: number | null
}

/** Prompt/source-title previews are capped at 500/120 escaped JSON UTF-8 bytes. */
export interface GenerationSummary extends Pick<
  GenerationRecord,
  | 'id'
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
  outputVision?: { status: RecordStatus } | null
}

type RecordProgress = Pick<
  GenerationSummary,
  'status' | 'stage' | 'scenePlan' | 'outputVision'
>

export interface ScenePreset {
  id: string
  label: string
  /** Older installed plugin packages may not yet include categories. */
  category?: string
  hint: string
  prompt: string
}

export interface RecordPage {
  items: GenerationSummary[]
  total: number
  page: number
  pageSize: number
  storageDurable: boolean
  sourceFilter?: { sourcePluginId: string; sourceItemId: string }
}

export const PROVIDER_KINDS: { value: ProviderKind; label: string; hint: string }[] = [
  {
    value: 'openai',
    label: 'OpenAI 官方',
    hint: 'api.openai.com，配置识图或生图模型',
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

export function statusText(record: RecordProgress): string {
  if (record.outputVision?.status === 'running') return '正在识别成片'
  const progress = sceneProgress(record)
  if (progress !== null) {
    const fraction = `${String(progress.completed)}/${String(progress.total)}`
    if (record.status === 'failed')
      return `${progress.completed > 0 ? '部分完成' : '失败'} · ${fraction}`
    if (record.status === 'success') return `已完成 · ${fraction}`
    return `正在生成视角 · ${fraction}`
  }
  if (record.status === 'success') return '已生成'
  if (record.status === 'failed') return '失败'
  if (record.stage === 'vision') return '正在识别参考图'
  if (record.stage === 'copy') return '正在写文案'
  if (record.stage === 'image') return '正在生成图片'
  return '排队中'
}

export function sceneProgress(
  record: Pick<RecordProgress, 'scenePlan'>,
): { completed: number; total: number } | null {
  if (!record.scenePlan) return null
  return {
    completed: record.scenePlan.views.filter(
      (view) => view.status === 'success' && view.outputFileId !== null,
    ).length,
    total: record.scenePlan.views.length,
  }
}

export function recordTitle(
  record: Pick<GenerationSummary, 'title' | 'presetLabel' | 'mode'>,
): string {
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
