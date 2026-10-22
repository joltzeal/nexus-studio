/**
 * Shapes returned by the proxy plugin. They mirror `plugins/proxy-pool`
 * (`ProxyPublic`, `GroupRecord`, `SubscriptionRecord` summaries) field by field;
 * the plugin is the only writer, the page never invents fields.
 */

export const PROXY_PLUGIN_ID = 'studio.proxy-pool'
export const PROXY_CAPABILITY = 'proxy.provider'

export const SCHEMES = ['http', 'https', 'socks5', 'socks5h'] as const
export type Scheme = (typeof SCHEMES)[number]

export type CheckStatus = 'unknown' | 'ok' | 'failed'

export interface GeoLocation {
  status: 'ok' | 'not_found' | 'unavailable' | 'non_public'
  source: string
  country: string | null
  countryCode: string | null
  region: string | null
  city: string | null
  isp: string | null
  error: string | null
}

export interface IpReputation {
  status: 'ok' | 'unavailable' | 'rate_limited' | 'disabled' | 'non_public'
  source: string
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

export interface ProxyRow {
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

export interface ProxyGroup {
  id: number
  name: string
  createdAt: string
}

export interface ProxyConfig {
  defaultEndpointId: string | null
  risk: { enabled: boolean; cacheSeconds: number; hasApiKey: boolean }
}

export interface SubscriptionSummary {
  id: string
  name: string
  enabled: boolean
  sourceMode: 'selected' | 'groups'
  groupName: string
  includeDirect: boolean
  preferredScheme: Scheme | null
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface SubscriptionDetail extends SubscriptionSummary {
  proxyIds: string[]
  groupIds: string[]
  baseYaml: string
  availableCount: number
  excludedCount: number
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

export interface ListResult {
  total: number
  offset: number
  limit: number
  items: ProxyRow[]
}

export interface ProxyListQuery {
  keyword: string
  scheme: Scheme | null
  enabled: boolean | null
  groupId: number | null
  ungrouped: boolean
  isProxy: boolean | null
  isVpn: boolean | null
  isHosting: boolean | null
  riskMin: number | null
  riskMax: number | null
  limit: number
  offset: number
}

export const EMPTY_QUERY: ProxyListQuery = {
  keyword: '',
  scheme: null,
  enabled: null,
  groupId: null,
  ungrouped: false,
  isProxy: null,
  isVpn: null,
  isHosting: null,
  riskMin: null,
  riskMax: null,
  limit: 50,
  offset: 0,
}

/** Filters that the user can clear; paging is not a filter. */
export function activeFilterCount(query: ProxyListQuery): number {
  return [
    query.keyword !== '',
    query.scheme !== null,
    query.enabled !== null,
    query.groupId !== null || query.ungrouped,
    query.isProxy !== null,
    query.isVpn !== null,
    query.isHosting !== null,
    query.riskMin !== null || query.riskMax !== null,
  ].filter(Boolean).length
}

export function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '操作失败，请重试。'
}

export function addressOf(row: Pick<ProxyRow, 'host' | 'port'>): string {
  return row.host.includes(':') ? `[${row.host}]:${row.port}` : `${row.host}:${row.port}`
}

export function schemeLabel(scheme: Scheme): string {
  return scheme.toUpperCase()
}

/** The plugin stores ISO timestamps; a bare ISO string is unreadable in a table. */
export function formatDateTime(value: string | null): string {
  if (value === null || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function flagOf(countryCode: string | null): string {
  if (countryCode === null || !/^[A-Z]{2}$/.test(countryCode)) return ''
  return [...countryCode]
    .map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0)))
    .join('')
}

/** 100 − risk, so a higher score means a cleaner exit. Null when unknown. */
export function qualityScore(reputation: IpReputation | null): number | null {
  if (reputation === null || reputation.status !== 'ok') return null
  return reputation.risk === null ? null : 100 - reputation.risk
}
