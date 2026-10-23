import { z } from 'zod'

import { invalidRequest } from './errors.js'

/** A single line-delimited RPC message must stay under the host's 1 MiB cap. */
export const MAX_TEXT_CHARS = 512 * 1024
export const MAX_NUMBERS = 5000
export const MAX_IDS = 2000

const appId = z.number().int().positive().max(1_000_000_000)
const appType = z.number().int().min(1).max(3)
/** 0: 随机, 1: 5-30天 … 6: 大于80天. */
const expiry = z.number().int().min(0).max(6)
const count = z.number().int().min(1).max(50_000)
const ordernum = z.string().trim().min(1).max(64)
const tel = z.string().trim().min(1).max(40)

export const ConfigSetInputSchema = z.strictObject({
  /** `null` clears the token; `undefined` leaves it untouched. */
  token: z.string().max(2048).nullable().optional(),
  baseUrl: z.string().trim().max(2048).optional(),
})

export const CatalogAppsInputSchema = z.strictObject({
  cateId: z.number().int().positive().max(1_000_000_000).optional(),
  type: appType.optional(),
  name: z.string().trim().max(120).optional(),
})

export const PrefixesInputSchema = z.strictObject({
  appId,
  type: appType.optional(),
  expiry: expiry.optional(),
})

export const BuyCreateInputSchema = z.strictObject({
  appId,
  num: count,
  type: appType.optional(),
  expiry: expiry.optional(),
  /** Comma-separated prefixes, exactly as the API expects them. */
  prefix: z.string().trim().max(200).optional(),
  excludePrefix: z.string().trim().max(200).optional(),
})

export const BuyDeferredInputSchema = z.strictObject({
  appId,
  num: count,
  type: appType.optional(),
  expiry: expiry.optional(),
  prefix: z.string().trim().max(200).optional(),
  excludePrefix: z.string().trim().max(200).optional(),
  /** Idempotency key: the same value never creates a second order. */
  requestId: z.string().trim().min(1).max(64).optional(),
})

export const OrdersListInputSchema = z.strictObject({
  page: z.number().int().min(1).max(10_000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  ordernum: z.string().trim().max(64).optional(),
  cateId: z.number().int().positive().max(1_000_000_000).optional(),
  appId: appId.optional(),
  type: appType.optional(),
  createTimeStart: z.string().trim().max(32).optional(),
  createTimeEnd: z.string().trim().max(32).optional(),
})

export const OrderNumInputSchema = z.strictObject({ ordernum })

export const ChangeTokenInputSchema = z.strictObject({
  /** The record id from `order/api`, not the order id. */
  apiId: z.number().int().positive().max(1_000_000_000),
})

export const RenewTextInputSchema = z
  .strictObject({
    /** `+tel----url` lines, one per record. */
    text: z.string().max(MAX_TEXT_CHARS).optional(),
    /** Convenience: the plugin builds the text from the stored records. */
    tels: z.array(tel).max(MAX_IDS).optional(),
  })
  .refine(
    (input) => (input.text === undefined) !== (input.tels === undefined),
    '续费要给出 API 文本或号码列表，且只能给一个',
  )

export const RenewIdsInputSchema = z.strictObject({
  ids: z.array(z.number().int().positive().max(1_000_000_000)).min(1).max(MAX_IDS),
})

export const FilterCreateInputSchema = z.strictObject({
  appId,
  /** Region code such as `US`, matching the provider's own list. */
  code: z.string().trim().min(1).max(8),
  /** One number per line; a country code prefix is required by the API. */
  numbers: z.array(z.string().trim().min(1).max(40)).min(1).max(MAX_NUMBERS),
})

export const FilterDetailInputSchema = z.strictObject({
  orderId: z.number().int().positive().max(1_000_000_000),
})

export const SmsReadInputSchema = z
  .strictObject({
    tel: tel.optional(),
    url: z.string().trim().max(2048).optional(),
  })
  .refine(
    (input) => (input.tel === undefined) !== (input.url === undefined),
    '取码要给出号码或接码链接，且只能给一个',
  )

export const RecordsListInputSchema = z.strictObject({
  query: z.string().trim().max(120).optional(),
})

export const RecordTelInputSchema = z.strictObject({ tel })

export const EmptyInputSchema = z.strictObject({})

export function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload ?? {})
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  if (issue === undefined) throw invalidRequest('请求参数无效')
  const path = issue.path.join('.')
  throw invalidRequest(path === '' ? issue.message : `${path}：${issue.message}`)
}
