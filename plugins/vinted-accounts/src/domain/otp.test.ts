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

  it('falls back to the first six-digit run when no keyword is present', () => {
    expect(extractOtp('482913', 'text/plain')).toBe('482913')
  })

  it('ignores a year when the body has no code at all', () => {
    expect(extractOtp('<p>Copyright 2026 Vinted</p>', 'text/html')).toBeNull()
  })

  it('returns null for an empty body', () => {
    expect(extractOtp('   ', 'text/plain')).toBeNull()
  })
})
