import type { ProxyEndpointOrigin } from '@nexus/plugin-contracts/proxy-pool'

export const PROXY_PLUGIN_ID = 'studio.proxy-pool'
export const SCHEMES = ['http', 'https', 'socks5', 'socks5h'] as const
export type Scheme = (typeof SCHEMES)[number]

export type Geo = {
  status: string
  country: string | null
  countryCode: string | null
  region: string | null
  city: string | null
  isp: string | null
  error: string | null
}
export type Reputation = {
  status: string
  risk: number | null
  proxy: boolean | null
  vpn: boolean | null
  hosting: boolean | null
  networkType: string | null
  provider: string | null
  asn: string | null
  error: string | null
}
export type ProxyRow = {
  id: string
  origin?: ProxyEndpointOrigin | null
  name: string
  groupId: string | null
  schemes: Scheme[]
  host: string
  port: number
  username: string
  enabled: boolean
  udp: boolean
  hasPassword: boolean
  checkStatus: 'unknown' | 'ok' | 'failed'
  checkedScheme: Scheme | null
  checkedAt: string | null
  exitIp: string | null
  previousExitIp: string | null
  previousExitIpCheckedAt: string | null
  exitIpChanged: boolean
  geo: Geo | null
  reputation: Reputation | null
  latencyMs: number | null
  checkError: string | null
}
export type ProxyGroup = { id: number; name: string; createdAt: string }
export type ProxyConfig = {
  defaultEndpointId: string | null
  risk: { enabled: boolean; cacheSeconds: number; hasApiKey: boolean }
}
export type ProxyQuery = {
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
export const EMPTY_QUERY: ProxyQuery = {
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
export type ProxyInput = {
  name: string
  host: string
  port: number
  schemes: Scheme[]
  username: string
  password?: string
  enabled: boolean
  udp: boolean
  groupId: number | null
}
export type BatchResult = {
  requested: number
  created: number
  duplicates: number
  merged: number
}
export type Subscription = {
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
export type SubscriptionInput = {
  name: string
  enabled: boolean
  sourceMode: 'selected' | 'groups'
  proxyIds: number[]
  groupIds: number[]
  groupName: string
  includeDirect: boolean
  preferredScheme: Scheme | null
}

export function addressOf(row: Pick<ProxyRow, 'host' | 'port'>) {
  return `${row.host.includes(':') ? `[${row.host}]` : row.host}:${row.port}`
}

export function dateTime(value: string | null) {
  if (!value) return '未检测'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : date.toLocaleString('zh-CN', { hour12: false })
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : '操作失败，请重试'
}

export function activeFilterCount(query: ProxyQuery) {
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
