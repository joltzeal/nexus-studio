import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GenerateDialog } from './GenerateDialog'
import { HistoryFilters } from './HistoryFilters'
import { PhotoMetadataEditor } from './PhotoMetadataEditor'
import { FullText } from './fields'
import { defaultPhotoMetadata } from '../../../raccoon/plugins/ai-image/photo-metadata'
import {
  EMPTY_SELECTIONS,
  NO_MODEL,
} from '../../../raccoon/plugins/ai-image/model-selection'
import { makeProvider } from '../../../raccoon/plugins/ai-image/scene-plan.test-data'
import type { ProviderCatalog } from '../../../raccoon/plugins/ai-image/types'

vi.mock('@proxyshard/shardx-ui-kit', () => ({
  Alert: ({ children }: { children: React.ReactNode }) => (
    <div role="alert">{children}</div>
  ),
  Button: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Modal: ({
    children,
    footer,
  }: {
    children: React.ReactNode
    footer: React.ReactNode
  }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
  Input: ({
    label,
    value,
    wrapperClassName,
  }: {
    label: string
    value?: string
    wrapperClassName?: string
  }) => (
    <div data-field={label} className={wrapperClassName}>
      {value}
    </div>
  ),
  Select: ({
    label,
    value,
    options,
  }: {
    label: string
    value: string
    options: { value: string; label: string }[]
  }) => (
    <div data-field={label} data-choice={value}>
      {options.map((option) => (
        <span key={option.value}>{option.label}</span>
      ))}
    </div>
  ),
  Textarea: ({
    label,
    value,
    error,
    hint,
  }: {
    label: string
    value: string
    error?: string
    hint?: string
  }) => (
    <div data-field={label}>
      {value}
      {error}
      {hint}
    </div>
  ),
  Switch: ({ label }: { label: string }) => <div>{label}</div>,
}))
vi.mock('./import-runtime', () => ({ trackGeneratedProduct: vi.fn() }))

function form(overrides: Partial<React.ComponentProps<typeof GenerateDialog>> = {}) {
  const catalog: ProviderCatalog = {
    items: [makeProvider()],
    storageDurable: true,
    modelConfigVersion: 2,
    transportSettingsVersion: 1,
    photoMetadataVersion: 1,
    selections: EMPTY_SELECTIONS,
  }
  return renderToStaticMarkup(
    <GenerateDialog
      catalog={catalog}
      presets={[]}
      methods={[]}
      onClose={() => undefined}
      onConfigure={() => undefined}
      onModelsChanged={async () => undefined}
      onSubmitted={() => undefined}
      {...overrides}
    />,
  )
}

describe('AI editor content preservation without browser or image rendering', () => {
  it('fills the history filter row with a growing search next to both selectors', () => {
    const markup = renderToStaticMarkup(
      <HistoryFilters
        query="商品"
        status="all"
        kind="all"
        pageShortcut={false}
        onQuery={vi.fn()}
        onStatus={vi.fn()}
        onKind={vi.fn()}
        onRefresh={vi.fn()}
      />,
    )
    expect(markup).toMatch(
      /^<div role="group" aria-label="批次筛选条件" class="[^"]*w-full[^"]*flex-nowrap/,
    )
    expect(markup).toMatch(/data-field="搜索批次" class="[^"]*flex-1/)
    expect(markup).toContain('data-field="任务状态"')
    expect(markup).toContain('data-field="批次类型"')
    expect(markup).not.toContain('max-w-')
  })
  it('retains an over-limit prompt verbatim while reporting the limit', () => {
    const prompt = `START${'KeepAllConstraints '.repeat(900)}END`
    const markup = form({ initialPrompt: prompt })
    expect(markup).toContain(prompt)
    expect(markup).toContain('原文已保留')
    expect(markup).toContain(`${prompt.length}/12000`)
  })

  it('shows complete stored prompts including content past normal editor limits', () => {
    const prompt = `first\n${'all scene and view rules\n'.repeat(3000)}last`
    expect(
      renderToStaticMarkup(<FullText label="实际完整提示词" text={prompt} />),
    ).toContain(prompt)
  })

  it('keeps overflow reference selections visible for explicit removal', () => {
    const markup = form({
      initialImages: Array.from({ length: 8 }, (_, index) => ({
        name: `reference-${index + 1}`,
        url: `https://example.test/${index + 1}.jpg`,
      })),
    })
    expect(markup).toContain('8/6')
    expect(markup).toContain('reference-8')
    expect(markup).toContain('超过六张上限')
  })

  it('does not silently choose the first provider when no model selection was saved', () => {
    const markup = form()
    expect(markup).toContain(`data-choice="${NO_MODEL}"`)
    expect(markup).toContain('请选择生图服务商 / 模型')
  })

  it('exposes every editable EXIF field without reducing the template', () => {
    const markup = renderToStaticMarkup(
      <PhotoMetadataEditor
        enabled
        form={defaultPhotoMetadata()}
        disabled={false}
        onEnabled={() => undefined}
        onChange={() => undefined}
      />,
    )
    for (const label of [
      '制造商',
      '相机型号',
      '镜头型号',
      '拍摄时间',
      '修改时间',
      '光圈',
      '曝光补偿',
      '曝光时间',
      '焦距',
      '水平分辨率',
      '垂直分辨率',
      '软件版本',
      '曝光模式',
      '曝光程序',
      '测光模式',
      '闪光灯',
      '白平衡',
      '分辨率单位',
    ])
      expect(markup).toContain(`data-field="${label}"`)
    expect(markup).toContain('方向固定为左上')
  })
})
