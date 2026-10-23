import { z } from 'zod'

import { invalidRequest } from './errors.js'
import { MAX_BATCH, ProxyInputSchema, SchemeSchema } from './schemas.js'

const id = z.number().int().positive()
const windowId = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => value.trim().length > 0)
const timestamp = z.string().min(1).max(64)
const nullableText = z.string().max(4096).nullable()
const score = z.number().min(0).max(100).nullable()
const receipt = z.uuid()

const geo = z.strictObject({
  status: z.enum(['ok', 'not_found', 'unavailable', 'non_public']),
  source: z.literal('proxycheck.io'),
  country: nullableText,
  countryCode: nullableText,
  region: nullableText,
  city: nullableText,
  isp: nullableText,
  error: nullableText,
})

const reputation = z.strictObject({
  status: z.enum(['ok', 'unavailable', 'rate_limited', 'disabled', 'non_public']),
  source: z.literal('proxycheck.io'),
  ip: z.string().max(253),
  checkedAt: timestamp,
  cached: z.boolean(),
  risk: score,
  confidence: score,
  proxy: z.boolean().nullable(),
  vpn: z.boolean().nullable(),
  tor: z.boolean().nullable(),
  hosting: z.boolean().nullable(),
  compromised: z.boolean().nullable(),
  scraper: z.boolean().nullable(),
  networkType: nullableText,
  provider: nullableText,
  asn: nullableText,
  geo: geo.nullable(),
  error: nullableText,
})

export const ProxyTransferEndpointSchema = ProxyInputSchema.extend({
  id,
  username: z.string().max(128),
  password: z.string().max(512).nullable(),
  groupId: id.nullable(),
  enabled: z.boolean(),
  udp: z.boolean(),
  checkStatus: z.enum(['unknown', 'ok', 'failed']),
  checkedScheme: SchemeSchema.nullable(),
  checkedAt: timestamp.nullable(),
  exitIp: nullableText,
  exitIpCheckedAt: timestamp.nullable(),
  previousExitIp: nullableText,
  previousExitIpCheckedAt: timestamp.nullable(),
  geo: geo.nullable(),
  reputation: reputation.nullable(),
  riskScore: score,
  isProxy: z.boolean().nullable(),
  isVpn: z.boolean().nullable(),
  isHosting: z.boolean().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  checkError: nullableText,
  createdAt: timestamp,
  updatedAt: timestamp,
})

const group = z.strictObject({
  id,
  name: z.string().min(1).max(128),
  createdAt: timestamp,
})

export const TransferExportInputSchema = z.strictObject({
  windowIds: z.array(windowId).max(2000),
  endpointIds: z.array(id).max(MAX_BATCH),
  includeDefault: z.boolean().optional().default(true),
})

export const ProxyTransferDataSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    defaultEndpointId: id.nullable(),
    endpoints: z.array(ProxyTransferEndpointSchema).max(MAX_BATCH + 1),
    groups: z.array(group).max(MAX_BATCH + 1),
  })
  .refine((data) => {
    const endpoints = new Set(data.endpoints.map((entry) => entry.id))
    const groups = new Set(data.groups.map((entry) => entry.id))
    const usedGroups = new Set(
      data.endpoints.flatMap((entry) => (entry.groupId === null ? [] : [entry.groupId])),
    )
    return (
      endpoints.size === data.endpoints.length &&
      groups.size === data.groups.length &&
      groups.size === usedGroups.size &&
      [...usedGroups].every((groupId) => groups.has(groupId))
    )
  })

export const TransferImportInputSchema = z.strictObject({
  data: z.unknown(),
  windowIdMap: z
    .record(windowId, windowId)
    .refine((value) => Object.keys(value).length <= 2000),
  transactionId: receipt.optional(),
})

export const TransferReceiptInputSchema = z.strictObject({ receipt })

export const ProxyTransferReceiptSchema = z.strictObject({
  receipt,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['pending', 'applied']),
  endpointIdMap: z.record(z.string().regex(/^[1-9][0-9]*$/), id),
  groupIds: z.array(id).max(MAX_BATCH + 1),
  secretRefs: z
    .array(z.string().regex(/^(?:file|mem):proxy-password:[0-9a-f-]{36}$/))
    .max(MAX_BATCH + 1),
})

export type ProxyTransferData = z.infer<typeof ProxyTransferDataSchema>
export type ProxyTransferReceipt = z.infer<typeof ProxyTransferReceiptSchema>
export type ProxyTransferExportInput = z.input<typeof TransferExportInputSchema>
export type ProxyTransferImportInput = z.input<typeof TransferImportInputSchema>
export type ProxyTransferReceiptInput = z.input<typeof TransferReceiptInputSchema>
export interface ProxyTransferImportResult {
  receipt: string
  endpointIdMap: Record<string, number>
}

/** Do not echo keys or values from a credential-bearing portable document. */
export function parseTransfer<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw invalidRequest('代理迁移数据或参数无效')
  return result.data
}
