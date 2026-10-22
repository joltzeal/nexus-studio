import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { z } from 'zod'

import { invalidRequest } from './errors.js'

export const MAX_BATCH = 1000
export const MAX_IMPORT_CHARS = 500_000
export const MAX_BASE_YAML_CHARS = 32_768

export const SchemeSchema = z.enum(['http', 'https', 'socks5', 'socks5h'])
export type Scheme = z.infer<typeof SchemeSchema>

export type CheckStatus = 'unknown' | 'ok' | 'failed'
export type SubscriptionSource = 'selected' | 'groups'

/**
 * Hosts are stored without scheme, port, path or brackets. Domain names are
 * converted to their ASCII form so two spellings of one host cannot create
 * two inventory rows.
 */
export function normalizeHost(value: string): string {
  const trimmed = value.trim()
  if (trimmed.includes('%')) {
    throw new Error('代理主机不支持带区域标识的 IPv6 地址')
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1)
    if (isIP(inner) !== 6) throw new Error('IPv6 地址无效')
    return compressIpv6(inner)
  }
  if (isIP(trimmed) !== 0) return compressIpv6(trimmed)
  const ascii = domainToASCII(trimmed.replace(/\.+$/, '')).toLowerCase()
  if (!ascii || ascii.length > 253) throw new Error('代理主机地址无效')
  const labels = ascii.split('.')
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('主机只填写域名或 IP，不包含协议、端口或路径')
  }
  return ascii
}

function compressIpv6(value: string): string {
  if (isIP(value) === 4) return value
  const normalized = new URL(`http://[${value}]`).hostname
  return normalized.replace(/^\[|\]$/g, '')
}

const hostField = z
  .string()
  .min(1)
  .max(253)
  .transform((value, ctx) => {
    try {
      return normalizeHost(value)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : '代理主机地址无效',
      })
      return z.NEVER
    }
  })

const groupField = z.number().int().min(1).nullable().default(null)

export const ProxyGroupInputSchema = z.strictObject({
  name: z.string().trim().min(1, '分组名称不能为空').max(128),
})
export type ProxyGroupInput = z.infer<typeof ProxyGroupInputSchema>

export const ProxyInputSchema = z.strictObject({
  name: z.string().trim().min(1, '名称不能为空').max(128),
  schemes: z
    .array(SchemeSchema)
    .min(1)
    .max(4)
    .transform((value) => [...new Set(value)].sort()),
  host: hostField,
  port: z.number().int().min(1).max(65535),
  username: z.string().max(128).default(''),
  /** Write-only. Never persisted by the plugin; the host vault owns the value. */
  password: z.string().max(512).nullish(),
  enabled: z.boolean().default(true),
  udp: z.boolean().default(true),
  groupId: groupField,
})
export type ProxyInput = z.infer<typeof ProxyInputSchema>

export const ImportInputSchema = z.strictObject({
  proxyUrls: z.string().max(MAX_IMPORT_CHARS),
  groupId: groupField,
})
export type ImportInput = z.infer<typeof ImportInputSchema>

export const DecodoInputSchema = z
  .strictObject({
    host: hostField.default('dc.decodo.com'),
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(512),
    startPort: z.number().int().min(1).max(65535),
    endPort: z.number().int().min(1).max(65535),
    schemes: z
      .array(SchemeSchema)
      .min(1)
      .max(4)
      .transform((value) => [...new Set(value)].sort()),
    udp: z.boolean().default(true),
    groupId: groupField,
  })
  .superRefine((value, ctx) => {
    const count = value.endPort - value.startPort + 1
    if (value.endPort < value.startPort || count > MAX_BATCH) {
      ctx.addIssue({
        code: 'custom',
        message: '端口范围无效；单次最多生成 1000 条代理',
        path: ['endPort'],
      })
    }
  })
export type DecodoInput = z.infer<typeof DecodoInputSchema>

export const SelectionInputSchema = z.strictObject({
  ids: z.array(z.number().int().min(1)).min(1).max(MAX_BATCH),
})
export type SelectionInput = z.infer<typeof SelectionInputSchema>

export const IdInputSchema = z.strictObject({
  id: z.number().int().min(1),
})
export type IdInput = z.infer<typeof IdInputSchema>

export const ProxyUrlInputSchema = z.strictObject({
  ids: z.array(z.number().int().min(1)).min(1).max(MAX_BATCH),
  preferredScheme: SchemeSchema.nullable().default(null),
})
export type ProxyUrlInput = z.infer<typeof ProxyUrlInputSchema>

export const CheckInputSchema = z.strictObject({
  id: z.number().int().min(1),
  scheme: SchemeSchema.nullable().default(null),
  singleSchemeFallback: z.boolean().default(false),
})
export type CheckInput = z.infer<typeof CheckInputSchema>

/**
 * Ad-hoc check for a proxy the user typed but has not saved. It runs the same
 * exit-IP and reputation path as `proxy.check`, minus the persistence.
 */
export const ProbeInputSchema = z.strictObject({
  url: z.string().trim().min(1).max(4096),
})
export type ProbeInput = z.infer<typeof ProbeInputSchema>

export const ResolveInputSchema = z.strictObject({
  endpointId: z.number().int().min(1).nullable().default(null),
})
export type ResolveInput = z.infer<typeof ResolveInputSchema>

