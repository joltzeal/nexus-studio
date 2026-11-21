const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const RELATIVE_UNITS = [
  [365 * DAY, '年'],
  [30 * DAY, '个月'],
  [DAY, '天'],
  [HOUR, '小时'],
  [MINUTE, '分钟'],
] as const

const absoluteTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short',
})

export function productAddedTime(
  createdAt: unknown,
  now = Date.now(),
): { label: string; dateTime?: string; title?: string } {
  if (typeof createdAt !== 'string' || !createdAt.trim()) return { label: '未知' }
  const timestamp = Date.parse(createdAt)
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return { label: '未知' }
  const seconds = (now - timestamp) / 1000
  const elapsed = Math.abs(seconds)
  const unit = RELATIVE_UNITS.find(([duration]) => elapsed >= duration)
  const label = unit
    ? `${Math.floor(elapsed / unit[0])} ${unit[1]}${seconds < 0 ? '后' : '前'}`
    : seconds < 0
      ? '不到 1 分钟后'
      : '刚刚'
  return {
    label,
    dateTime: createdAt,
    title: `${absoluteTime.format(timestamp)} (${createdAt})`,
  }
}

export function productPublicationCountLabel(count: unknown): string {
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    ? String(count)
    : '未知'
}
