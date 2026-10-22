import { z } from 'zod'

import { invalidRequest } from './errors.js'
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
  imageModel: z.string().trim().min(1).max(120),
  textModel: z.string().trim().max(120),
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

export const RecordsListInputSchema = z.strictObject({
  page: pageSchema,
  size: sizeSchema,
  status: z.enum(['running', 'success', 'failed']).optional(),
})

export const RecordIdInputSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
})

export const GenerateInputSchema = z.strictObject({
  providerId: z.string().trim().min(1).max(64),
  mode: z.enum(['generate', 'edit']),
  /** `null` means "send the prompt as typed", without a preset preamble. */
  presetId: z.string().trim().max(64).nullable(),
  prompt: z.string().trim().max(4000),
  size: z.enum(['1024x1024', '1024x1536', '1536x1024', 'auto']),
  count: z.number().int().min(1).max(4),
  inputFileIds: z.array(z.string().trim().min(1).max(64)).max(6),
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
