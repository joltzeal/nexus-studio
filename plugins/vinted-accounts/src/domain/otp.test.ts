import { describe, expect, it } from 'vitest'

import { extractOtp } from './otp.js'

describe('verification code extraction', () => {
  it('reads a JSON body that names the field', () => {
    expect(extractOtp('{"code":"654321"}', 'application/json')).toBe('654321')
  })

  it('reads a numeric JSON field', () => {
    expect(extractOtp('{"data":{"otp":123456}}', 'application/json')).toBe('123456')
  })

  it('reads an HTML email with the code in a paragraph', () => {
    const html = `
      <html><head><style>.x { color: #2026 }</style></head>
      <body><p>您的验证码是 482913，10 分钟内有效。</p>
      <script>var year = 2026;</script></body></html>`
    expect(extractOtp(html, 'text/html')).toBe('482913')
  })

  it('reads plain text that only carries the digits', () => {
    expect(extractOtp('Your Vinted code: 902114', 'text/plain')).toBe('902114')
  })

  it('reads a four-digit SMS code', () => {
    expect(extractOtp('Vinted 验证码 8042，请勿泄露。', 'text/plain')).toBe('8042')
  })

  it('falls back to the only digits when no keyword is present', () => {
    expect(extractOtp('482913', 'text/plain')).toBe('482913')
    expect(extractOtp('1234', 'text/plain')).toBe('1234')
  })

  it('prefers the digits next to a keyword over other numbers in the body', () => {
    const html = '<p>Order 5521 total 1200</p><p>Your code is 731204</p>'
    expect(extractOtp(html, 'text/html')).toBe('731204')
  })

  it('refuses to guess when the body carries two different codes', () => {
    expect(extractOtp('<p>code 654321</p><p>code 123456</p>', 'text/html')).toBeNull()
  })

  it('ignores a year when the body has no code at all', () => {
    expect(extractOtp('<p>Copyright 2026 Vinted</p>', 'text/html')).toBeNull()
  })

  it('refuses to guess between several unrelated numbers', () => {
    expect(extractOtp('Order 5521 shipped 1200 units', 'text/plain')).toBeNull()
  })

  it('returns null for an empty body', () => {
    expect(extractOtp('   ', 'text/plain')).toBeNull()
  })
})
