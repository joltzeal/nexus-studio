import { parsePhotoMetadata, type PhotoMetadata } from './photo-metadata'
import { parseScenePlan } from './scene-plan'
import { generationSource } from './source'
import {
  DEFAULT_IMAGE_RESPONSE_MODE,
  DEFAULT_IMAGE_TIMEOUT_SECONDS,
  isAgingLevel,
  type GenerationRecord,
  type GenerationSummary,
  type Provider,
  type ProviderCatalog,
  type RecordHistoryFilters,
  type RecordPage,
  type ScenePreset,
  type SceneViewRecord,
  type StoredFile,
} from './types'

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024
export const CHUNK_BYTES = 256 * 1024
const MAX_TEXT = 1024 * 1024

export function invalid(): never {
  throw new Error('AI 生图插件返回资料无效，请更新插件后重试。')
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

export function text(value: unknown, max = MAX_TEXT, min = 0): string {
  if (typeof value !== 'string' || value.length > max || value.length < min)
    return invalid()
  return value
}

export function identifier(value: unknown): string {
  const parsed = text(value, 128, 1)
  if (parsed.trim() !== parsed || !parsed.trim()) return invalid()
  return parsed
}

export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return invalid()
  return value
}

export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid()
  return value
}

export function oneOf<const T extends readonly string[]>(
  value: unknown,
  options: T,
): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) return invalid()
  return value as T[number]
}

export function array<T>(value: unknown, parse: (entry: unknown) => T, max = 1000): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid()
  return value.map(parse)
}

function nullable(value: unknown): string | null {
  return value === null ? null : text(value)
}

function timestamp(value: unknown): string {
  const parsed = text(value, 100, 1)
  if (!Number.isFinite(Date.parse(parsed))) return invalid()
  return parsed
}

export function unique<T>(items: T[], key: (entry: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) return invalid()
  return items
}

const statuses = ['running', 'success', 'failed'] as const
const kinds = ['openai', 'openai_compatible'] as const
const mimes = ['image/jpeg', 'image/png', 'image/webp'] as const

export function parseProvider(value: unknown): Provider {
  const row = object(value)
  if ('apiKey' in row || 'key' in row) return invalid()
  const baseUrl = text(row.baseUrl, 2048, 1)
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    return invalid()
  return {
    id: identifier(row.id),
    name: text(row.name, 200, 1),
    kind: oneOf(row.kind, kinds),
    baseUrl,
    imageModel: text(row.imageModel, 200),
    ...(row.visionModel === undefined ? {} : { visionModel: text(row.visionModel, 200) }),
    imageTimeoutSeconds:
      row.imageTimeoutSeconds === undefined
        ? DEFAULT_IMAGE_TIMEOUT_SECONDS
        : integer(row.imageTimeoutSeconds, 60, 3600),
    imageResponseMode:
      row.imageResponseMode === undefined
        ? DEFAULT_IMAGE_RESPONSE_MODE
        : oneOf(row.imageResponseMode, ['auto', 'stream', 'json']),
    hasApiKey: bool(row.hasApiKey),
    apiKeyHint: text(row.apiKeyHint, 128),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  }
}

export function parseProviderCatalog(value: unknown): ProviderCatalog {
  const row = object(value)
  const selections = row.selections === undefined ? {} : object(row.selections)
  function selection(value: unknown) {
    if (value == null) return null
    const pair = object(value)
    return { providerId: identifier(pair.providerId), model: text(pair.model, 200, 1) }
  }
  return {
    items: unique(array(row.items, parseProvider, 200), (entry) => entry.id),
    storageDurable: bool(row.storageDurable),
    modelConfigVersion:
      row.modelConfigVersion === undefined ? 1 : integer(row.modelConfigVersion, 1),
    transportSettingsVersion: row.transportSettingsVersion === 1 ? 1 : 0,
    ...(row.photoMetadataVersion === 1 ? { photoMetadataVersion: 1 } : {}),
    selections: {
      image: selection(selections.image),
      vision: selection(selections.vision),
    },
  }
}

export function parseStoredFile(value: unknown): StoredFile {
  const row = object(value)
  return {
    id: identifier(row.id),
    name: text(row.name, 200, 1),
    mime: oneOf(row.mime, mimes),
    bytes: integer(row.bytes, 1, MAX_IMAGE_BYTES),
  }
}

