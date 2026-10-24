import type { GenerationRecord, ScenePreset, StoredFile } from './types'

export const MAX_PROMPT_CHARACTERS = 12000
export const FIRST_REFERENCE = '__first__'

export interface ReferenceSelection {
  key: string
  state: 'uploading' | 'ready' | 'failed'
  file: StoredFile | null
}

/** Resolve stable upload keys, never a shifting array index or a failed upload. */
export function selectedVisionFile(
  references: readonly ReferenceSelection[],
  choice: string,
): string {
  if (references.length === 0 && choice === FIRST_REFERENCE) {
    throw new Error('请添加一张参考图片用于识图。')
  }
  const selected =
    choice === FIRST_REFERENCE
      ? references[0]
      : references.find((reference) => reference.key === choice)
  if (selected === undefined) throw new Error('已选识图图片已移除，请重新选择。')
  if (selected.state !== 'ready' || selected.file === null) {
    throw new Error('已选识图图片尚未上传成功，请等待或重新选择。')
  }
  return selected.file.id
}

export function selectedRecordMedia(
  record: GenerationRecord | null,
  selected: number,
  selectedViewId: string,
) {
  const selectedView =
    record?.scenePlan?.views.find((view) => view.id === selectedViewId) ??
    record?.scenePlan?.views[0]
  // Failed views leave gaps: output positions cannot identify their planned view.
  const output = record?.scenePlan
    ? (record.outputs.find((file) => file.id === selectedView?.outputFileId) ?? null)
    : (record?.outputs[selected] ?? null)
  const outputIndex = output
    ? (record?.outputs.findIndex((file) => file.id === output.id) ?? -1)
    : -1
  const referenceId = record?.scenePlan?.plan.inputFileId ?? record?.vision?.inputFileId
  const reference = referenceId
    ? (record?.inputs.find((file) => file.id === referenceId) ?? null)
    : (record?.inputs[0] ?? null)
  return { selectedView, output, outputIndex, reference, referenceId }
}

export function filterPresets(
  presets: readonly ScenePreset[],
  query: string,
  category: string,
): ScenePreset[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return presets.filter((preset) => {
    if (category !== '' && (preset.category ?? '其他场景') !== category) return false
    const searchable = [
      preset.label,
      preset.hint,
      preset.category ?? '',
      preset.id,
      preset.prompt,
    ]
      .join(' ')
      .toLocaleLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
}
