import { describe, expect, it } from 'vitest'

import {
  baseUrlSchema,
  GenerateInputSchema,
  GenerationSourceSchema,
  normalizeBaseUrl,
  RecordsListInputSchema,
} from './schemas.js'

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

const source = {
  pluginId: 'studio.vinted-monitor',
  itemId: 'vinted.fr:123',
  title: 'A used mug',
  url: 'https://www.vinted.fr/items/123',
}

describe('generation source boundary', () => {
  it('accepts bounded metadata and canonical item IDs without changing identity', () => {
    expect(GenerationSourceSchema.parse(source)).toEqual(source)
    expect(
      GenerationSourceSchema.parse({
        pluginId: 'x'.repeat(128),
        itemId: 'i'.repeat(128),
        title: 't'.repeat(500),
        url: 'https://example.test/' + 'a'.repeat(2027),
      }),
    ).toBeTruthy()
  })

  it.each([
    { pluginId: '' },
    { itemId: ' ' },
    { pluginId: 'x'.repeat(129) },
    { itemId: 'x'.repeat(129) },
    { title: 'x'.repeat(501) },
    { url: 'https://example.test/' + 'x'.repeat(2048) },
    { url: 'https://account:password@example.test/item' },
    { url: 'javascript:alert(1)' },
    { apiKey: 'do-not-accept' },
  ])('rejects invalid/credential-bearing metadata %j', (patch) => {
    expect(GenerationSourceSchema.safeParse({ ...source, ...patch }).success).toBe(false)
  })

  it('requires both source identifiers and no complete source serialization for listing', () => {
    expect(
      RecordsListInputSchema.parse({
        page: 1,
        size: 10,
        sourcePluginId: source.pluginId,
        sourceItemId: source.itemId,
      }),
    ).toEqual({
      page: 1,
      size: 10,
      sourcePluginId: source.pluginId,
      sourceItemId: source.itemId,
    })
    for (const filter of [
      { sourcePluginId: source.pluginId },
      { sourceItemId: source.itemId },
      { sourcePluginId: source.pluginId, sourceItemId: '' },
    ]) {
      expect(
        RecordsListInputSchema.safeParse({ page: 0, size: 10, ...filter }).success,
      ).toBe(false)
    }
  })

  it('allows legacy input without source but rejects seven references', () => {
    const input = {
      providerId: 'p1',
      imageModel: 'image-model',
      mode: 'edit',
      presetId: null,
      prompt: 'mug',
      size: 'auto',
      count: 1,
      inputFileIds: ['a'],
    }
    expect(GenerateInputSchema.parse(input)).not.toHaveProperty('source')
    expect(GenerateInputSchema.parse({ ...input, source }).source).toEqual(source)
    expect(
      GenerateInputSchema.safeParse({
        ...input,
        inputFileIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      }).success,
    ).toBe(false)
  })
})