export const SubscriptionInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  enabled: z.boolean().default(true),
  sourceMode: z.enum(['selected', 'groups']).default('selected'),
  proxyIds: z.array(z.number().int().min(1)).max(MAX_BATCH).default([]),
  groupIds: z.array(z.number().int().min(1)).max(MAX_BATCH).default([]),
  groupName: z.string().trim().min(1).max(128).default('PROXY'),
  includeDirect: z.boolean().default(true),
  preferredScheme: SchemeSchema.nullable().default(null),
  baseYaml: z
    .string()
    .max(MAX_BASE_YAML_CHARS)
    .default('mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\n'),
})
export type SubscriptionInput = z.infer<typeof SubscriptionInputSchema>

export const SubscriptionTokenInputSchema = z.strictObject({
  id: z.number().int().min(1),
  token: z.string().min(1).max(128),
})
export type SubscriptionTokenInput = z.infer<typeof SubscriptionTokenInputSchema>

export const AppendInputSchema = z.strictObject({
  id: z.number().int().min(1),
  ids: z.array(z.number().int().min(1)).min(1).max(MAX_BATCH),
})
export type AppendInput = z.infer<typeof AppendInputSchema>

export const ConfigureInputSchema = z.strictObject({
  defaultEndpointId: z.number().int().min(1).nullable().default(null),
  riskEnabled: z.boolean().default(true),
  riskApiKey: z.string().max(512).nullish(),
  riskCacheSeconds: z.number().int().min(0).max(86_400).default(3600),
})
export type ConfigureInput = z.infer<typeof ConfigureInputSchema>

export const ListInputSchema = z.strictObject({
  keyword: z.string().max(128).default(''),
  scheme: SchemeSchema.nullable().default(null),
  enabled: z.boolean().nullable().default(null),
  groupId: z.number().int().min(1).nullable().default(null),
  ungrouped: z.boolean().default(false),
  isProxy: z.boolean().nullable().default(null),
  isVpn: z.boolean().nullable().default(null),
  isHosting: z.boolean().nullable().default(null),
  riskMin: z.number().int().min(0).max(100).nullable().default(null),
  riskMax: z.number().int().min(0).max(100).nullable().default(null),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
})
export type ListInput = z.infer<typeof ListInputSchema>

export interface GeoLocation {
  status: 'ok' | 'not_found' | 'unavailable' | 'non_public'
  source: 'proxycheck.io'
  country: string | null
  countryCode: string | null
  region: string | null
  city: string | null
  isp: string | null
  error: string | null
}

export interface IpReputation {
  status: 'ok' | 'unavailable' | 'rate_limited' | 'disabled' | 'non_public'
  source: 'proxycheck.io'
  ip: string
  checkedAt: string
  cached: boolean
  risk: number | null
  confidence: number | null
  proxy: boolean | null
  vpn: boolean | null
  tor: boolean | null
  hosting: boolean | null
  compromised: boolean | null
  scraper: boolean | null
  networkType: string | null
  provider: string | null
  asn: string | null
  geo: GeoLocation | null
  error: string | null
}

export interface EndpointRecord {
  id: number
  name: string
  schemes: Scheme[]
  host: string
  port: number
  username: string
  /** Vault reference only; the plugin never stores a password or its ciphertext. */
  secretRef: string | null
  /** Vault-computed digest so editing the password does not duplicate a row. */
  credentialFingerprint: string
  fingerprint: string
  groupId: number | null
  enabled: boolean
  udp: boolean
  checkStatus: CheckStatus
  checkedScheme: Scheme | null
  checkedAt: string | null
  exitIp: string | null
  exitIpCheckedAt: string | null
  previousExitIp: string | null
  previousExitIpCheckedAt: string | null
  geo: GeoLocation | null
  reputation: IpReputation | null
  riskScore: number | null
  isProxy: boolean | null
  isVpn: boolean | null
  isHosting: boolean | null
  latencyMs: number | null
  checkError: string | null
  deleted: boolean
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface GroupRecord {
  id: number
  name: string
  createdAt: string
}

export interface SubscriptionRecord {
  id: number
  name: string
  enabled: boolean
  sourceMode: SubscriptionSource
  proxyIds: number[]
  groupIds: number[]
  groupName: string
  includeDirect: boolean
  preferredScheme: Scheme | null
  baseConfig: Record<string, unknown>
  tokenHash: string
  tokenRef: string
  createdAt: string
  updatedAt: string
  deleted: boolean
  deletedAt: string | null
}

export interface ProxyPublic {
  id: string
  name: string
  groupId: string | null
  schemes: Scheme[]
  host: string
  port: number
  username: string
  enabled: boolean
  udp: boolean
  hasPassword: boolean
  checkStatus: CheckStatus
  checkedScheme: Scheme | null
  checkedAt: string | null
  exitIp: string | null
  exitIpCheckedAt: string | null
  previousExitIp: string | null
  previousExitIpCheckedAt: string | null
  exitIpChanged: boolean
  geo: GeoLocation | null
  reputation: IpReputation | null
  latencyMs: number | null
  checkError: string | null
}

export interface CheckResult {
  id: string
  ok: boolean
  scheme: Scheme
  exitIp: string | null
  geo: GeoLocation | null
  reputation: IpReputation | null
  latencyMs: number
  error: string | null
  checkedAt: string
  saved: boolean
}

export interface BatchResult {
  requested: number
  created: number
  duplicates: number
  merged: number
}

/** Converts a schema failure into a redacted, developer-facing request error. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issues = result.error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('；')
  // Field values are never echoed: payloads can carry passwords and tokens.
  throw invalidRequest(`${label}无效${issues ? `（${issues}）` : ''}`)
}
