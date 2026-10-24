import { describe, expect, it } from 'vitest'

import { SCENE_PRESETS, composePrompt, presetById, presetLabel } from './presets.js'
import { GenerateInputSchema } from './schemas.js'

describe('场景预设', () => {
  it('每个预设都有唯一 id 与可发送的提示词', () => {
    expect(SCENE_PRESETS).toHaveLength(100)
    expect(new Set(SCENE_PRESETS.map((preset) => preset.label)).size).toBe(100)
    expect(new Set(SCENE_PRESETS.map((preset) => preset.prompt)).size).toBe(100)
    const categories = new Set(SCENE_PRESETS.map((preset) => preset.category))
    expect(categories.size).toBe(10)
    for (const category of categories) {
      expect(SCENE_PRESETS.filter((preset) => preset.category === category)).toHaveLength(
        10,
      )
    }
    const ids = new Set<string>()
    for (const preset of SCENE_PRESETS) {
      expect(preset.id).not.toBe('')
      expect(preset.label).not.toBe('')
      expect(preset.hint).not.toBe('')
      expect(preset.prompt.length).toBeGreaterThan(400)
      expect(preset.prompt).toContain('secondhand listing')
      expect(preset.prompt).toContain('No glamorous styling')
      expect(composePrompt(preset.id, '')).toContain('every visible scratch, stain')
      expect(ids.has(preset.id)).toBe(false)
      ids.add(preset.id)
    }
  })

  it('组合提示词会带上商品重建说明与附加要求', () => {
    const prompt = composePrompt('white-studio', '背景再暖一点')
    expect(prompt).toContain('Preserve the actual secondhand condition')
    expect(prompt).toContain('white laminate table')
    expect(prompt).toContain('Additional requirements: 背景再暖一点')
  })

  it('自由提示词原样发送，不附加预设说明', () => {
    expect(composePrompt(null, '  a calm still life\n  ')).toBe('  a calm still life\n  ')
  })

  it('未知预设明确拒绝，不静默忽略场景', () => {
    expect(() => composePrompt('does-not-exist', 'only this')).toThrow('场景预设不存在')
    expect(presetById('does-not-exist')).toBeNull()
    expect(presetLabel('does-not-exist')).toBeNull()
    expect(presetLabel(null)).toBeNull()
  })

  it('全部旧 ID 保留，棚拍旧 ID 改为日常场景', () => {
    for (const id of [
      'white-studio',
      'grey-studio',
      'home-sofa',
      'bedroom-bed',
      'wood-desk',
      'kitchen-counter',
      'wall-hang',
      'store-shelf',
      'outdoor-daylight',
      'hand-hold',
    ]) {
      expect(presetById(id)).not.toBeNull()
    }
    expect(presetLabel('white-studio')).toBe('白墙小桌')
    expect(presetLabel('grey-studio')).toBe('灰墙边柜')
  })

  it('较长附加要求完整保留，超过输入上限时拒绝而非截断', () => {
    const long = `${'x'.repeat(11970)} KEEP ALL DEFECTS AT THE END`
    expect(composePrompt('home-sofa', long)).toContain(long)
    const request = {
      providerId: 'p',
      mode: 'generate',
      presetId: null,
      prompt: 'x'.repeat(12000),
      size: 'auto',
      count: 1,
      inputFileIds: [],
    }
    expect(GenerateInputSchema.parse(request).prompt).toBe(request.prompt)
    expect(
      GenerateInputSchema.safeParse({ ...request, prompt: `${request.prompt}x` }).success,
    ).toBe(false)
  })
})
