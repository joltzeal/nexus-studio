import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { callPlugin } from '@/lib/platform/native-plugins'
import { getRecord, listRecords } from './api'
import { RecordImage } from './record-image'
import { makeSceneRecord } from './scene-plan.test-data'
import {
  recordTitle,
  sceneProgress,
  statusText,
  type GenerationRecord,
  type GenerationSummary,
  type RecordPage,
} from './types'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

function makeSummary(): GenerationSummary {
  return {
    id: 'record',
    createdAt: '2026-10-25T01:00:00.000Z',
    updatedAt: '2026-10-25T01:00:02.000Z',
    status: 'failed',
    stage: 'done',
    mode: 'edit',
    prompt: 'Preserve the worn corners.',
    presetId: 'wall-hang',
    presetLabel: '挂墙陈列',
    size: 'auto',
    count: 3,
    providerId: 'image-provider',
    providerName: 'Image provider',
    providerKind: 'openai_compatible',
    imageModel: 'image-model',
    title: null,
    durationMs: 3000,
    outputs: [
      { id: 'detail-output', mime: 'image/png' },
      { id: 'room-output', mime: 'image/png' },
    ],
    scenePlan: {
      views: [
        { status: 'failed', outputFileId: null },
        { status: 'success', outputFileId: 'room-output' },
        { status: 'success', outputFileId: 'detail-output' },
      ],
    },
  }
}

function pageWith(items: GenerationSummary[]): RecordPage {
  return { items, total: items.length, page: 0, pageSize: 10, storageDurable: true }
}

beforeEach(() => {
  vi.mocked(callPlugin).mockReset()
})

