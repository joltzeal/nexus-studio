import { describe, expect, it } from 'vitest'
import { itemAiHandoff } from './item-ai-handoff'

const item = {
  id: 'vinted.fr:123',
  title: 'Blue coat',
  url: 'https://www.vinted.fr/items/123',
  brand: 'Synthetic brand',
  size: 'M',
  condition: 'Good',
  detail: {
    description: 'Cotton lining.\nSmall mark on sleeve.',
    seller: { email: 'private@example.test', password: 'private password' },
    token: 'private token',
    raw: { description: 'Do not copy nested raw fields' },
  },
  sellerProfile: { name: 'Private seller', login: 'private-login' },
  password: 'Do not copy credentials',
}

describe('Vinted product AI handoff', () => {
  it('passes only public product fields, source identity, and chosen images', () => {
    expect(itemAiHandoff(item, ['third.webp', 'first.webp'])).toEqual({
      presentation: 'dialog',
      images: ['third.webp', 'first.webp'],
      title: 'Blue coat',
      source: {
        pluginId: 'studio.vinted-monitor',
        itemId: 'vinted.fr:123',
        title: 'Blue coat',
        url: 'https://www.vinted.fr/items/123',
      },
      initialPrompt:
        '标题：Blue coat\n品牌：Synthetic brand\n尺码：M\n成色：Good\n描述：Cotton lining.\nSmall mark on sleeve.',
    })
  })

  it.each([undefined, null, 123, false, ['description'], { text: 'description' }])(
    'does not serialize non-string descriptions: %j',
    (description) => {
      const payload = itemAiHandoff({ ...item, detail: { description } }, [])
      expect(payload.initialPrompt).toBe(
        '标题：Blue coat\n品牌：Synthetic brand\n尺码：M\n成色：Good',
      )
    },
  )

  it('omits blank fields without adding invented instructions', () => {
    const payload = itemAiHandoff(
      { ...item, title: '', brand: ' ', size: '', condition: '', detail: {} },
      [],
    )
    expect(payload.initialPrompt).toBe('')
    expect(payload.source?.title).toBe('未命名商品')
  })

  it('preserves long prompts for the existing editable validation error', () => {
    const description = 'x'.repeat(12_001)
    const payload = itemAiHandoff({ ...item, detail: { description } }, [])
    expect(payload.initialPrompt!.length).toBeGreaterThan(12_000)
    expect(payload.initialPrompt).toContain(description)
  })

  it('preserves selection order and overflow without mutating the source', () => {
    const images = Object.freeze([
      'third.webp',
      'first.webp',
      ...Array<string>(6).fill('other.webp'),
    ])
    const payload = itemAiHandoff(Object.freeze(item), images)
    expect(payload.images).toEqual(images)
    expect(payload.images).toHaveLength(8)
    payload.images.reverse()
    expect(images[0]).toBe('third.webp')
    expect(item.detail.description).toBe('Cotton lining.\nSmall mark on sleeve.')
  })
})
