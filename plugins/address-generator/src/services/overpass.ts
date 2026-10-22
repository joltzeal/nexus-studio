import { addressKey, type AddressRecord } from '../domain/address.js'
import {
  UpstreamError,
  type UpstreamAttempt,
  type UpstreamReason,
} from '../domain/errors.js'
import type { CityRecord } from './catalog.js'

/**
 * Overpass mirrors in failover order. The first one is fast when it is healthy;
 * the second one is slower but survives the rate limiting the public instance
 * applies to anonymous clients.
 */
export const ENDPOINTS = [
  { url: 'https://overpass-api.de/api/interpreter', timeoutMs: 12_000 },
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', timeoutMs: 35_000 },
] as const

const BBOX_DELTA = 0.035
const MAX_ELEMENTS = 300
const MAX_BYTES = 2 * 1024 * 1024
const CACHE_MS = 15 * 60_000
const COOLDOWN_MS = 5_000
const OVERALL_TIMEOUT_MS = 50_000
const USER_AGENT = 'NexusAddressGenerator/1.0 (desktop address generator)'

export interface PublicAddressResult {
  items: AddressRecord[]
  endpoint: string
  cached: boolean
}

export interface PublicAddressOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  cacheMs?: number
  cooldownMs?: number
  overallTimeoutMs?: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function coordinates(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  )
}

/**
 * Keeps only elements that carry a complete address. A partial OSM node (street
 * without a house number, or a city without a postcode) is not usable as a
 * shipping address, so it is dropped rather than completed by guessing.
 */
export function cleanElements(payload: unknown, countryCode: string): AddressRecord[] {
  const data = record(payload)
  if (data === null || data['remark'] !== undefined) {
    throw new UpstreamError('invalid-response')
  }
  const elements = data['elements']
  if (!Array.isArray(elements) || elements.length > MAX_ELEMENTS) {
    throw new UpstreamError('invalid-response')
  }
  const addresses = new Map<string, AddressRecord>()
  for (const raw of elements) {
    const element = record(raw)
    if (element === null) continue
    const type = text(element['type'])
    if (type !== 'node' && type !== 'way' && type !== 'relation') continue
    const id = element['id']
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) continue
    const tags = record(element['tags'])
    if (tags === null) continue

    const taggedCountry = text(tags['addr:country']).toUpperCase()
    if (taggedCountry !== '' && taggedCountry !== countryCode) continue

    const houseNumber = text(tags['addr:housenumber'])
    const street = text(tags['addr:street'])
    const city = text(tags['addr:city'])
    const postalCode = text(tags['addr:postcode'])
    if (houseNumber === '' || street === '' || city === '' || postalCode === '') continue

    const center = record(element['center'])
    const latitude = type === 'node' ? element['lat'] : center?.['lat']
    const longitude = type === 'node' ? element['lon'] : center?.['lon']
    if (!coordinates(latitude, longitude)) continue

    const address: AddressRecord = {
      street,
      houseNumber,
      city,
      postalCode,
      countryCode,
      state: text(tags['addr:state']) || null,
      county: null,
      latitude: latitude as number,
      longitude: longitude as number,
      source: 'osm',
      sourceUrl: `https://www.openstreetmap.org/${type}/${id}`,
      approximate: false,
    }
    const key = addressKey(address)
    if (!addresses.has(key)) addresses.set(key, address)
  }
  return [...addresses.values()]
}

function buildQuery(city: CityRecord): string {
  const bbox = [
    city.latitude - BBOX_DELTA,
    city.longitude - BBOX_DELTA,
    city.latitude + BBOX_DELTA,
    city.longitude + BBOX_DELTA,
  ]
    .map((value) => value.toFixed(6))
    .join(',')
  return (
    '[out:json][timeout:25];' +
    'nwr["addr:housenumber"]["addr:street"]["addr:postcode"]["addr:city"]' +
    `(${bbox});out center ${MAX_ELEMENTS};`
  )
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const body = response.body
  if (body === null) return await response.text()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new UpstreamError('invalid-response')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function classify(error: unknown): UpstreamReason {
  if (error instanceof UpstreamError) return error.reason
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout'
    if (error.name === 'SyntaxError') return 'invalid-response'
  }
  return 'upstream-network'
}

/**
 * Public address lookup with a per-city cache, single flight and a global
 * cooldown. Mirrors the server-side service this plugin replaces: the same city
 * is fetched once, and a burst of requests cannot hammer the public mirrors.
 */
export class PublicAddressService {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly cooldownMs: number
  private readonly overallTimeoutMs: number
  private readonly cache = new Map<
    string,
    { items: AddressRecord[]; endpoint: string; expires: number }
  >()
  private readonly inFlight = new Map<string, Promise<PublicAddressResult>>()
  private nextRequestAt = 0

  constructor(options: PublicAddressOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.cacheMs = options.cacheMs ?? CACHE_MS
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS
    this.overallTimeoutMs = options.overallTimeoutMs ?? OVERALL_TIMEOUT_MS
  }

  async list(city: CityRecord): Promise<PublicAddressResult> {
    const cached = this.cache.get(city.id)
    if (cached !== undefined && cached.expires > this.now()) {
      return { items: cached.items, endpoint: cached.endpoint, cached: true }
    }
    const pending = this.inFlight.get(city.id)
    if (pending !== undefined) return pending
    if (this.now() < this.nextRequestAt) throw new UpstreamError('rate-limit')
    this.nextRequestAt = this.now() + this.cooldownMs
    const request = this.collect(city)
    this.inFlight.set(city.id, request)
    try {
      return await request
    } finally {
      this.inFlight.delete(city.id)
    }
  }

  private async collect(city: CityRecord): Promise<PublicAddressResult> {
    const query = buildQuery(city)
    const attempts: UpstreamAttempt[] = []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.overallTimeoutMs)
    try {
      for (const endpoint of ENDPOINTS) {
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(endpoint.timeoutMs),
        ])
        try {
          const response = await this.fetchImpl(endpoint.url, {
            method: 'POST',
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ data: query }).toString(),
            signal,
            redirect: 'error',
          })
          if (!response.ok) {
            attempts.push({
              endpoint: endpoint.url,
              reason: response.status === 429 ? 'rate-limit' : 'unavailable',
              status: response.status,
            })
            continue
          }
          const body = await readCapped(response, MAX_BYTES)
          const items = cleanElements(JSON.parse(body), city.country)
          this.cache.set(city.id, {
            items,
            endpoint: endpoint.url,
            expires: this.now() + this.cacheMs,
          })
          return { items, endpoint: endpoint.url, cached: false }
        } catch (error) {
          attempts.push({ endpoint: endpoint.url, reason: classify(error) })
        }
      }
    } finally {
      clearTimeout(timer)
    }
    if (controller.signal.aborted) throw new UpstreamError('timeout', attempts)
    const reasons = new Set(attempts.map((attempt) => attempt.reason))
    const reason = reasons.size === 1 ? ([...reasons][0] ?? 'unavailable') : 'unavailable'
    throw new UpstreamError(reason, attempts)
  }

  /** Test seam: forget cached cities so a test can observe a real request. */
  clearCache(): void {
    this.cache.clear()
  }
}

/** Fisher-Yates over a copy; the cached pool is never reordered in place. */
export function sampleAddresses(
  addresses: readonly AddressRecord[],
  count: number,
  random: () => number = Math.random,
): AddressRecord[] {
  const pool = [...addresses]
  for (let index = pool.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const current = pool[index] as AddressRecord
    pool[index] = pool[other] as AddressRecord
    pool[other] = current
  }
  return pool.slice(0, Math.max(1, Math.min(50, count)))
}
