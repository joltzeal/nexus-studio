import { describe, expect, it } from 'vitest'

import { SCENE_PRESETS, composePrompt, presetById, presetLabel } from './presets.js'

describe('场景预设', () => {
  it('每个预设都有唯一 id 与可发送的提示词', () => {
    const ids = new Set<string>()
    for (const preset of SCENE_PRESETS) {
      expect(preset.id).not.toBe('')
      expect(preset.label).not.toBe('')
      expect(preset.hint).not.toBe('')
      expect(preset.prompt.length).toBeGreaterThan(40)
      expect(ids.has(preset.id)).toBe(false)
      ids.add(preset.id)
    }
  })

  it('组合提示词会带上商品重建说明与附加要求', () => {
    const prompt = composePrompt('white-studio', '背景再暖一点')
    expect(prompt).toContain('Rebuild the product from the reference image')
    expect(prompt).toContain('seamless pure white studio background')
    expect(prompt).toContain('Additional requirements: 背景再暖一点')
  })

  it('自由提示词原样发送，不附加预设说明', () => {
    expect(composePrompt(null, '  a calm still life  ')).toBe('a calm still life')
  })

  it('未知预设退化成自由提示词，不编造场景', () => {
    expect(composePrompt('does-not-exist', 'only this')).toBe('only this')
    expect(presetById('does-not-exist')).toBeNull()
    expect(presetLabel('does-not-exist')).toBeNull()
    expect(presetLabel(null)).toBeNull()
  })

  it('提示词长度有上限', () => {
    const long = 'x'.repeat(9000)
    expect(composePrompt('home-sofa', long).length).toBeLessThanOrEqual(6000)
  })
})