describe('generation summaries', () => {
  it('renders progress and titles from only the small display fields', () => {
    expect(
      statusText({
        status: 'failed',
        stage: 'done',
        scenePlan: {
          views: [
            { status: 'success', outputFileId: 'output' },
            { status: 'failed', outputFileId: null },
            { status: 'queued', outputFileId: null },
          ],
        },
      }),
    ).toBe('部分完成 · 1/3')
    expect(recordTitle({ title: '', presetLabel: '挂墙陈列', mode: 'edit' })).toBe(
      '挂墙陈列',
    )
    expect(recordTitle({ title: null, presetLabel: null, mode: 'edit' })).toBe('改图')
    expect(recordTitle({ title: '商品标题', presetLabel: null, mode: 'generate' })).toBe(
      '商品标题',
    )
  })

  it('shows the same partial progress for a summary and its full record without a plan snapshot or view prompts', () => {
    const full = makeSceneRecord()
    const summary = makeSummary()
    expect(summary.scenePlan).not.toHaveProperty('plan')
    expect(summary.scenePlan).not.toHaveProperty('prompt')
    expect(summary.scenePlan?.views[0]).not.toHaveProperty('effectivePrompt')
    expect(summary.scenePlan?.views[0]).not.toHaveProperty('prompt')
    expect(summary.scenePlan?.views[0]).not.toHaveProperty('id')
    expect(summary.scenePlan?.views[0]).not.toHaveProperty('label')
    expect(summary.scenePlan?.views[0]).not.toHaveProperty('error')
    for (const key of [
      'inputs',
      'description',
      'textModel',
      'error',
      'copyError',
      'copySupportsVision',
    ]) {
      expect(summary).not.toHaveProperty(key)
    }
    expect(sceneProgress(summary)).toEqual({ completed: 2, total: 3 })
    expect(statusText(summary)).toBe(statusText(full))
    expect(recordTitle(summary)).toBe(recordTitle(full))
    expect(summary.outputs).toEqual(full.outputs.map(({ id, mime }) => ({ id, mime })))
  })

  it('accepts status-only output recognition and legacy vision stages without observation payloads', () => {
    const summary = makeSummary()
    expect(statusText({ ...summary, outputVision: { status: 'running' } })).toBe(
      '正在识别成片',
    )
    expect(statusText({ ...summary, outputVision: null })).toBe('部分完成 · 2/3')
    expect(statusText({ status: 'running', stage: 'vision' })).toBe('正在识别参考图')
    expect(statusText({ status: 'running', stage: 'copy' })).toBe('正在写文案')
    expect(statusText({ status: 'success', stage: 'done' })).toBe('已生成')
    expect(sceneProgress({})).toBeNull()
  })

  it('accepts thumbnail descriptors with only an ID and MIME while preserving full-file compatibility', () => {
    const image = makeSummary().outputs[0]
    if (!image) throw new Error('Missing thumbnail fixture')
    expect(Object.keys(image).sort()).toEqual(['id', 'mime'])
    const html = renderToStaticMarkup(
      createElement(RecordImage, { file: image, alt: '商品图片' }),
    )
    expect(html).toContain('正在读取图片')
    const fullFile = makeSceneRecord().outputs[0]
    if (!fullFile) throw new Error('Missing full output fixture')
    expect(
      renderToStaticMarkup(
        createElement(RecordImage, { file: fullFile, alt: '完整记录图片' }),
      ),
    ).toContain('正在读取图片')
    expect(callPlugin).not.toHaveBeenCalled()
  })

  it('keeps older full list records structurally compatible', async () => {
    const full = makeSceneRecord()
    const compatible: GenerationSummary = full
    const page: RecordPage = pageWith([compatible])
    vi.mocked(callPlugin).mockResolvedValue({ ...page, items: [full] })
    const result = await listRecords(0, 10)
    expect(result.items[0]).toEqual(full)
    expect(statusText(compatible)).toBe('部分完成 · 2/3')
    expect(recordTitle(compatible)).toBe(recordTitle(full))
    expect(callPlugin).toHaveBeenCalledTimes(1)
  })

  it('reads source-linked summaries and then fetches the full detail by ID', async () => {
    const promptPreview = '画'.repeat(160) + '\n'.repeat(10)
    const sourceTitlePreview = '物'.repeat(36) + '\n'.repeat(6)
    const full: GenerationRecord = {
      ...makeSceneRecord(),
      prompt: promptPreview + 'Preserve all original constraints. '.repeat(400),
      basePrompt: 'Full original prompt',
      source: {
        pluginId: 'studio.vinted-monitor',
        itemId: 'vinted.fr:123',
        title: sourceTitlePreview + 'Full original source title',
        url: 'https://www.vinted.fr/items/123',
      },
      vision: {
        providerId: 'vision-provider',
        providerName: 'Vision provider',
        providerKind: 'openai_compatible',
        model: 'vision-model',
        inputFileId: 'reference',
        description: 'Full source observations',
      },
    }
    const summary: GenerationSummary = {
      ...makeSummary(),
      prompt: promptPreview,
      source: {
        pluginId: 'studio.vinted-monitor',
        itemId: 'vinted.fr:123',
        title: sourceTitlePreview,
        url: 'https://www.vinted.fr/items/123',
      },
    }
    const identity = { pluginId: 'studio.vinted-monitor', itemId: 'vinted.fr:123' }
    const sourceFilter = {
      sourcePluginId: identity.pluginId,
      sourceItemId: identity.itemId,
    }
    vi.mocked(callPlugin)
      .mockResolvedValueOnce({ ...pageWith([summary]), sourceFilter })
      .mockResolvedValueOnce({ record: full })
    const listed = await listRecords(0, 10, undefined, identity)
    const item = listed.items[0]
    if (!item) throw new Error('Missing summary fixture')
    expect(item.prompt).toBe(promptPreview)
    expect(item.prompt.length).toBeLessThan(500)
    expect(new TextEncoder().encode(JSON.stringify(item.prompt)).byteLength - 2).toBe(500)
    expect(
      new TextEncoder().encode(JSON.stringify(item.source?.title)).byteLength - 2,
    ).toBe(120)
    expect(item).not.toHaveProperty('vision')
    expect(item).not.toHaveProperty('basePrompt')
    expect(item.source).toEqual({ ...full.source, title: sourceTitlePreview })
    expect(statusText(item)).toBe('部分完成 · 2/3')
    const detail = await getRecord(item.id)
    expect(detail.record.prompt).toBe(full.prompt)
    expect(detail.record.basePrompt).toBe(full.basePrompt)
    expect(detail.record.source).toEqual(full.source)
    expect(detail.record.vision).toEqual(full.vision)
    expect(detail.record.scenePlan?.plan.result).toEqual(full.scenePlan?.plan.result)
    expect(detail.record.scenePlan?.views[0]?.effectivePrompt).toBe(
      full.scenePlan?.views[0]?.effectivePrompt,
    )
    expect(vi.mocked(callPlugin).mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ['image.records.list', { page: 0, size: 10, ...sourceFilter }],
      ['image.records.get', { id: full.id }],
    ])
  })
})
