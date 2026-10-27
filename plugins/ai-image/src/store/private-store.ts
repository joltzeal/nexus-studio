import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { unavailable } from '../domain/errors.js'
import { GenerationSourceSchema } from '../domain/schemas.js'
import {
  distinctViews,
  scenePlanResultFields,
  sceneViewFields,
} from '../domain/scene-plan.js'
import {
  MAX_PLANS,
  type GenerationRecord,
  type ModelSelections,
  type ProviderRecord,
  type ScenePlan,
} from '../domain/types.js'

export interface StoreDocument {
  schemaVersion: 1
  providers: ProviderRecord[]
  records: GenerationRecord[]
  plans: ScenePlan[]
  selections: ModelSelections
}

export interface PrivateStore {
  readonly kind: 'file' | 'memory'
  /** False means a restart loses data; the plugin reports this instead of hiding it. */
  readonly durable: boolean
  read(): Promise<StoreDocument>
  /**
   * Applies a mutation to a copy, persists it, then swaps it in. A failed write
   * leaves the previous document intact and rethrows, so a caller can never
   * report "saved" for data that was not written.
   */
  mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T>
}

const providerSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['openai', 'openai_compatible']),
  baseUrl: z.string(),
  apiKey: z.string(),
  imageModel: z.string(),
  visionModel: z.string().max(120).default(''),
  textModel: z.string().optional(),
  supportsVision: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const storedFileSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  bytes: z.number(),
})

const scenePlanResultSchema = z.looseObject({
  ...scenePlanResultFields,
  title: scenePlanResultFields.title.optional(),
  description: scenePlanResultFields.description.optional(),
  views: z.array(z.looseObject(sceneViewFields)).min(1).max(4).refine(distinctViews),
})

const scenePlanSchema = z
  .looseObject({
    id: z.string().min(1).max(64),
    createdAt: z.string(),
    updatedAt: z.string(),
    status: z.enum(['running', 'success', 'failed']),
    providerId: z.string().min(1).max(64),
    providerName: z.string(),
    providerKind: z.enum(['openai', 'openai_compatible']),
    model: z.string().min(1).max(120),
    inputFileId: z.string().min(1).max(64),
    requirements: z.string().max(12000),
    count: z.number().int().min(1).max(4),
    result: scenePlanResultSchema.nullable(),
    error: z.string().nullable(),
  })
  .refine((plan) =>
    plan.status === 'success'
      ? plan.result !== null && plan.result.views.length === plan.count
      : plan.result === null,
  )

const scenePlanSnapshotSchema = z.looseObject({
  plan: scenePlanSchema.refine((plan) => plan.status === 'success'),
  prompt: scenePlanResultFields.prompt,
  views: z
    .array(
      z
        .looseObject({
          ...sceneViewFields,
          status: z.enum(['queued', 'running', 'success', 'failed']),
          outputFileId: z.string().min(1).max(64).nullable(),
          error: z.string().nullable(),
          effectivePrompt: z.string().min(1).max(100000),
        })
        .refine((view) => (view.status === 'success') === (view.outputFileId !== null)),
    )
    .min(1)
    .max(4)
    .refine(distinctViews),
})

