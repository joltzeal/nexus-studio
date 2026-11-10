import { describe, expect, it } from 'vitest'
import { expiryFromBody, parseExpiry, reminderDay } from './expiry.js'

describe('number expiry', () => {
  it('reads expire even when there is no SMS yet, without treating queue dates as expiry', () => {
    expect(
      expiryFromBody('{"code":0,"msg":"No SMS","expire":"2026-11-03T10:00:00Z"}'),
    ).toBe('2026-11-03T10:00:00.000Z')
    expect(expiryFromBody('{"data":{"expire":"2026-11-03T18:00:00+08:00"}}')).toBe(
      '2026-11-03T10:00:00.000Z',
    )
    expect(
      expiryFromBody('{"expire_at":"2026-11-03","sms":"expire: 2026-11-03"}'),
    ).toBeNull()
    expect(expiryFromBody('<html>2026-11-03</html>')).toBeNull()
  })

  it('supports Unix seconds/milliseconds, explicit offsets and local provider dates', () => {
    const at = Date.parse('2026-11-03T10:00:00Z')
    for (const value of [at, String(at), at / 1000, String(at / 1000)]) {
      expect(parseExpiry(value)).toBe(at)
    }
    expect(parseExpiry('2026-11-03 18:00:00')).toBe(
      new Date(2026, 10, 3, 18, 0, 0).getTime(),
    )
    expect(parseExpiry('2026-11-03')).toBe(new Date(2026, 10, 3).getTime())
  })

  it.each([
    null,
    undefined,
    '',
    0,
    1234,
    '7',
    'never',
    '2026-02-30',
    '2026-11-03 25:00:00',
    false,
  ])('rejects an absent or invalid expiry: %s', (value) =>
    expect(parseExpiry(value)).toBeNull(),
  )

  it('starts exactly seven days before expiry and uses the local day for dismissals', () => {
    const at = new Date(2026, 10, 6, 12)
    const week = 7 * 24 * 60 * 60 * 1000
    expect(reminderDay(at.getTime(), new Date(at.getTime() - week - 1))).toBeNull()
    expect(reminderDay(at.getTime(), new Date(at.getTime() - week))).toBe('2026-10-30')
    expect(reminderDay(at.getTime(), new Date(2026, 10, 6, 11))).toBe('2026-11-06')
    expect(reminderDay(at.getTime(), at)).toBeNull()
    expect(reminderDay(at.getTime(), new Date(2026, 10, 7))).toBeNull()
  })
})