export function parseMetadata(value: unknown): PhotoMetadata {
  const row = object(value)
  function number(key: string): string {
    if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) return invalid()
    return String(row[key])
  }
  return parsePhotoMetadata({
    make: text(row.make, 100, 1),
    model: text(row.model, 200, 1),
    lensModel: text(row.lensModel, 300, 1),
    dateTimeOriginal: text(row.dateTimeOriginal, 30),
    modifiedAt: text(row.modifiedAt, 30),
    aperture: number('aperture'),
    exposureBias: number('exposureBias'),
    exposureTime: text(row.exposureTime, 40),
    exposureMode: oneOf(row.exposureMode, ['auto', 'manual']),
    exposureProgram: oneOf(row.exposureProgram, ['auto', 'manual']),
    meteringMode: oneOf(row.meteringMode, ['multi-segment', 'center-weighted', 'spot']),
    flash: oneOf(row.flash, ['no', 'no-compulsory', 'yes']),
    focalLength: number('focalLength'),
    whiteBalance: oneOf(row.whiteBalance, ['auto', 'manual']),
    orientation: row.orientation === 1 ? 1 : invalid(),
    xResolution: number('xResolution'),
    yResolution: number('yResolution'),
    resolutionUnit: oneOf(row.resolutionUnit, ['inch', 'cm']),
    software: text(row.software, 200),
  })
}

function commonRecord(value: unknown) {
  const row = object(value)
  if (row.agingLevel !== undefined && !isAgingLevel(row.agingLevel)) return invalid()
  const source = row.source === undefined ? undefined : object(row.source)
  return {
    id: identifier(row.id),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    status: oneOf(row.status, statuses),
    stage: oneOf(row.stage, ['queued', 'vision', 'copy', 'image', 'done']),
    mode: oneOf(row.mode, ['generate', 'edit']),
    prompt: text(row.prompt),
    ...(row.purpose === undefined
      ? {}
      : { purpose: oneOf(row.purpose, ['provider-test']) }),
    ...(isAgingLevel(row.agingLevel) ? { agingLevel: row.agingLevel } : {}),
    ...(source === undefined
      ? {}
      : {
          source: generationSource({
            pluginId: identifier(source.pluginId),
            itemId: identifier(source.itemId),
            title: text(source.title, 500, 1),
            url: text(source.url, 2048, 1),
          }),
        }),
    presetId: row.presetId === null ? null : identifier(row.presetId),
    presetLabel: nullable(row.presetLabel),
    size: text(row.size, 100, 1),
    count: integer(row.count, 1, 4),
    providerId: identifier(row.providerId),
    providerName: text(row.providerName, 200),
    providerKind: oneOf(row.providerKind, kinds),
    imageModel: text(row.imageModel, 200),
    title: nullable(row.title),
    durationMs: row.durationMs === null ? null : integer(row.durationMs),
  }
}

function vision(value: unknown) {
  const row = object(value)
  return {
    providerId: identifier(row.providerId),
    providerName: text(row.providerName, 200),
    providerKind: oneOf(row.providerKind, kinds),
    model: text(row.model, 200, 1),
    description: nullable(row.description),
    ...(row.title === undefined ? {} : { title: nullable(row.title) }),
    ...(row.prompt === undefined ? {} : { prompt: nullable(row.prompt) }),
    ...Object.fromEntries(
      [
        'product',
        'visibleDesign',
        'confirmedWear',
        'uncertainties',
        'translatedRequirements',
      ]
        .filter((key) => row[key] !== undefined)
        .map((key) => [key, text(row[key])]),
    ),
  }
}

function parseView(value: unknown): SceneViewRecord {
  const row = object(value)
  return {
    id: identifier(row.id),
    label: text(row.label, 120, 1),
    prompt: text(row.prompt, 4000, 1),
    status: oneOf(row.status, ['queued', 'running', 'success', 'failed']),
    outputFileId: row.outputFileId === null ? null : identifier(row.outputFileId),
    error: nullable(row.error),
    effectivePrompt: text(row.effectivePrompt),
  }
}

export function parseRecord(value: unknown): GenerationRecord {
  const row = object(value)
  const record: GenerationRecord = {
    ...commonRecord(row),
    inputs: unique(array(row.inputs, parseStoredFile, 6), (file) => file.id),
    outputs: unique(array(row.outputs, parseStoredFile, 4), (file) => file.id),
    description: nullable(row.description),
    error: nullable(row.error),
  }
  if (row.basePrompt !== undefined) record.basePrompt = text(row.basePrompt)
  if (row.userRequirements !== undefined)
    record.userRequirements = text(row.userRequirements)
  if (row.textModel !== undefined) record.textModel = text(row.textModel, 200)
  if (row.copySupportsVision !== undefined)
    record.copySupportsVision = bool(row.copySupportsVision)
  if (row.copyError !== undefined) record.copyError = nullable(row.copyError)
  if (row.exportError !== undefined) record.exportError = nullable(row.exportError)
  if (row.exportedPaths !== undefined)
    record.exportedPaths = array(row.exportedPaths, (value) => text(value, 4096, 1), 4)
  if (row.photoMetadata !== undefined)
    record.photoMetadata = parseMetadata(row.photoMetadata)
  if (row.vision !== undefined) {
    const raw = row.vision === null ? null : object(row.vision)
    record.vision =
      raw === null ? null : { ...vision(raw), inputFileId: identifier(raw.inputFileId) }
    if (
      record.vision &&
      !record.inputs.some((file) => file.id === record.vision?.inputFileId)
    )
      return invalid()
  }
  if (row.outputVision !== undefined) {
    const raw = row.outputVision === null ? null : object(row.outputVision)
    record.outputVision =
      raw === null
        ? null
        : {
            ...vision(raw),
            outputFileId: identifier(raw.outputFileId),
            status: oneOf(raw.status, statuses),
            error: nullable(raw.error),
          }
    if (
      record.outputVision &&
      !record.outputs.some((file) => file.id === record.outputVision?.outputFileId)
    )
      return invalid()
  }
  if (row.scenePlan !== undefined) {
    const scene = object(row.scenePlan)
    const plan = parseScenePlan(scene.plan)
    const views = unique(array(scene.views, parseView, 4), (view) => view.id)
    if (
      plan.count !== record.count ||
      views.length !== record.count ||
      !record.inputs.some((file) => file.id === plan.inputFileId) ||
      views.some(
        (view, index) =>
          view.id !== plan.result?.views[index]?.id ||
          (view.outputFileId !== null &&
            !record.outputs.some((file) => file.id === view.outputFileId)) ||
          (view.status === 'success' && view.outputFileId === null),
      )
    )
      return invalid()
    record.scenePlan = { plan, prompt: text(scene.prompt, 6000, 1), views }
  }
  if (record.outputs.length > record.count) return invalid()
  return record
}

