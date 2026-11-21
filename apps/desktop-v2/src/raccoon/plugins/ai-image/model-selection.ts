import type { ModelSelection, ModelSelections, Provider, ProviderCatalog } from './types'

export const MODEL_CONFIG_UPDATE_HINT = '请先更新 AI 生图插件，再配置识图与生图模型。'
export const NO_MODEL = '__unselected__'
export const EMPTY_SELECTIONS: ModelSelections = { image: null, vision: null }
export type ModelRole = keyof ModelSelections

function parseSelection(value: unknown): ModelSelection | null {
  if (!value || typeof value !== 'object') return null
  const pair = value as Partial<ModelSelection>
  return typeof pair.providerId === 'string' &&
    pair.providerId.trim() !== '' &&
    typeof pair.model === 'string' &&
    pair.model.trim() !== ''
    ? { providerId: pair.providerId, model: pair.model }
    : null
}

export function providerCatalog(
  value: Omit<ProviderCatalog, 'modelConfigVersion' | 'selections'> & {
    modelConfigVersion?: number
    selections?: unknown
  },
): ProviderCatalog {
  const saved = value.selections as Partial<ModelSelections> | null | undefined
  return {
    items: value.items,
    storageDurable: value.storageDurable,
    modelConfigVersion: value.modelConfigVersion ?? 1,
    selections: {
      image: parseSelection(saved?.image),
      vision: parseSelection(saved?.vision),
    },
  }
}

export function modelValue(selection: ModelSelection | null): string {
  return selection ? JSON.stringify([selection.providerId, selection.model]) : NO_MODEL
}

export function modelPair(value: string): ModelSelection | null {
  try {
    const pair: unknown = JSON.parse(value)
    return Array.isArray(pair) && pair.length === 2
      ? parseSelection({ providerId: pair[0], model: pair[1] })
      : null
  } catch {
    return null
  }
}

export function providerModel(provider: Provider, role: ModelRole): string {
  return role === 'image' ? provider.imageModel : (provider.visionModel ?? '')
}

export function resolveModel(
  providers: Provider[],
  role: ModelRole,
  value: string,
): (ModelSelection & { provider: Provider }) | null {
  const pair = modelPair(value)
  if (!pair) return null
  const provider = providers.find(
    (entry) =>
      entry.id === pair.providerId &&
      entry.hasApiKey &&
      providerModel(entry, role) === pair.model,
  )
  return provider ? { ...pair, provider } : null
}

export function modelOptions(providers: Provider[], role: ModelRole, value: string) {
  const options = providers
    .filter((provider) => provider.hasApiKey && providerModel(provider, role).trim())
    .map((provider) => {
      const model = providerModel(provider, role)
      return {
        value: modelValue({ providerId: provider.id, model }),
        label: `${provider.name} · ${model}`,
      }
    })
  return [
    {
      value: NO_MODEL,
      label: `请选择${role === 'image' ? '生图' : '识图'}服务商 / 模型`,
    },
    ...options,
    ...(value !== NO_MODEL && !options.some((option) => option.value === value)
      ? [{ value, label: '上次选择已失效，请重新选择' }]
      : []),
  ]
}
