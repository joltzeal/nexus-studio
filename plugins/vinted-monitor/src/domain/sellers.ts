import type { Seller } from './types.js'

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function counter(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null
}

export function numericId(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))
    return null
  const id = typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  return /^\d{1,32}$/.test(id) && /[1-9]/.test(id) ? id : null
}

export function profileTime(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const n = Number(value)
  const millis = Number.isFinite(n)
    ? n > 0
      ? n >= 1e11
        ? n
        : n * 1000
      : NaN
    : Date.parse(String(value))
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function text(raw: Record<string, unknown>, ...fields: string[]): string | null {
  for (const field of fields) {
    const v = raw[field]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

export function imageUrls(raw: Record<string, unknown>): string[] {
  const photos = [raw.photo, ...(Array.isArray(raw.photos) ? raw.photos : [])]
  const urls: string[] = []
  for (const photo of photos) {
    const obj = record(photo)
    for (const value of [obj?.url, obj?.full_size_url]) {
      if (typeof value !== 'string') continue
      try {
        const url = new URL(value)
        if (url.protocol === 'https:' && !url.username && !url.password)
          urls.push(url.href)
      } catch {
        /* Ignore malformed upstream image references. */
      }
    }
  }
  return [...new Set(urls)]
}

export function sellerRecord(
  domain: string,
  externalId: string,
  checkedAt: string,
  profile: Record<string, unknown> | null = null,
  error: string | null = null,
): Seller {
  const raw = profile ?? {}
  const verification: Seller['verification'] = {}
  for (const [provider, value] of Object.entries(record(raw.verification) ?? {})) {
    const status = record(value)
    if (status === null) continue
    Object.defineProperty(verification, provider, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        valid: typeof status.valid === 'boolean' ? status.valid : null,
        available: typeof status.available === 'boolean' ? status.available : null,
        verifiedAt: profileTime(status.verified_at),
      },
    })
  }
  return {
    id: `${domain}:${externalId}`,
    externalId,
    domain,
    login: text(raw, 'login'),
    name: text(raw, 'name', 'real_name'),
    profileUrl: `https://${domain}/member/${externalId}`,
    avatarUrl: imageUrls(raw)[0] ?? null,
    country: text(raw, 'country_title_local', 'country_title', 'country_code'),
    city: text(raw, 'city'),
    feedbackReputation:
      typeof raw.feedback_reputation === 'number' &&
      Number.isFinite(raw.feedback_reputation)
        ? raw.feedback_reputation
        : null,
    feedbackCount: counter(raw.feedback_count),
    followersCount: counter(raw.followers_count),
    itemCount: counter(raw.item_count),
    verification,
    lastLogedOnTs: profileTime(raw.last_loged_on_ts),
    updatedOn: profileTime(raw.updated_on),
    collectedAt: profile === null ? null : checkedAt,
    checkedAt,
    error,
    detail: profile,
  }
}