export function parseSummary(value: unknown): GenerationSummary {
  const row = object(value)
  const summary: GenerationSummary = {
    ...commonRecord(row),
    outputs: unique(
      array(
        row.outputs,
        (value) => {
          const file = object(value)
          return { id: identifier(file.id), mime: oneOf(file.mime, mimes) }
        },
        4,
      ),
      (file) => file.id,
    ),
  }
  if (row.scenePlan !== undefined)
    summary.scenePlan = {
      views: array(
        object(row.scenePlan).views,
        (value) => {
          const view = object(value)
          return {
            status: oneOf(view.status, ['queued', 'running', 'success', 'failed']),
            outputFileId:
              view.outputFileId === null ? null : identifier(view.outputFileId),
          }
        },
        4,
      ),
    }
  if (row.outputVision !== undefined)
    summary.outputVision =
      row.outputVision === null
        ? null
        : { status: oneOf(object(row.outputVision).status, statuses) }
  return summary
}

export function parseHistoryFilters(value: unknown): RecordHistoryFilters {
  const row = object(value)
  return {
    ...(row.query === undefined ? {} : { query: text(row.query, 200, 1) }),
    ...(row.kind === undefined
      ? {}
      : { kind: oneOf(row.kind, ['batch', 'scene', 'single', 'provider-test']) }),
    ...(row.activity === undefined
      ? {}
      : { activity: oneOf(row.activity, ['queued', 'active']) }),
  }
}

export function parseRecordPage(value: unknown): RecordPage {
  const row = object(value)
  const source = row.sourceFilter === undefined ? undefined : object(row.sourceFilter)
  const result = {
    items: unique(array(row.items, parseSummary, 100), (record) => record.id),
    total: integer(row.total),
    page: integer(row.page),
    pageSize: integer(row.pageSize, 1, 100),
    storageDurable: bool(row.storageDurable),
    ...(source === undefined
      ? {}
      : {
          sourceFilter: {
            sourcePluginId: identifier(source.sourcePluginId),
            sourceItemId: identifier(source.sourceItemId),
          },
        }),
    ...(row.historyFilters === undefined
      ? {}
      : { historyFilters: parseHistoryFilters(row.historyFilters) }),
  }
  if (result.items.length > result.pageSize || result.items.length > result.total)
    return invalid()
  return result
}

export function parsePresets(value: unknown): { presets: ScenePreset[] } {
  return {
    presets: unique(
      array(
        object(value).presets,
        (value) => {
          const row = object(value)
          return {
            id: identifier(row.id),
            label: text(row.label, 200, 1),
            hint: text(row.hint),
            prompt: text(row.prompt),
            ...(row.category === undefined ? {} : { category: text(row.category, 200) }),
          }
        },
        1000,
      ),
      (preset) => preset.id,
    ),
  }
}

export function parseRecordReply(value: unknown): { record: GenerationRecord } {
  return { record: parseRecord(object(value).record) }
}

export function parseFileReply(value: unknown): { file: StoredFile } {
  return { file: parseStoredFile(object(value).file) }
}

export function parseRemoved(value: unknown) {
  const row = object(value)
  return { id: identifier(row.id), removed: bool(row.removed) }
}

export function parseAborted(value: unknown) {
  return { aborted: bool(object(value).aborted) }
}

export function parseChunk(value: unknown) {
  const row = object(value)
  return {
    data: text(row.data, Math.ceil(CHUNK_BYTES / 3) * 4),
    next: integer(row.next, 0, MAX_IMAGE_BYTES),
    done: bool(row.done),
    total: integer(row.total, 1, MAX_IMAGE_BYTES),
  }
}
