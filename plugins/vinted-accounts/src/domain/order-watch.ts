import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { parseHomepage } from '../services/order-source.js'
import type { AccountRecord } from './types.js'

const timestamp = z.iso.datetime().nullable()
const shortText = z.string().max(500)
const link = z.string().max(2048)

const barkUrl = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform((value, context) => {
    try {
      const url = new URL(value)
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if (
        (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        url.port === '0'
      ) {
        throw new Error('invalid')
      }
      return url.origin
    } catch {
      context.addIssue({
        code: 'custom',
        message: '请填写 Bark HTTPS 服务根地址，本机服务可使用 HTTP',
      })
      return z.NEVER
    }
  })

export const OrderWatchSettingsSchema = z
  .strictObject({
    intervalMinutes: z.number().int().min(5).max(1440),
    bark: z.strictObject({
      baseUrl: barkUrl,
      deviceKey: z
        .string()
        .trim()
        .max(256)
        .refine(
          (value) =>
            !/[\s/\\?#]/.test(value) &&
            [...value].every((character) => character.charCodeAt(0) >= 32),
          '设备 Key 格式无效',
        ),
      enabled: z.boolean(),
    }),
  })
  .refine((value) => !value.bark.enabled || value.bark.deviceKey.length > 0, {
    path: ['bark', 'deviceKey'],
    message: '启用 Bark 前请填写设备 Key',
  })

export type OrderWatchSettings = z.infer<typeof OrderWatchSettingsSchema>

export function defaultOrderSettings(): OrderWatchSettings {
  return {
    intervalMinutes: 30,
    bark: { baseUrl: 'https://api.day.app', deviceKey: '', enabled: false },
  }
}

export const OrderCandidateSchema = z.strictObject({
  id: z.string().uuid(),
  itemId: z.string().regex(/^\d{1,32}$/),
  itemUrl: link,
  title: shortText,
  imageUrl: link.nullable(),
  lastSeenAt: timestamp,
  missingAt: z.iso.datetime(),
  checkedAt: timestamp,
  status: z.enum(['pending', 'sold', 'reappeared']),
  checkError: shortText.nullable(),
  notifiedAt: timestamp,
  notifyError: shortText.nullable(),
})
export type OrderCandidate = z.infer<typeof OrderCandidateSchema>

export const OrderWatchRecordSchema = z.strictObject({
  accountId: z.string().min(1).max(64),
  revision: z.string().uuid(),
  homepageUrl: link,
  enabled: z.boolean(),
  snapshot: z
    .array(
      z.strictObject({
        id: z.string().regex(/^\d{1,32}$/),
        url: link,
        title: shortText,
        imageUrl: link.nullable(),
      }),
    )
    .max(1920)
    .nullable(),
  lastCompleteAt: timestamp,
  lastError: shortText.nullable(),
  nextRunAt: timestamp,
  consecutiveFailures: z.number().int().min(0).max(32),
  candidates: z.array(OrderCandidateSchema).max(4000),
})
export type OrderWatchRecord = z.infer<typeof OrderWatchRecordSchema>

export const OrderWatchStateSchema = z.strictObject({
  settings: OrderWatchSettingsSchema,
  records: z.array(OrderWatchRecordSchema).max(2000),
})
export type OrderWatchState = z.infer<typeof OrderWatchStateSchema>

export function emptyOrderWatchState(): OrderWatchState {
  return { settings: defaultOrderSettings(), records: [] }
}

/** Account and watch changes commit together, including spreadsheet and archive imports. */
export function reconcileOrderRecords(
  accounts: readonly AccountRecord[],
  previous: readonly OrderWatchRecord[],
): OrderWatchRecord[] {
  const existing = new Map(previous.map((entry) => [entry.accountId, entry]))
  return accounts.flatMap((account) => {
    if (!account.homepageUrl.trim()) return []
    let url: string
    try {
      url = parseHomepage(account.homepageUrl).url
    } catch {
      return []
    }
    const record = existing.get(account.id)
    if (record?.homepageUrl === url) return [record]
    return [
      {
        accountId: account.id,
        revision: randomUUID(),
        homepageUrl: url,
        enabled: true,
        snapshot: null,
        lastCompleteAt: null,
        lastError: null,
        nextRunAt: null,
        consecutiveFailures: 0,
        candidates: [],
      },
    ]
  })
}
