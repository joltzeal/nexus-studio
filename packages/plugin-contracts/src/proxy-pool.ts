import { z } from 'zod'

const id = z.uuid()
const name = z.string().trim().min(1).max(128)
const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const date = z.iso.datetime()
export const ProxyProductSchema = z.enum(['residential', 'datacenter', 'isp', 'mobile', 'other'])
export type ProxyProduct = z.infer<typeof ProxyProductSchema>

export const ProxySiteDefinitionSchema = z.strictObject({
  id: providerId, name,
  apiProducts: z.array(ProxyProductSchema), manualProducts: z.array(ProxyProductSchema),
  description: z.string().max(1024),
})
export type ProxySiteDefinition = z.infer<typeof ProxySiteDefinitionSchema>

export const ProviderAccountInputSchema = z.strictObject({
  id: id.optional(), providerId, name, enabled: z.boolean().default(true),
  apiKey: z.string().trim().max(1024).nullable().optional(),
  username: z.string().max(128).default(''),
  proxyPassword: z.string().max(512).nullable().optional(),
  endpointCount: z.number().int().min(1).max(1000).default(10),
})
export type ProviderAccountInput = z.input<typeof ProviderAccountInputSchema>

export const ProviderAccountSchema = z.strictObject({
  id, providerId, name, enabled: z.boolean(), username: z.string().max(128),
  endpointCount: z.number().int().min(1).max(1000), hasApiKey: z.boolean(), hasProxyPassword: z.boolean(),
  createdAt: date, updatedAt: date, lastSyncAt: date.nullable(), lastError: z.string().max(1024).nullable(),
})
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>

export const ProviderSubscriptionSchema = z.strictObject({
  id, accountId: id, providerId, name, productType: ProxyProductSchema,
  source: z.enum(['api', 'manual']), expiresAt: date.nullable(),
  enabled: z.boolean(), expired: z.boolean(), memberCount: z.number().int().nonnegative(),
  createdAt: date, updatedAt: date,
})
export type ProviderSubscription = z.infer<typeof ProviderSubscriptionSchema>

export const ManualProviderSubscriptionInputSchema = z.strictObject({
  id: id.optional(), accountId: id, name, productType: ProxyProductSchema,
  expiresAt: date, enabled: z.boolean().default(true),
  scheme: z.enum(['http', 'https', 'socks5', 'socks5h']).default('http'),
  text: z.string().max(500_000).optional(),
})
export type ManualProviderSubscriptionInput = z.input<typeof ManualProviderSubscriptionInputSchema>
export const ProviderIdInputSchema = z.strictObject({ id })
export const ProviderSubscriptionListInputSchema = z.strictObject({ accountId: id.optional() })
export const ProxyEndpointOriginSchema = z.strictObject({ accountId: id, subscriptionId: id })
export type ProxyEndpointOrigin = z.infer<typeof ProxyEndpointOriginSchema>

export const PROXY_IP_HISTORY_LIMIT = 20
export const ProxyIpObservationSchema = z.strictObject({
  ip: z.union([z.ipv4(), z.ipv6()]),
  countryCode: z.string().nullable(),
  city: z.string().nullable(),
  firstSeen: z.iso.datetime({ offset: true }),
  lastSeen: z.iso.datetime({ offset: true }),
}).refine((value) => Date.parse(value.firstSeen) <= Date.parse(value.lastSeen))
export type ProxyIpObservation = z.infer<typeof ProxyIpObservationSchema>
export const ProxyIpHistorySchema = z.array(ProxyIpObservationSchema).max(PROXY_IP_HISTORY_LIMIT)

export function previousProxyIpObservations(row: {
  exitIp: string | null
  exitIpCheckedAt?: string | null
  previousExitIp: string | null
  previousExitIpCheckedAt: string | null
  checkStatus: string
  checkedAt: string | null
  geo: { countryCode: string | null; city: string | null } | null
}): ProxyIpObservation[] {
  const current = ProxyIpObservationSchema.safeParse({
    ip: row.exitIp,
    countryCode: row.geo?.countryCode ?? null,
    city: row.geo?.city ?? null,
    firstSeen: row.exitIp === row.previousExitIp && row.previousExitIpCheckedAt
      ? row.previousExitIpCheckedAt
      : row.exitIpCheckedAt ?? (row.checkStatus === 'ok' ? row.checkedAt : null),
    lastSeen: row.exitIpCheckedAt ?? (row.checkStatus === 'ok' ? row.checkedAt : null),
  })
  const previous = ProxyIpObservationSchema.safeParse({
    ip: row.previousExitIp,
    countryCode: null,
    city: null,
    firstSeen: row.previousExitIpCheckedAt,
    lastSeen: row.previousExitIpCheckedAt,
  })
  const observations = current.success ? [current.data] : []
  if (previous.success && (!current.success || previous.data.ip !== current.data.ip || previous.data.lastSeen !== current.data.lastSeen))
    observations.push(previous.data)
  return observations
}

export const ProxyPickerInputSchema = z.strictObject({
  accountId: id.nullable().default(null), subscriptionId: id.nullable().default(null),
  keyword: z.string().max(128).default(''),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100),
}).refine((value) => value.subscriptionId === null || value.accountId !== null)
export type ProxyPickerInput = z.input<typeof ProxyPickerInputSchema>
export const ProxyPickerGroupSchema = z.strictObject({
  id, kind: z.enum(['account', 'subscription']), name, providerId,
  productType: ProxyProductSchema.nullable(), expiresAt: date.nullable(),
  enabled: z.boolean(), count: z.number().int().nonnegative(),
})
export type ProxyPickerGroup = z.infer<typeof ProxyPickerGroupSchema>
export const ProxyPickerEnvelopeSchema = z.strictObject({
  groups: z.array(ProxyPickerGroupSchema).max(512), items: z.array(z.unknown()).max(500),
  total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive().max(500),
})
export const ProviderSyncResultSchema = z.strictObject({
  subscriptions: z.number().int().nonnegative(), endpoints: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(1024)).max(32),
})
export const ManualProviderSubscriptionResultSchema = z.strictObject({
  subscription: ProviderSubscriptionSchema, created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(), withdrawn: z.number().int().nonnegative(),
})

export const PROXY_SITE_METHODS = [
  'proxy.providers.list', 'proxy.providerAccounts.list', 'proxy.providerAccounts.save',
  'proxy.providerAccounts.delete', 'proxy.providerAccounts.sync',
  'proxy.providerSubscriptions.list', 'proxy.providerSubscriptions.manual', 'proxy.providerSubscriptions.delete',
  'proxy.picker.list',
] as const
