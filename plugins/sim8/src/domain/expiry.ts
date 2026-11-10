import type { SmsRecord } from './types.js'

export const EXPIRY_BATCH_SIZE = 8
const DAY_MS = 24 * 60 * 60 * 1000

/** Provider dates without an offset use the device's local timezone. */
export function parseExpiry(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const source = String(value).trim()
  if (/^\d{10}$|^\d{13}$/.test(source)) {
    const at = Number(source) * (source.length === 10 ? 1000 : 1)
    return Number.isFinite(at) ? at : null
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      source,
    )
  if (!match) return null
  const [
    ,
    year,
    month,
    day,
    hour = '00',
    minute = '00',
    second = '00',
    fraction = '',
    zone = '',
  ] = match
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return null
  const at = Date.parse(
    `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${zone}`,
  )
  return Number.isFinite(at) ? at : null
}

export function expiryFromBody(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const root = parsed as Record<string, unknown>
  const data =
    typeof root['data'] === 'object' &&
    root['data'] !== null &&
    !Array.isArray(root['data'])
      ? (root['data'] as Record<string, unknown>)
      : {}
  const at = parseExpiry(root['expire']) ?? parseExpiry(data['expire'])
  return at === null ? null : new Date(at).toISOString()
}

export function reminderDay(expiresAt: number, now: Date): string | null {
  const remaining = expiresAt - now.getTime()
  if (remaining <= 0 || remaining > 7 * DAY_MS) return null
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

export function expiryCheckDue(record: SmsRecord, now: Date): boolean {
  if (record.api.trim() === '') return false
  const attempted = Date.parse(record.expiry?.attemptedAt ?? '')
  if (!Number.isFinite(attempted) || attempted > now.getTime()) return true
  const success = record.expiry?.checkedAt === record.expiry?.attemptedAt
  return now.getTime() - attempted >= (success ? 6 * 60 : 15) * 60_000
}

export function expiryState(record: SmsRecord) {
  return (
    record.expiry ?? {
      attemptedAt: null,
      checkedAt: null,
      dismissedOn: null,
      dismissedFor: null,
    }
  )
}
