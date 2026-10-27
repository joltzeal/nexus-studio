import type { ComponentProps, DependencyList, EffectCallback, MouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { toast } from '@/components/ui/toast'
import {
  components,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { generate, uploadImage, uploadRemoteImage } from './api'
import { GenerateDialog } from './generate-dialog'
import {
  EMPTY_SELECTIONS,
  MODEL_CONFIG_UPDATE_HINT,
  NO_MODEL,
  modelValue,
  type ModelRole,
} from './model-selection'
import { transferInitialImage } from './reference-transfer'
import { SCENE_PLAN_METHODS, supportsScenePlans } from './scene-plan'
import { makeProvider, makeSceneRecord } from './scene-plan.test-data'
import type { ModelSelection, ModelSelections, StoredFile } from './types'
import { useScenePlanner } from './use-scene-planner'

const state = vi.hoisted(() => ({ hooks: null as GenerateHookHarness | null }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useRef: (initial: unknown) =>
      state.hooks
        ? state.hooks.state(() => ({ current: initial }))[0]
        : react.useRef(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
    useMemo: <T>(factory: () => T, deps: DependencyList) =>
      state.hooks ? state.hooks.memo(factory, deps) : react.useMemo(factory, deps),
    useCallback: <T extends (...args: never[]) => unknown>(
      callback: T,
      deps: DependencyList,
    ) =>
      state.hooks
        ? state.hooks.memo(() => callback, deps)
        : react.useCallback(callback, deps),
  }
})
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  generate: vi.fn(),
  uploadImage: vi.fn(),
  uploadRemoteImage: vi.fn(),
}))
vi.mock('./reference-transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reference-transfer')>()),
  transferInitialImage: vi.fn(),
}))
vi.mock('./use-scene-planner', () => ({ useScenePlanner: vi.fn() }))
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn() } }))

class GenerateHookHarness extends KernelHookHarness {
  // Stable callbacks keep ordinary rerenders from restarting reference transfers.
  memo<T>(factory: () => T, deps: DependencyList): T {
    const [cached, setCached] = this.state(undefined)
    const previous = cached as { value: T; deps: DependencyList } | undefined
    if (
      previous &&
      previous.deps.length === deps.length &&
      deps.every((dep, index) => Object.is(dep, previous.deps[index]))
    ) {
      return previous.value
    }
    const value = factory()
    setCached({ value, deps })
    return value
  }
}

const imagePair: ModelSelection = { providerId: 'image-provider', model: 'image-v1' }
const visionPair: ModelSelection = { providerId: 'vision-provider', model: 'vision-v1' }
const remembered: ModelSelections = { image: imagePair, vision: visionPair }
const alternative: ModelSelections = {
  image: { providerId: 'other-provider', model: 'other-image-v1' },
  vision: { providerId: 'other-provider', model: 'other-vision-v1' },
}
const reference = {
  url: 'https://images.example.invalid/reference.png',
  name: 'reference.png',
}
const stored: StoredFile = {
  id: 'reference-1',
  name: reference.name,
  mime: 'image/png',
  bytes: 100,
}
const prompt = 'Keep the visible wear and original product shape.'

let hooks: GenerateHookHarness
let props: ComponentProps<typeof GenerateDialog>
let planner: ReturnType<typeof useScenePlanner>
const render = () => hooks.render(() => GenerateDialog(props))
const select = (id: string) =>
  components(render(), LabeledSelect).find((node) => node.props.id === id)!.props
const modelSelect = (role: ModelRole) =>
  select(role === 'image' ? 'ai-provider' : 'ai-vision-provider')
const choose = (role: ModelRole, pair: ModelSelection | null) =>
  modelSelect(role).onValueChange(modelValue(pair))
const button = (label: string) =>
  components(render(), Button).find((node) => text(node.props.children) === label)!.props

async function settle() {
  render()
  hooks.flushEffects()
  await flushPromises()
}

async function submit() {
  // Invoke even disabled controls to also check the handler's validation boundary.
  button('开始生成').onClick?.({} as MouseEvent<HTMLButtonElement>)
  await flushPromises()
}

function expectNoGeneration() {
  expect(generate).not.toHaveBeenCalled()
  expect(props.onSubmitted).not.toHaveBeenCalled()
  expect(props.onOpenChange).not.toHaveBeenCalled()
  expect(toast.success).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new GenerateHookHarness(state)
  props = {
    providers: [
      makeProvider({
        id: 'image-provider',
        name: 'Image provider',
        imageModel: 'image-v1',
        visionModel: '',
      }),
      makeProvider({
        id: 'vision-provider',
        name: 'Vision provider',
        imageModel: '',
        visionModel: 'vision-v1',
      }),
      makeProvider({
        id: 'other-provider',
        name: 'Other provider',
        imageModel: 'other-image-v1',
        visionModel: 'other-vision-v1',
      }),
    ],
    selections: { ...EMPTY_SELECTIONS },
    modelConfigReady: true,
    presets: [],
    initialPrompt: prompt,
    pluginMethods: SCENE_PLAN_METHODS,
    onOpenChange: vi.fn(),
    onSubmitted: vi.fn().mockResolvedValue(undefined),
    onConfigure: vi.fn(),
    onModelsChanged: vi.fn().mockResolvedValue(undefined),
  }
  planner = {
    smart: false,
    draft: null,
    setDraft: vi.fn(),
    current: null,
    pending: false,
    supported: true,
    ready: false,
    problem: null,
    stale: false,
    start: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn(),
    useExisting: vi.fn(),
    manual: vi.fn(),
    cancel: vi.fn(),
  }
  vi.mocked(useScenePlanner).mockImplementation((_context, methods) => ({
    ...planner,
    supported: supportsScenePlans(methods),
  }))
  vi.mocked(transferInitialImage).mockResolvedValue(stored)
  vi.mocked(generate).mockResolvedValue({ record: makeSceneRecord() })
})
afterEach(() => hooks.dispose())

