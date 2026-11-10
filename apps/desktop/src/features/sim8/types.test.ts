import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordExpired, shortTime, type SmsRecord } from './types'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('number pool expiry display', () => {
  it('uses the refreshed expiry after renewal instead of a stale expired status', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T10:00:00Z'))
    expect(
      recordExpired({ status: 2, endTime: '2026-11-03T10:00:00Z' } as SmsRecord),
    ).toBe(false)
    expect(
      recordExpired({ status: 0, endTime: '2026-10-30T09:59:00Z' } as SmsRecord),
    ).toBe(true)
    expect(recordExpired({ status: 2, endTime: '' } as SmsRecord)).toBe(true)
    expect(recordExpired({ status: 0, endTime: '' } as SmsRecord)).toBe(false)
  })

  it('shows ISO expiry in local time and keeps unzoned provider dates unchanged', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai')
    expect(shortTime('2026-11-03T10:00:00.000Z')).toBe('2026-11-03 18:00')
    expect(shortTime('2026-11-03 18:00:00')).toBe('2026-11-03 18:00')
    expect(shortTime('')).toBe('—')
  })
})