const recordSchema = z
  .looseObject({
    id: z.string(),
    purpose: z.literal('provider-test').optional(),
    source: GenerationSourceSchema.optional(),
    scenePlan: scenePlanSnapshotSchema.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    status: z.enum(['running', 'success', 'failed']),
    stage: z.enum(['queued', 'vision', 'copy', 'image', 'done']),
    mode: z.enum(['generate', 'edit']),
    prompt: z.string(),
    basePrompt: z.string().optional(),
    presetId: z.string().nullable(),
    presetLabel: z.string().nullable(),
    size: z.string(),
    count: z.number(),
    providerId: z.string(),
    providerName: z.string(),
    providerKind: z.enum(['openai', 'openai_compatible']),
    imageModel: z.string(),
    textModel: z.string().optional(),
    copySupportsVision: z.boolean().optional(),
    vision: z
      .looseObject({
        providerId: z.string().min(1),
        providerName: z.string(),
        providerKind: z.enum(['openai', 'openai_compatible']),
        model: z.string().trim().min(1).max(120),
        inputFileId: z.string().min(1),
        description: z.string().nullable(),
        title: z.string().max(500).nullable().optional(),
        prompt: z.string().max(6000).nullable().optional(),
      })
      .nullable()
      .default(null),
    outputVision: z
      .looseObject({
        providerId: z.string().min(1),
        providerName: z.string(),
        providerKind: z.enum(['openai', 'openai_compatible']),
        model: z.string().trim().min(1).max(120),
        outputFileId: z.string().min(1),
        status: z.enum(['running', 'success', 'failed']),
        description: z.string().nullable(),
        title: z.string().max(500).nullable().optional(),
        prompt: z.string().max(6000).nullable().optional(),
        error: z.string().nullable(),
      })
      .nullable()
      .default(null),
    inputs: z.array(storedFileSchema),
    outputs: z.array(storedFileSchema),
    title: z.string().nullable(),
    description: z.string().nullable(),
    error: z.string().nullable(),
    copyError: z.string().nullable().optional(),
    durationMs: z.number().nullable(),
  })
  .refine(
    (record) =>
      record.vision === null ||
      record.inputs.some((file) => file.id === record.vision?.inputFileId),
    { message: '识图图片必须属于记录的参考图' },
  )
  .refine(
    (record) =>
      record.outputVision === null ||
      record.outputs.some((file) => file.id === record.outputVision?.outputFileId),
    { message: '成片识图图片必须属于记录的输出图' },
  )
  .refine(
    (record) => {
      const scene = record.scenePlan
      if (scene === undefined) return true
      return (
        record.mode === 'edit' &&
        record.count === scene.views.length &&
        record.inputs.some((file) => file.id === scene.plan.inputFileId) &&
        scene.views.every(
          (view) =>
            scene.plan.result?.views.some((original) => original.id === view.id) &&
            (view.outputFileId === null ||
              record.outputs.some((file) => file.id === view.outputFileId)),
        )
      )
    },
    { message: '场景规划与参考图、视角或成片不一致' },
  )

const selectionSchema = z.looseObject({
  providerId: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(120),
})

const documentSchema = z.looseObject({
  schemaVersion: z.literal(1),
  providers: z.array(providerSchema),
  records: z.array(recordSchema),
  plans: z.array(scenePlanSchema).max(MAX_PLANS).default([]),
  selections: z
    .looseObject({
      image: selectionSchema.nullable().default(null),
      vision: selectionSchema.nullable().default(null),
    })
    .default({ image: null, vision: null }),
})

export function emptyDocument(): StoreDocument {
  return {
    schemaVersion: 1,
    providers: [],
    records: [],
    plans: [],
    selections: { image: null, vision: null },
  }
}

function parseDocument(text: string): StoreDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw unavailable('插件私有存储不是有效 JSON，需由宿主重置该插件的存储')
  }
  const parsed = documentSchema.safeParse(raw)
  if (!parsed.success) {
    throw unavailable('插件私有存储结构无效，需由宿主重置该插件的存储')
  }
  return parsed.data as unknown as StoreDocument
}

class MemoryStore implements PrivateStore {
  readonly kind = 'memory' as const
  readonly durable = false
  private document = emptyDocument()
  private queue: Promise<unknown> = Promise.resolve()

  async read(): Promise<StoreDocument> {
    return structuredClone(this.document)
  }

  async mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const draft = structuredClone(this.document)
      const result = await apply(draft)
      this.document = draft
      return result
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }
}

class FileStore implements PrivateStore {
  readonly kind = 'file' as const
  readonly durable = true
  private document: StoreDocument | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async read(): Promise<StoreDocument> {
    await this.load()
    return structuredClone(this.document ?? emptyDocument())
  }

  async mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.load()
      const draft = structuredClone(this.document ?? emptyDocument())
      const result = await apply(draft)
      await this.persist(draft)
      this.document = draft
      return result
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<void> {
    if (this.document !== null) return
    try {
      this.document = parseDocument(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (isMissingFile(error)) {
        this.document = emptyDocument()
        return
      }
      throw error
    }
  }

  private async persist(document: StoreDocument): Promise<void> {
    const temporary = `${this.file}.tmp`
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
      })
      await rename(temporary, this.file)
    } catch (error) {
      throw unavailable('插件私有存储写入失败，本次修改未保存', error)
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export function createFileStore(directory: string): PrivateStore {
  return new FileStore(join(directory, 'ai-image.json'))
}

export function createMemoryStore(): PrivateStore {
  return new MemoryStore()
}
