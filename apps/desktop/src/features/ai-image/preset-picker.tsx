import { useState } from 'react'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { filterPresets } from './selection'
import type { ScenePreset } from './types'

export function PresetPicker({
  presets,
  value,
  disabled,
  onChange,
}: {
  presets: ScenePreset[]
  value: string | null
  disabled: boolean
  onChange: (id: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const categories = [...new Set(presets.map((preset) => preset.category ?? '其他场景'))]
  const filtered = filterPresets(presets, query, category)
  const selected = presets.find((preset) => preset.id === value)

  return (
    <FieldGroup>
      <FieldGroup className="sm:flex-row">
        <Field>
          <FieldLabel htmlFor="ai-preset-search">搜索场景</FieldLabel>
          <Input
            id="ai-preset-search"
            type="search"
            placeholder="中文名称、用途或英文关键词"
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="ai-preset-category">场景分类</FieldLabel>
          <Select
            value={category || '__all__'}
            disabled={disabled}
            onValueChange={(next) => setCategory(next === '__all__' ? '' : next)}
          >
            <SelectTrigger id="ai-preset-category" className="w-full">
              <SelectValue>{category || '全部分类'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="__all__">全部分类</SelectItem>
                {categories.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
      <Field>
        <FieldLabel htmlFor="ai-preset">场景预设</FieldLabel>
        <Select
          value={value ?? '__free__'}
          disabled={disabled}
          onValueChange={(next) => onChange(next === '__free__' ? null : next)}
        >
          <SelectTrigger id="ai-preset" className="w-full">
            <SelectValue>
              {value === null ? '自由提示词' : (selected?.label ?? '请选择场景')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectGroup>
              <SelectItem value="__free__">自由提示词</SelectItem>
            </SelectGroup>
            {categories.map((entry) => {
              const items = filtered.filter(
                (preset) => (preset.category ?? '其他场景') === entry,
              )
              return items.length === 0 ? null : (
                <SelectGroup key={entry}>
                  <SelectLabel>{entry}</SelectLabel>
                  {items.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label} · {preset.hint}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )
            })}
          </SelectContent>
        </Select>
        <FieldDescription aria-live="polite">
          匹配 {filtered.length} / {presets.length} 个场景。
          {filtered.length === 0 ? '可清空搜索或更换分类。' : ''}
          {selected ? ` 已选：${selected.label} · ${selected.hint}。` : ''}
          筛选不会修改已选场景。
        </FieldDescription>
      </Field>
      {selected ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">查看英文场景提示词</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{selected.prompt}</p>
        </details>
      ) : null}
    </FieldGroup>
  )
}
