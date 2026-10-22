import { z } from 'zod'

import { invalidRequest } from './errors.js'
import { CATEGORY_IDS } from '../services/upstream.js'

const pageSchema = z.number().int().min(0).max(1000)

/** Base64 payload cap: 5 MiB of image data plus encoding overhead. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4

const categoryIdSchema = z
  .string()
  .trim()
  .refine((value) => CATEGORY_IDS.includes(value), { message: '不支持的分类' })

export const StoresInputSchema = z.strictObject({
  typeId: categoryIdSchema,
  page: pageSchema,
})

export const ProductsInputSchema = z.strictObject({
  merchantId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9]+$/, { message: '商户标识格式无效' }),
  page: pageSchema,
})

export const SearchInputSchema = z.strictObject({
  keyword: z.string().trim().min(1).max(100),
  page: pageSchema,
})

export const ImageSearchInputSchema = z.strictObject({
  /** Base64 JPEG produced by the page; the upstream only accepts JPEG here. */
  data: z.string().min(16).max(MAX_IMAGE_BASE64),
  mime: z.literal('image/jpeg'),
})

export const FavoriteAddInputSchema = z.strictObject({
  product: z.record(z.string(), z.unknown()),
})

export const FavoriteRemoveInputSchema = z.strictObject({
  favoriteId: z.string().trim().min(1).max(64),
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

export type StoresInput = z.infer<typeof StoresInputSchema>
export type ProductsInput = z.infer<typeof ProductsInputSchema>
export type SearchInput = z.infer<typeof SearchInputSchema>
export type ImageSearchInput = z.infer<typeof ImageSearchInputSchema>
export type FavoriteAddInput = z.infer<typeof FavoriteAddInputSchema>
export type FavoriteRemoveInput = z.infer<typeof FavoriteRemoveInputSchema>
