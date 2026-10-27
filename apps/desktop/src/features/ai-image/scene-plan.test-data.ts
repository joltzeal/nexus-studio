import type { ScenePlanContext } from './scene-plan'
import type { GenerationRecord, Provider, ScenePlan, StoredFile } from './types'

export const planContext: ScenePlanContext = {
  providerId: 'vision-provider',
  model: 'vision-model',
  providerKey: 'vision-provider-configuration',
  inputFileId: 'reference',
  requirements: '  Preserve the worn corners.\nDo not add a frame.  ',
  count: 3,
}

export function makePlan(overrides: Partial<ScenePlan> = {}): ScenePlan {
  return {
    id: 'scene-plan',
    createdAt: '2026-10-25T01:00:00.000Z',
    updatedAt: '2026-10-25T01:00:02.000Z',
    status: 'success',
    providerId: planContext.providerId,
    providerName: 'Vision provider',
    providerKind: 'openai_compatible',
    model: 'vision-model',
    inputFileId: planContext.inputFileId,
    requirements: planContext.requirements,
    count: planContext.count,
    result: {
      title: 'Vintage wall art',
      description: 'Used wall art with visible corner wear.',
      product: '墙面装饰画',
      material: '可能为金属或帆布',
      observations: '可见印刷图案与边角磨损',
      uncertainties: '仅凭照片无法确认材质和背面',
      presetId: 'wall-hang',
      reason: '适合挂墙陈列，保持商品用途',
      prompt: 'Show the original item in a lived-in home with soft daylight.',
      views: [
        { id: 'front', label: '正面', prompt: 'Front view of the visible face.' },
        { id: 'room', label: '环境', prompt: 'A wider crop including a sofa.' },
        {
          id: 'detail',
          label: '细节',
          prompt: 'Close crop of the evidenced worn corner.',
        },
      ],
    },
    error: null,
    ...overrides,
  }
}

export function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: planContext.providerId,
    name: 'Vision provider',
    kind: 'openai_compatible',
    baseUrl: 'https://models.example.invalid/v1',
    imageModel: 'image-model',
    visionModel: 'vision-model',
    imageTimeoutSeconds: 900,
    imageResponseMode: 'auto',
    hasApiKey: true,
    apiKeyHint: 'test',
    createdAt: '2026-10-25T01:00:00.000Z',
    updatedAt: '2026-10-25T01:00:00.000Z',
    ...overrides,
  }
}

function file(id: string): StoredFile {
  return { id, name: `${id}.png`, mime: 'image/png', bytes: 100 }
}

export function makeSceneRecord(): GenerationRecord {
  const plan = makePlan()
  return {
    id: 'record',
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    status: 'failed',
    stage: 'done',
    mode: 'edit',
    prompt: plan.requirements,
    presetId: plan.result?.presetId ?? null,
    presetLabel: '挂墙陈列',
    size: 'auto',
    count: plan.count,
    providerId: 'image-provider',
    providerName: 'Image provider',
    providerKind: 'openai_compatible',
    imageModel: 'image-model',
    textModel: '',
    inputs: [file('other-reference'), file(plan.inputFileId)],
    outputs: [file('detail-output'), file('room-output')],
    scenePlan: {
      plan,
      prompt: 'Edited shared scene.',
      views: (plan.result?.views ?? []).map((view, index) => ({
        ...view,
        status: index === 0 ? 'failed' : 'success',
        outputFileId: index === 0 ? null : `${view.id}-output`,
        error: index === 0 ? 'Upstream rejected the front view.' : null,
        effectivePrompt: `Preserve the original product.\n${view.prompt}`,
      })),
    },
    title: null,
    description: null,
    error: 'One view failed.',
    copyError: null,
    durationMs: 3000,
  }
}
