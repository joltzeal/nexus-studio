import type { RecordsListInput } from './schemas.js'
import type { GenerationRecord } from './types.js'

function kind(record: GenerationRecord): NonNullable<RecordsListInput['kind']> {
  if (record.purpose === 'provider-test') return 'provider-test'
  if (record.scenePlan !== undefined) return 'scene'
  return record.count > 1 ? 'batch' : 'single'
}

function normalized(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase()
}

/** A record is the durable submission parent; views never become history rows. */
export function matchesRecordHistory(
  record: GenerationRecord,
  input: RecordsListInput,
): boolean {
  if (input.status !== undefined && record.status !== input.status) return false
  if (
    input.sourcePluginId !== undefined &&
    (record.source?.pluginId !== input.sourcePluginId ||
      record.source.itemId !== input.sourceItemId)
  )
    return false
  if (input.kind !== undefined && kind(record) !== input.kind) return false
  if (
    input.activity !== undefined &&
    (record.status !== 'running' ||
      (record.stage === 'queued') !== (input.activity === 'queued'))
  )
    return false
  const query = normalized(input.query ?? '')
    .split(/\s+/)
    .filter(Boolean)
  if (query.length === 0) return true
  const scene = record.scenePlan
  const text = normalized(
    [
      record.id,
      record.title,
      record.prompt,
      record.basePrompt,
      record.presetId,
      record.presetLabel,
      record.providerName,
      record.imageModel,
      record.source?.title,
      record.source?.pluginId,
      record.source?.itemId,
      record.source?.url,
      scene?.plan.id,
      scene?.plan.requirements,
      scene?.plan.result?.product,
      scene?.prompt,
      ...(scene?.views.flatMap((view) => [
        view.id,
        view.label,
        view.prompt,
        view.effectivePrompt,
      ]) ?? []),
    ]
      .filter((value) => value != null)
      .join('\n'),
  )
  return query.every((term) => text.includes(term))
}
