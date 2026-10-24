import { describe, expect, it } from 'vitest'
import { filterPresets, FIRST_REFERENCE, selectedVisionFile } from './selection'
import type { ScenePreset } from './types'

describe('识图图片选择', () => {
  const ready = [
    {
      key: 'upload-one',
      state: 'ready' as const,
      file: { id: 'one', name: 'one', mime: 'image/png', bytes: 1 },
    },
    {
      key: 'upload-two',
      state: 'ready' as const,
      file: { id: 'two', name: 'two', mime: 'image/png', bytes: 2 },
    },
  ]
  it('第一张与明确选择分别解析为实际文件 ID', () => {
    expect(selectedVisionFile(ready, FIRST_REFERENCE)).toBe('one')
    expect(selectedVisionFile(ready, 'upload-two')).toBe('two')
    expect(selectedVisionFile([...ready].reverse(), 'upload-two')).toBe('two')
  })
  it('移除或上传失败不会静默改用其他图片', () => {
    expect(() => selectedVisionFile([], FIRST_REFERENCE)).toThrow(
      '请添加一张参考图片用于识图',
    )
    expect(() => selectedVisionFile([], 'upload-two')).toThrow('已移除')
    expect(() => selectedVisionFile(ready.slice(0, 1), 'upload-two')).toThrow('已移除')
    expect(() =>
      selectedVisionFile(
        [{ key: 'failed', state: 'failed', file: null }, ...ready],
        FIRST_REFERENCE,
      ),
    ).toThrow('尚未上传成功')
  })
})

describe('场景筛选', () => {
  const presets: ScenePreset[] = [
    {
      id: 'desk',
      label: '木质书桌',
      category: '书桌餐桌',
      hint: '窗边',
      prompt: 'A wooden desk with daylight',
    },
    {
      id: 'garden',
      label: '庭院桌面',
      category: '庭院阳台',
      hint: '阴天',
      prompt: 'An outdoor table with daylight',
    },
  ]
  it('支持中文、英文、多关键词和分类组合', () => {
    expect(filterPresets(presets, '木质', '')).toEqual([presets[0]])
    expect(filterPresets(presets, 'DESK daylight', '书桌餐桌')).toEqual([presets[0]])
    expect(filterPresets(presets, 'daylight', '庭院阳台')).toEqual([presets[1]])
    expect(filterPresets(presets, 'no-match', '')).toEqual([])
    expect(filterPresets(presets, '', '')).toEqual(presets)
  })
})
