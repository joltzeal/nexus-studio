const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Unix seconds → `2026-10-22 21:08`. Empty input reads as a dash. */
export function formatAbsolute(unixSeconds: number | null, now = Date.now()): string {
  if (unixSeconds === null || unixSeconds <= 0) return '—'
  const date = new Date(unixSeconds * 1000)
  if (Number.isNaN(date.getTime())) return '—'
  // A clock skew of minutes is not worth a different label.
  if (unixSeconds * 1000 > now + 2 * DAY * 1000) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/**
 * Unix seconds → `刚刚` / `12 分钟前` / `3 小时前` / `2 天前` / `2026-08-01`.
 * Anything older than a month switches to a date, because "63 天前" stops
 * being useful.
 */
export function formatRelative(unixSeconds: number | null, now = Date.now()): string {
  if (unixSeconds === null || unixSeconds <= 0) return '从未'
  const seconds = Math.floor(now / 1000) - unixSeconds
  if (seconds < 0) return '刚刚'
  if (seconds < MINUTE) return '刚刚'
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)} 分钟前`
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)} 小时前`
  if (seconds < 30 * DAY) return `${Math.floor(seconds / DAY)} 天前`
  const date = new Date(unixSeconds * 1000)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `155.0.7632.109` → `155`: the channel is what a person recognises. */
export function majorVersion(version: string): string {
  const [major] = version.split('.')
  return major === undefined || major === '' ? version : major
}
