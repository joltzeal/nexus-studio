import { describe, expect, it, vi } from 'vitest'
import { onAiImageHandoff, sendToAiImage, type AiImageHandoff } from './page-handoff'

describe('AI image handoff', () => {
  it('passes only gallery choices, source and editable prompt unchanged', () => {
    const payload: AiImageHandoff = {
      images: [
        'https://images.example.test/third.jpg',
        'https://images.example.test/first.jpg',
      ],
      title: 'Used blue mug',
      source: {
        pluginId: 'studio.vinted-monitor',
        itemId: 'vinted.fr:123',
        title: 'Used blue mug',
        url: 'https://www.vinted.fr/items/123',
      },
      initialPrompt: 'Used blue mug\nSmall chip at the rim.',
    }
    const listener = vi.fn()
    const unsubscribe = onAiImageHandoff(listener)
    try {
      sendToAiImage(payload)
      expect(listener).toHaveBeenCalledExactlyOnceWith(payload)
      expect(Object.keys(listener.mock.calls[0]?.[0] as AiImageHandoff)).toEqual([
        'images',
        'title',
        'source',
        'initialPrompt',
      ])
    } finally {
      unsubscribe()
    }
    sendToAiImage(payload)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('supports existing handoffs without inventing a source or prompt', () => {
    const listener = vi.fn()
    const unsubscribe = onAiImageHandoff(listener)
    try {
      sendToAiImage({ images: [], title: 'Product' })
      expect(listener).toHaveBeenCalledExactlyOnceWith({ images: [], title: 'Product' })
    } finally {
      unsubscribe()
    }
  })
})