describe('generation model selection', () => {
  it('does not select the first provider on mount or list reorder', async () => {
    await settle()
    expect(modelSelect('image').value).toBe(NO_MODEL)
    expect(modelSelect('vision').value).toBe(NO_MODEL)
    props.providers = [...props.providers].reverse()
    await settle()
    expect(modelSelect('image').value).toBe(NO_MODEL)
    expect(modelSelect('vision').value).toBe(NO_MODEL)
    expect(button('开始生成').disabled).toBe(true)

    await submit()

    expectNoGeneration()
    expect(text(components(render(), FieldError)[0]!.props.children)).toContain('生图')
    expect(transferInitialImage).not.toHaveBeenCalled()
  })

  it('fills untouched roles from late preferences without generating', async () => {
    const providers = props.providers
    props.providers = []
    props.initialImages = [reference]
    await settle()
    props.providers = providers
    await settle()
    expect(modelSelect('image').value).toBe(NO_MODEL)
    expect(modelSelect('vision').value).toBe(NO_MODEL)

    props.selections = remembered
    await settle()
    expect(modelSelect('image').value).toBe(modelValue(imagePair))
    expect(modelSelect('vision').value).toBe(modelValue(visionPair))
    expect(button('开始生成').disabled).toBe(false)

    props.selections = alternative
    await settle()
    expect(modelSelect('image').value).toBe(modelValue(alternative.image))
    expect(modelSelect('vision').value).toBe(modelValue(alternative.vision))
    expect(transferInitialImage).toHaveBeenCalledTimes(1)
    expectNoGeneration()
  })

  it.each(['image', 'vision'] as const)(
    'keeps an explicit %s choice while the untouched role accepts late preferences',
    async (role) => {
      props.initialImages = [reference]
      await settle()
      choose(role, alternative[role])
      props.selections = remembered
      await settle()
      const otherRole = role === 'image' ? 'vision' : 'image'
      expect(modelSelect(role).value).toBe(modelValue(alternative[role]))
      expect(modelSelect(otherRole).value).toBe(modelValue(remembered[otherRole]))
      expect(button('开始生成').disabled).toBe(false)

      choose(role, null)
      props.selections = alternative
      await settle()
      expect(modelSelect(role).value).toBe(NO_MODEL)
      expect(modelSelect(otherRole).value).toBe(modelValue(alternative[otherRole]))
      expect(button('开始生成').disabled).toBe(true)
      await submit()
      expectNoGeneration()
    },
  )

  it.each(['image', 'vision'] as const)(
    'freezes the explicit %s pair when its provider model changes until the user reselects',
    async (role) => {
      props.initialImages = [reference]
      props.selections = remembered
      await settle()
      choose(role, alternative[role])
      expect(button('开始生成').disabled).toBe(false)

      const changed = { providerId: 'other-provider', model: `${role}-v2` }
      props.providers = props.providers.map((provider) =>
        provider.id === 'other-provider'
          ? {
              ...provider,
              [role === 'image' ? 'imageModel' : 'visionModel']: changed.model,
            }
          : provider,
      )
      props.selections = { ...remembered, [role]: changed }
      await settle()
      expect(modelSelect(role).value).toBe(modelValue(alternative[role]))
      expect(
        modelSelect(role).options.find(
          (option) => option.value === modelValue(alternative[role]),
        )?.label,
      ).toContain('已失效')
      expect(button('开始生成').disabled).toBe(true)
      await submit()
      expectNoGeneration()

      choose(role, changed)
      expect(button('开始生成').disabled).toBe(false)
      await submit()
      expect(generate).toHaveBeenCalledExactlyOnceWith({
        providerId: role === 'image' ? 'other-provider' : 'image-provider',
        imageModel: role === 'image' ? 'image-v2' : 'image-v1',
        mode: 'edit',
        presetId: null,
        prompt,
        size: '1024x1024',
        count: 1,
        inputFileIds: ['reference-1'],
        visionProviderId: role === 'vision' ? 'other-provider' : 'vision-provider',
        visionModel: role === 'vision' ? 'vision-v2' : 'vision-v1',
        visionFileId: 'reference-1',
      })
    },
  )

  it.each(['image', 'vision'] as const)(
    'does not move a deleted %s provider selection to another provider with the same model',
    async (role) => {
      props.initialImages = [reference]
      props.selections = remembered
      await settle()
      choose(role, remembered[role])
      props.providers = props.providers
        .filter((provider) => provider.id !== remembered[role]?.providerId)
        .map((provider) =>
          provider.id === 'other-provider'
            ? {
                ...provider,
                [role === 'image' ? 'imageModel' : 'visionModel']: `${role}-v1`,
              }
            : provider,
        )
      await settle()
      expect(modelSelect(role).value).toBe(modelValue(remembered[role]))
      expect(button('开始生成').disabled).toBe(true)
      await submit()
      expectNoGeneration()
    },
  )
})

