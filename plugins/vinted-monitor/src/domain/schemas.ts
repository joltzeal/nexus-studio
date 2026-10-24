import { z } from 'zod'

import { invalidRequest } from './errors.js'

const pageSchema = z.number().int().min(0).max(1_000_000)
const pageSizeSchema = z.number().int().min(1).max(100)
const idSchema = z.string().trim().min(1).max(128)
const counterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const AvailabilitySchema = z.enum([
  'unknown',
  'pending',
  'available',
  'sold',
  'ignored',
])
export const EmptyInputSchema = z.strictObject({})
export const MonitorListInputSchema = z.strictObject({
  page: pageSchema.optional(),
  pageSize: pageSizeSchema.optional(),
})

export const MonitorSaveInputSchema = z.strictObject({
  /** Present when editing an existing monitor. */
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(64),
  searchUrl: z.string().trim().min(1).max(2048),
  intervalMinutes: z.number().int().min(1).max(1440),
  maxPages: z.number().int().min(1).max(20),
  perPage: z.number().int().min(1).max(96),
  enabled: z.boolean(),
  proxyId: idSchema.nullable().optional(),
})

export const MonitorIdInputSchema = z.strictObject({
  monitorId: idSchema,
})

export const RunIdInputSchema = z.strictObject({
  runId: idSchema,
})

export const RunsListInputSchema = z.strictObject({
  monitorId: idSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  page: pageSchema.optional(),
  pageSize: pageSizeSchema.optional(),
})

export const ItemsListInputSchema = z
  .strictObject({
    monitorId: idSchema.optional(),
    keyword: z.string().trim().max(100).optional(),
    externalId: z
      .string()
      .regex(/^\d{1,32}$/)
      .optional(),
    availabilityStatus: AvailabilitySchema.optional(),
    starred: z.boolean().optional(),
    order: z
      .enum(['collected_desc', 'favourite_asc', 'favourite_desc'])
      .default('collected_desc'),
    favouriteCountOp: z
      .enum(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'isNull', 'notNull'])
      .default('eq'),
    favouriteCount: counterSchema.optional(),
    favouriteCountStart: counterSchema.optional(),
    favouriteCountEnd: counterSchema.optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .refine(
    (input) =>
      input.favouriteCountOp !== 'between' ||
      input.favouriteCountStart === undefined ||
      input.favouriteCountEnd === undefined ||
      input.favouriteCountStart <= input.favouriteCountEnd,
    { path: ['favouriteCountEnd'], message: 'Invalid range' },
  )

export const ItemIdInputSchema = z.strictObject({ itemId: idSchema })
export const ItemStarInputSchema = ItemIdInputSchema.extend({ starred: z.boolean() })
export const ItemAvailabilityInputSchema = ItemIdInputSchema.extend({
  status: z.enum(['pending', 'available', 'sold', 'ignored']),
  note: z.string().trim().max(500).default(''),
})
export const ProxySaveInputSchema = z.strictObject({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(64),
  scheme: z.enum(['http', 'https', 'socks5', 'socks5h']),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(128),
  password: z.string().max(512).optional(),
  enabled: z.boolean(),
})
export const ProxyIdInputSchema = z.strictObject({ proxyId: idSchema })
export const ProxyDefaultInputSchema = z.strictObject({ proxyId: idSchema.nullable() })
export const ImageOpenInputSchema = ItemIdInputSchema.extend({
  url: z.string().min(1).max(4096),
})
export const ImageCloseInputSchema = z.strictObject({ id: z.string().uuid() })
export const ImageReadInputSchema = ImageCloseInputSchema.extend({
  offset: counterSchema,
})

export const UrlInspectInputSchema = z.strictObject({
  url: z.string().trim().min(1).max(2048),
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

export type MonitorSaveInput = z.infer<typeof MonitorSaveInputSchema>
export type MonitorIdInput = z.infer<typeof MonitorIdInputSchema>
export type RunIdInput = z.infer<typeof RunIdInputSchema>
export type RunsListInput = z.infer<typeof RunsListInputSchema>
export type ItemsListInput = z.infer<typeof ItemsListInputSchema>
export type UrlInspectInput = z.infer<typeof UrlInspectInputSchema>
