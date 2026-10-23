import { describe, expect, it } from 'vitest'

import { extractOtp, plainText } from './otp.js'

describe('verification code extraction', () => {
  it('reads the code out of a bare digit body', () => {
    expect(extractOtp('482913')).toBe('482913')
  })

  it('reads a four-digit code, which is what phone messages carry', () => {
    expect(extractOtp('您的验证码是 8421，请勿告诉他人')).toBe('8421')
  })

  it('reads a code out of a JSON answer', () => {
    expect(extractOtp('{"code":"654321","msg":"ok"}', 'application/json')).toBe('654321')
  })

  it('ignores the business code and keeps the code in data', () => {
    const body = '{"code":1,"msg":"ok","data":{"sms":"Your code is 918273"}}'
    expect(extractOtp(body, 'application/json')).toBe('918273')
  })

  it('prefers a keyword match over an unrelated number', () => {
    const body = '订单 5521 已发货，验证码 482913，有效期 10 分钟'
    expect(extractOtp(body)).toBe('482913')
  })

  it('refuses to guess when the body carries two different codes', () => {
    expect(extractOtp('code 654321 / code 123456')).toBeNull()
  })

  it('treats a copyright year as a year, not a code', () => {
    expect(
      extractOtp('<footer>Copyright 2026 Example Ltd</footer>', 'text/html'),
    ).toBeNull()
  })

  it('reports an empty body as no code', () => {
    expect(extractOtp('   ')).toBeNull()
  })

  it('reports a message that has not arrived yet', () => {
    expect(extractOtp('{"code":0,"msg":"还没有收到短信"}', 'application/json')).toBeNull()
  })

  it('strips markup before looking for digits', () => {
    expect(plainText('<p>验证码&nbsp;<b>482913</b></p>')).toBe('验证码 482913')
    expect(extractOtp('<p>验证码&nbsp;<b>482913</b></p>', 'text/html')).toBe('482913')
  })
})
