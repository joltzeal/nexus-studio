import { describe, expect, it } from 'vitest'
import { formatAbsolute, formatRelative, majorVersion } from './format-time'

const NOON = new Date('2026-10-22T12:00:00Z').getTime()
const at = (secondsAgo: number) => Math.floor(NOON / 1000) - secondsAgo

describe('window timestamps', () => {
  it('shows an absolute minute-precision time', () => {
    const stamp = at(0)
    const date = new Date(stamp * 1000)
    const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(
      date.getMinutes(),
    ).padStart(2, '0')}`
    expect(formatAbsolute(stamp, NOON)).toBe(expected)
  })

  it('treats a missing timestamp as a dash instead of 1970', () => {
    expect(formatAbsolute(null, NOON)).toBe('—')
    expect(formatAbsolute(0, NOON)).toBe('—')
  })

  it('describes recent times relatively and old ones as a date', () => {
    expect(formatRelative(at(5), NOON)).toBe('刚刚')
    expect(formatRelative(at(12 * 60), NOON)).toBe('12 分钟前')
    expect(formatRelative(at(3 * 3600), NOON)).toBe('3 小时前')
    expect(formatRelative(at(2 * 86400), NOON)).toBe('2 天前')
    expect(formatRelative(at(60 * 86400), NOON)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('says never when the window has not been opened', () => {
    expect(formatRelative(null, NOON)).toBe('从未')
  })
})

describe('kernel version', () => {
  it('keeps only the major channel number', () => {
    expect(majorVersion('155.0.7632.109')).toBe('155')
    expect(majorVersion('145.0.7632.109.5')).toBe('145')
    expect(majorVersion('155')).toBe('155')
    expect(majorVersion('')).toBe('')
  })
})
