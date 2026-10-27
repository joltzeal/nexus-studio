import type { GenerationRecord, GenerationSummary } from './types.js'

/** Count escaped JSON bytes too, and never split a Unicode code point. */
function preview(value: string, maxBytes: number): string {
  let bytes = 0
  let result = ''
  for (const character of value) {
    const next = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2
    if (bytes + next > maxBytes) break
    result += character
    bytes += next
  }
  return result
}

/**
 * Whitelist every level: legacy documents preserve unknown fields, which may
 * contain large blobs that must never be copied into a list response.
 * Only previews are shortened; identifiers, source URLs and stored data are exact.
 */
export function generationSummary(record: GenerationRecord): GenerationSummary {
  return {
    id: record.id,
    ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    stage: record.stage,
    mode: record.mode,
    prompt: preview(record.prompt, 500),
    presetId: record.presetId,
    presetLabel: record.presetLabel,
    size: record.size,
    count: record.count,
    providerId: record.providerId,
    providerName: record.providerName,
    providerKind: record.providerKind,
    imageModel: record.imageModel,
    title: record.title,
    durationMs: record.durationMs,
    outputs: record.outputs.map((file) => ({ id: file.id, mime: file.mime })),
    ...(record.source === undefined
      ? {}
      : {
          source: {
            pluginId: record.source.pluginId,
            itemId: record.source.itemId,
            title: preview(record.source.title, 120),
            url: record.source.url,
          },
        }),
    ...(record.scenePlan === undefined
      ? {}
      : {
          scenePlan: {
            views: record.scenePlan.views.map((view) => ({
              status: view.status,
              outputFileId: view.outputFileId,
            })),
          },
        }),
    ...(record.outputVision === undefined
      ? {}
      : {
          outputVision:
            record.outputVision === null ? null : { status: record.outputVision.status },
        }),
  }
}
