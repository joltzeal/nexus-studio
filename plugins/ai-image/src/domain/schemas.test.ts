import { describe, expect, it } from 'vitest'

import { baseUrlSchema, normalizeBaseUrl } from './schemas.js'

describe('接口地址', () => {
  it('补齐版本段并去掉结尾斜杠', () => {
    expect(normalizeBaseUrl('https://api.openai.com')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://api.openai.com/')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1',
    )
  })

  it('保留网关自定义路径', () => {
    expect(normalizeBaseUrl('https://gateway.example.com/openai/v1')).toBe(
      'https://gateway.example.com/openai/v1',
    )
  })

  it('拒绝带账号密码、非 http 或空主机的地址', () => {
    expect(baseUrlSchema.safeParse('https://user:pass@api.openai.com/v1').success).toBe(
      false,
    )
    expect(baseUrlSchema.safeParse('file:///etc/passwd').success).toBe(false)
    expect(baseUrlSchema.safeParse('https://').success).toBe(false)
    expect(baseUrlSchema.safeParse('https://api.openai.com/v1').success).toBe(true)
  })
})
