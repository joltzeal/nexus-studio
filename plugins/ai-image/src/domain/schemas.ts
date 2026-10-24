import { z } from 'zod'

import { invalidRequest } from './errors.js'
import { ScenePlanSelectionSchema } from './scene-plan.js'
import { MAX_INPUT_BYTES, UPLOAD_CHUNK_BYTES } from './types.js'

const pageSchema = z.number().int().min(0).max(1000)
const sizeSchema = z.number().int().min(1).max(100)

const MAX_CHUNK_BASE64 = Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 + 8

/**
 * Only absolute http(s) URLs without embedded credentials are accepted. The
 * trailing slash and a missing `/v1` are normalised by the caller so every
 * request path stays predictable.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

export const baseUrlSchema = z.string().trim().min(8).max(300).refine(isHttpUrl, {
  message: '接口地址必须是完整的 http(s) 地址，且不能包含账号密码',
})

export const ProviderSaveInputSchema = z.strictObject({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['openai', 'openai_compatible']),
  baseUrl: baseUrlSchema,
  /** Omitted keeps the stored key, so editing other fields does not need it. */
  apiKey: z.string().trim().max(400).optional(),
  imageModel: z.string().trim().max(120),
  textModel: z.string().trim().max(120),
  /** Omitted preserves the saved choice; an empty string explicitly clears it. */
  visionModel: z.string().trim().max(120).optional(),
  supportsVision: z.boolean(),
})

export const ProviderIdInputSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
})

export const UploadBeginInputSchema = z.strictObject({
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  size: z.number().int().min(1).max(MAX_INPUT_BYTES),
})

export const UploadChunkInputSchema = z.strictObject({
  uploadId: z.string().trim().min(1).max(64),
  index: z.number().int().min(0).max(10_000),
  data: z.string().min(1).max(MAX_CHUNK_BASE64),
})

export const UploadFinishInputSchema = z.strictObject({
  uploadId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
})

export const UploadAbortInputSchema = z.strictObject({
  uploadId: z.string().trim().min(1).max(64),
})

/**
 * A picture that lives on someone else's CDN, such as a supplier's product
 * photo. The page cannot fetch it itself: the webview enforces CORS and those
 * hosts do not send the headers.
 */
export const RemoteUploadInputSchema = z.strictObject({
  url: z
    .string()
    .trim()
    .min(8)
    .max(2048)
    .refine(isHttpUrl, { message: '图片地址必须是完整的 http(s) 地址' }),
  name: z.string().trim().max(120).optional(),
})

export const FileChunkInputSchema = z.strictObject({
  fileId: z.string().trim().min(1).max(64),
  offset: z.number().int().min(0),
  length: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024),
})

const sourceIdSchema = z.string().trim().min(1).max(128)

export const GenerationSourceSchema = z.strictObject({
  pluginId: sourceIdSchema,
  itemId: sourceIdSchema,
  title: z.string().trim().min(1).max(500),
  url: z.string().trim().min(8).max(2048).refine(isHttpUrl),
})

export const RecordsListInputSchema = z
  .strictObject({
    page: pageSchema,
    size: sizeSchema,
    status: z.enum(['running', 'success', 'failed']).optional(),
    sourcePluginId: sourceIdSchema.optional(),
    sourceItemId: sourceIdSchema.optional(),
  })
  .refine(
    (input) =>
      (input.sourcePluginId === undefined) === (input.sourceItemId === undefined),
    { path: ['sourceItemId'], message: '来源插件和商品标识必须同时提供' },
  )

export const RecordIdInputSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
})

export const RecordRecognizeInputSchema = z.union([
  z.strictObject({
    id: z.string().trim().min(1).max(64),
    providerId: z.string().trim().min(1).max(64),
    fileId: z.string().trim().min(1).max(64).nullable().optional(),
  }),
  z.strictObject({
    id: z.string().trim().min(1).max(64),
    retry: z.literal(true),
  }),
])

export const GenerateInputSchema = z
  .strictObject({
    providerId: z.string().trim().min(1).max(64),
    mode: z.enum(['generate', 'edit']),
    /** `null` means "send the prompt as typed", without a preset preamble. */
    presetId: z.string().trim().max(64).nullable(),
    // Reject over-limit input instead of silently trimming pasted constraints.
    prompt: z.string().max(12000),
    size: z.enum(['1024x1024', '1024x1536', '1536x1024', 'auto']),
    count: z.number().int().min(1).max(4),
    inputFileIds: z.array(z.string().trim().min(1).max(64)).max(6),
    source: GenerationSourceSchema.optional(),
    scenePlan: ScenePlanSelectionSchema.optional(),
    /** Omitted/null keeps the legacy generation/copy flow. */
    visionProviderId: z.string().trim().min(1).max(64).nullable().optional(),
    /** Omitted/null selects the first input, only when recognition is enabled. */
    visionFileId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .superRefine((input, context) => {
    if (input.scenePlan === undefined) return
    if (input.mode !== 'edit') {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: '场景规划只能用于改图',
      })
    }
    if (input.count !== input.scenePlan.views.length) {
      context.addIssue({
        code: 'custom',
        path: ['count'],
        message: '张数必须与视角数一致',
      })
    }
    if (input.visionProviderId !== undefined || input.visionFileId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['scenePlan'],
        message: '场景规划不能重复启用生成前识图',
      })
    }
  })

export function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') ?? ''
    throw invalidRequest(path === '' ? '请求参数无效' : `请求参数无效：${path}`)
  }
  return parsed.data
}

/**
 * `https://api.openai.com` → `https://api.openai.com/v1`, and any trailing
 * slash is dropped. A path that already has a version segment is left alone so
 * gateways such as `https://host/openai/v1` keep working.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  const url = new URL(trimmed)
  if (url.pathname === '' || url.pathname === '/') return `${url.origin}/v1`
  return trimmed
}

export type ProviderSaveInput = z.infer<typeof ProviderSaveInputSchema>
export type UploadBeginInput = z.infer<typeof UploadBeginInputSchema>
export type UploadChunkInput = z.infer<typeof UploadChunkInputSchema>
export type UploadFinishInput = z.infer<typeof UploadFinishInputSchema>
export type UploadAbortInput = z.infer<typeof UploadAbortInputSchema>
export type RemoteUploadInput = z.infer<typeof RemoteUploadInputSchema>
export type FileChunkInput = z.infer<typeof FileChunkInputSchema>
export type RecordsListInput = z.infer<typeof RecordsListInputSchema>
export type GenerateInput = z.infer<typeof GenerateInputSchema>
