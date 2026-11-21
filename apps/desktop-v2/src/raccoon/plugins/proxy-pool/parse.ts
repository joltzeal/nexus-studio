import { ProxyEndpointOriginSchema } from '@nexus/plugin-contracts/proxy-pool'
import {
  SCHEMES,
  type ProxyRow,
  type ProxyConfig,
  type Subscription,
  type Scheme,
} from './model.ts'

const invalid = () => new Error('代理池返回格式无效，请更新插件后重试')

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
export function text(value: unknown): string {
  if (typeof value !== 'string') throw invalid()
  return value
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw invalid()
  return value
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid()
  return value
}
export function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null {
  return value === null ? null : parse(value)
}
export function array<T>(value: unknown, parse: (input: unknown) => T): T[] {
  if (!Array.isArray(value)) throw invalid()
  return value.map(parse)
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw invalid()
  return value as T
}
function id(value: unknown) {
  const result = text(value)
  if (!/^[1-9]\d*$/.test(result) || !Number.isSafeInteger(Number(result))) throw invalid()
  return result
}
export function scheme(value: unknown): Scheme {
  return choice(value, SCHEMES)
}

export function parseProxy(value: unknown): ProxyRow {
  const row = object(value)
  const geo = row.geo === null ? null : object(row.geo)
  const reputation = row.reputation === null ? null : object(row.reputation)
  const schemes = array(row.schemes, scheme)
  if (
    schemes.length === 0 ||
    schemes.length > 4 ||
    new Set(schemes).size !== schemes.length
  )
    throw invalid()
  return {
    id: id(row.id),
    ...(row.origin === undefined
      ? {}
      : { origin: ProxyEndpointOriginSchema.nullable().parse(row.origin) }),
    name: text(row.name),
    groupId: nullable(row.groupId, id),
    schemes,
    host: text(row.host),
    port: integer(row.port, 1, 65535),
    username: text(row.username),
    enabled: boolean(row.enabled),
    udp: boolean(row.udp),
    hasPassword: boolean(row.hasPassword),
    checkStatus: choice(row.checkStatus, ['unknown', 'ok', 'failed']),
    checkedScheme: nullable(row.checkedScheme, scheme),
    checkedAt: nullable(row.checkedAt, text),
    exitIp: nullable(row.exitIp, text),
    previousExitIp: nullable(row.previousExitIp, text),
    previousExitIpCheckedAt: nullable(row.previousExitIpCheckedAt, text),
    exitIpChanged: boolean(row.exitIpChanged),
    latencyMs: nullable(row.latencyMs, (input) => integer(input)),
    checkError: nullable(row.checkError, text),
    geo: geo && {
      status: choice(geo.status, ['ok', 'not_found', 'unavailable', 'non_public']),
      country: nullable(geo.country, text),
      countryCode: nullable(geo.countryCode, text),
      region: nullable(geo.region, text),
      city: nullable(geo.city, text),
      isp: nullable(geo.isp, text),
      error: nullable(geo.error, text),
    },
    reputation: reputation && {
      status: choice(reputation.status, [
        'ok',
        'unavailable',
        'rate_limited',
        'disabled',
        'non_public',
      ]),
      risk: nullable(reputation.risk, (input) => integer(input, 0, 100)),
      proxy: nullable(reputation.proxy, boolean),
      vpn: nullable(reputation.vpn, boolean),
      hosting: nullable(reputation.hosting, boolean),
      networkType: nullable(reputation.networkType, text),
      provider: nullable(reputation.provider, text),
      asn: nullable(reputation.asn, text),
      error: nullable(reputation.error, text),
    },
  }
}

export function parseList(value: unknown) {
  const row = object(value)
  const result = {
    total: integer(row.total),
    offset: integer(row.offset),
    limit: integer(row.limit, 1, 500),
    items: array(row.items, parseProxy),
  }
  if (
    result.items.length > result.limit ||
    (result.items.length === 0 && result.offset < result.total) ||
    new Set(result.items.map((item) => item.id)).size !== result.items.length ||
    (result.items.length > 0 && result.offset + result.items.length > result.total)
  )
    throw invalid()
  return result
}

export function parseConfig(value: unknown): ProxyConfig {
  const row = object(value)
  const risk = object(row.risk)
  return {
    defaultEndpointId: nullable(row.defaultEndpointId, id),
    risk: {
      enabled: boolean(risk.enabled),
      cacheSeconds: integer(risk.cacheSeconds, 0, 86400),
      hasApiKey: boolean(risk.hasApiKey),
    },
  }
}

export function parseSubscription(value: unknown): Subscription {
  const row = object(value)
  return {
    id: id(row.id),
    name: text(row.name),
    enabled: boolean(row.enabled),
    sourceMode: choice(row.sourceMode, ['selected', 'groups']),
    groupName: text(row.groupName),
    includeDirect: boolean(row.includeDirect),
    preferredScheme: nullable(row.preferredScheme, scheme),
    memberCount: integer(row.memberCount),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  }
}
