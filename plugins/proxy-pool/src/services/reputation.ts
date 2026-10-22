import { createHash } from 'node:crypto'

import type { GeoLocation, IpReputation } from '../domain/schemas.js'

/**
 * Online reputation of an observed exit IP. Proxy credentials are never sent;
 * only the exit IP leaves the machine, and only to the declared domain.
 */

export interface ReputationCache {
  get(key: string): { value: IpReputation; expiresAt: number } | undefined
  set(key: string, value: IpReputation, ttlMs: number): void
}

export function createMemoryCache(): ReputationCache {
  const entries = new Map<string, { value: IpReputation; expiresAt: number }>()
  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key)
        return undefined
      }
      return entry
    },
    set(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs })
    },
  }
}

export interface ReputationOptions {
  apiKey: string | null
  enabled: boolean
  cacheSeconds: number
  now: () => Date
  cache: ReputationCache
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const QUOTA_WORDS = ['quota', 'allowance', 'limit', 'queries', 'requests per second']

function quotaExhausted(payload: unknown): boolean {
  const message =
    typeof payload === 'object' && payload !== null && 'message' in payload
      ? String((payload as { message?: unknown }).message ?? '').toLowerCase()
      : ''
  return QUOTA_WORDS.some((word) => message.includes(word))
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function geolocation(entry: Record<string, unknown>): GeoLocation {
  const location = record(entry.location)
  const network = record(entry.network)
  if (location === null || network === null) {
    return {
      status: 'unavailable',
      source: 'proxycheck.io',
      country: null,
      countryCode: null,
      region: null,
      city: null,
      isp: null,
      error: '在线属地服务未返回有效数据',
    }
  }
  const country = text(location.country_name)
  const rawCode = text(location.country_code)
  const code =
    rawCode !== null && rawCode.length === 2 && /^[A-Za-z]{2}$/.test(rawCode)
      ? rawCode.toUpperCase()
      : null
  const region = text(location.region_name)
  const city = text(location.city_name)
  return {
    status: (country ?? code ?? region ?? city) ? 'ok' : 'not_found',
    source: 'proxycheck.io',
    country,
    countryCode: code,
    region,
    city,
    isp: text(network.provider) ?? text(network.organisation),
    error: null,
  }
}

function emptyReputation(ip: string, now: Date): IpReputation {
  return {
    status: 'unavailable',
    source: 'proxycheck.io',
    ip,
    checkedAt: now.toISOString(),
    cached: false,
    risk: null,
    confidence: null,
    proxy: null,
    vpn: null,
    tor: null,
    hosting: null,
    compromised: null,
    scraper: null,
    networkType: null,
    provider: null,
    asn: null,
    geo: null,
    error: null,
  }
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export async function lookupIpReputation(
  value: string,
  options: ReputationOptions,
): Promise<IpReputation> {
  const now = options.now()
  const base = emptyReputation(value, now)
  if (!options.enabled) {
    return { ...base, status: 'disabled', error: '在线风险查询已在插件配置中关闭' }
  }
  if (!isGlobalAddress(value)) {
    return { ...base, status: 'non_public', error: null }
  }

  // Cache scope follows the API key so a changed key never reads stale quota.
  const scope =
    options.apiKey === null
      ? 'anonymous'
      : createHash('sha256').update(options.apiKey).digest('hex').slice(0, 16)
  const prefix = `proxy-pool:risk:v1:${scope}`
  const key = `${prefix}:${value}`
  const cooldownKey = `${prefix}:cooldown`

  const cached = options.cache.get(key)
  if (cached !== undefined && cached.value.ip === value) {
    return { ...cached.value, cached: true }
  }
  const cooldown = options.cache.get(cooldownKey)
  if (cooldown !== undefined) {
    return { ...cooldown.value, ip: value, geo: null, cached: true }
  }

  const params = new URLSearchParams({ tag: '0', ver: '24-June-2026' })
  if (options.apiKey !== null) params.set('key', options.apiKey)
  const fetchImpl = options.fetchImpl ?? fetch
  let result: IpReputation

  try {
    const response = await fetchImpl(
      `https://proxycheck.io/v3/${encodeURIComponent(value)}?${params.toString()}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'nexus-proxy-pool/1.0' },
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      },
    )
    if (response.status === 429) {
      result = {
        ...base,
        status: 'rate_limited',
        error: '在线风险服务额度不足或请求过快',
      }
    } else if (response.status !== 200) {
      let limited = false
      try {
        limited = quotaExhausted(await response.json())
      } catch {
        limited = false
      }
      result = limited
        ? { ...base, status: 'rate_limited', error: '在线风险服务额度不足' }
        : {
            ...base,
            status: 'unavailable',
            error: `在线风险服务返回 HTTP ${response.status}`,
          }
    } else {
      const payload = (await response.json()) as unknown
      const payloadRecord = record(payload)
      if (payloadRecord === null) throw new Error('invalid payload')
      const entry = record(payloadRecord[value])
      const status = payloadRecord.status
      if ((status === 'ok' || status === 'warning') && entry !== null) {
        // Location stays usable even when risk fields are missing or malformed.
        const geo = geolocation(entry)
        const detections = record(entry.detections)
        if (detections === null) throw new Error('missing detections')
        const risk = detections.risk
        if (
          typeof risk !== 'number' ||
          !Number.isInteger(risk) ||
          risk < 0 ||
          risk > 100
        ) {
          throw new Error('missing risk score')
        }
        const network = record(entry.network) ?? {}
        const confidence = detections.confidence
        result = {
          status: 'ok',
          source: 'proxycheck.io',
          ip: value,
          checkedAt: options.now().toISOString(),
          cached: false,
          risk,
          confidence:
            typeof confidence === 'number' && Number.isInteger(confidence)
              ? confidence
              : null,
          proxy: asBoolean(detections.proxy),
          vpn: asBoolean(detections.vpn),
          tor: asBoolean(detections.tor),
          hosting: asBoolean(detections.hosting),
          compromised: asBoolean(detections.compromised),
          scraper: asBoolean(detections.scraper),
          networkType: text(network.type),
          provider: text(network.provider),
          asn: text(network.asn),
          geo,
          error: null,
        }
      } else {
        // Provider messages are classified, never returned verbatim.
        const limited = quotaExhausted(payloadRecord)
        result = limited
          ? { ...base, status: 'rate_limited', error: '在线风险服务额度不足' }
          : {
              ...base,
              status: 'unavailable',
              error: '在线风险服务拒绝查询，请检查 API Key 或服务状态',
            }
      }
    }
  } catch {
    result = {
      ...base,
      status: 'unavailable',
      error: '在线风险服务暂不可用，未获得风险评分',
    }
  }

  const ttlSeconds = result.status === 'ok' ? options.cacheSeconds : 300
  if (ttlSeconds > 0) options.cache.set(key, result, ttlSeconds * 1000)
  if (result.status !== 'ok') {
    // Back off across all IPs so a large batch cannot hammer an exhausted account.
    options.cache.set(
      cooldownKey,
      result,
      result.status === 'rate_limited' ? 300_000 : 60_000,
    )
  }
  return result
}

/** Mirrors `ipaddress.is_global`: reserved, private and loopback ranges are not queried. */
export function isGlobalAddress(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.').map(Number)
    if (parts.some((part) => part < 0 || part > 255)) return false
    const [a = 0, b = 0, c = 0] = parts
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
    if (a === 192 && b === 88 && c === 99) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    if (a === 198 && b === 51 && c === 100) return false
    if (a === 203 && b === 0 && c === 113) return false
    if (a >= 224) return false
    return true
  }
  const lower = value.toLowerCase()
  if (lower === '::' || lower === '::1') return false
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return false
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false
  if (lower.startsWith('ff')) return false
  if (lower.startsWith('2001:db8')) return false
  return true
}
