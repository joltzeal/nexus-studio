import { z } from 'zod'

import { invalidRequest } from './errors.js'

const pageSchema = z.number().int().min(0).max(1000)
const idSchema = z.string().trim().min(1).max(64)

export const MonitorSaveInputSchema = z.strictObject({
  /** Present when editing an existing monitor. */
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(64),
  searchUrl: z.string().trim().min(1).max(2048),
  intervalMinutes: z.number().int().min(1).max(1440),
  maxPages: z.number().int().min(1).max(20),
  perPage: z.number().int().min(1).max(96),
  enabled: z.boolean(),
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
})

export const ItemsListInputSchema = z.strictObject({
  monitorId: idSchema.optional(),
  keyword: z.string().trim().max(100).optional(),
  page: pageSchema,
  pageSize: z.number().int().min(1).max(100),
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