describe('generation model validation and payloads', () => {
  it.each([
    { mode: 'generate', image: false, vision: true, missing: '生图' },
    { mode: 'edit', image: false, vision: false, missing: '生图' },
    { mode: 'edit', image: false, vision: true, missing: '生图' },
    { mode: 'edit', image: true, vision: false, missing: '识图' },
  ])(
    'blocks $mode with image=$image and vision=$vision before calling generate',
    async ({ mode, image, vision, missing }) => {
      props.selections = {
        image: image ? imagePair : null,
        vision: vision ? visionPair : null,
      }
      if (mode === 'edit') props.initialImages = [reference]
      await settle()
      expect(button('开始生成').disabled).toBe(true)

      await submit()

      expectNoGeneration()
      expect(text(components(render(), FieldError)[0]!.props.children)).toContain(missing)
    },
  )

  it.each([
    { label: 'no vision selection', vision: null },
    { label: 'a valid vision selection', vision: visionPair },
    {
      label: 'a stale vision selection',
      vision: { providerId: 'vision-provider', model: 'removed-vision-model' },
    },
  ])(
    'submits text-only generation with $label using only the image pair',
    async ({ vision }) => {
      props.selections = { image: imagePair, vision }
      await settle()
      expect(button('开始生成').disabled).toBe(false)

      await submit()

      expect(generate).toHaveBeenCalledExactlyOnceWith({
        providerId: 'image-provider',
        imageModel: 'image-v1',
        mode: 'generate',
        presetId: null,
        prompt,
        size: '1024x1024',
        count: 1,
        inputFileIds: [],
      })
      expect(props.onSubmitted).toHaveBeenCalledTimes(1)
      expect(props.onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
      expect(toast.success).toHaveBeenCalledTimes(1)
      expect(transferInitialImage).not.toHaveBeenCalled()
    },
  )

  it('submits exact pairs and the chosen vision file with all references', async () => {
    props.initialImages = [
      reference,
      { url: 'https://images.example.invalid/detail.png', name: 'detail.png' },
    ]
    vi.mocked(transferInitialImage)
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({ ...stored, id: 'reference-2', name: 'detail.png' })
    await settle()
    choose('image', imagePair)
    choose('vision', visionPair)
    const visionFile = select('ai-vision-file')
    const detail = visionFile.options.find((option) =>
      option.label.includes('detail.png'),
    )!
    visionFile.onValueChange(detail.value)
    expect(button('开始生成').disabled).toBe(false)

    await submit()

    expect(generate).toHaveBeenCalledExactlyOnceWith({
      providerId: 'image-provider',
      imageModel: 'image-v1',
      mode: 'edit',
      presetId: null,
      prompt,
      size: '1024x1024',
      count: 1,
      inputFileIds: ['reference-1', 'reference-2'],
      visionProviderId: 'vision-provider',
      visionModel: 'vision-v1',
      visionFileId: 'reference-2',
    })
    expect(props.onSubmitted).toHaveBeenCalledTimes(1)
    expect(props.onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(uploadImage).not.toHaveBeenCalled()
    expect(uploadRemoteImage).not.toHaveBeenCalled()
  })
})

describe('generation model compatibility', () => {
  it.each(['generate', 'edit'] as const)(
    'blocks %s while modelConfigReady is false and preserves the pairs for recovery',
    async (mode) => {
      props.selections = remembered
      if (mode === 'edit') props.initialImages = [reference]
      await settle()
      expect(button('开始生成').disabled).toBe(false)

      props.modelConfigReady = false
      await settle()
      expect(text(render())).toContain(MODEL_CONFIG_UPDATE_HINT)
      expect(modelSelect('image').disabled).toBe(true)
      expect(modelSelect('vision').disabled).toBe(true)
      expect(button('开始生成').disabled).toBe(true)
      expect(button('智能识图 / 推荐场景').disabled).toBe(true)
      expect(vi.mocked(useScenePlanner).mock.lastCall?.[1]).toBeUndefined()
      await submit()
      expectNoGeneration()
      expect(planner.start).not.toHaveBeenCalled()

      props.modelConfigReady = true
      await settle()
      expect(modelSelect('image').value).toBe(modelValue(imagePair))
      expect(modelSelect('vision').value).toBe(modelValue(visionPair))
      expect(modelSelect('image').disabled).toBe(false)
      expect(modelSelect('vision').disabled).toBe(false)
      expect(button('开始生成').disabled).toBe(false)
      expectNoGeneration()
      await submit()
      expect(generate).toHaveBeenCalledTimes(1)
    },
  )
})
