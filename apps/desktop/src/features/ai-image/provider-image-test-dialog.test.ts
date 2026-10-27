import type {
  ChangeEvent,
  ComponentProps,
  DependencyList,
  EffectCallback,
  FormEvent,
  MouseEvent,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Textarea } from '@/components/ui/textarea'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import {
  createScenePlan,
  generate,
  getRecord,
  recognizeRecord,
  testProviderImage,
  uploadImage,
} from './api'
import { prepareReference, type PreparedReference } from './prepare-reference'
import { ProviderImageTestDialog } from './provider-image-test-dialog'
import { RecordImage } from './record-image'
import type { GenerationRecord, Provider, StoredFile } from './types'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
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
    useLayoutEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks
        ? state.hooks.effect(effect, deps)
        : react.useLayoutEffect(effect, deps),
  }
})
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  testProviderImage: vi.fn(),
  getRecord: vi.fn(),
  uploadImage: vi.fn(),
  generate: vi.fn(),
  createScenePlan: vi.fn(),
  recognizeRecord: vi.fn(),
}))
vi.mock('./prepare-reference', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prepare-reference')>()),
  prepareReference: vi.fn(),
}))

class DialogHarness extends KernelHookHarness {
  writes = 0

  override state(initial: unknown): [unknown, (next: unknown) => void] {
    const [value, setValue] = super.state(initial)
    return [
      value,
      (next) => {
        this.writes += 1
        setValue(next)
      },
    ]
  }
}

const provider: Provider = {
  id: 'saved-provider',
  name: 'Saved gateway',
  kind: 'openai_compatible',
  baseUrl: 'https://saved.example.invalid/v1',
  imageModel: 'saved-image-model',
  hasApiKey: true,
  apiKeyHint: 'test',
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
}
const reference: StoredFile = {
  id: 'uploaded-reference',
  name: 'reference.jpg',
  mime: 'image/jpeg',
  bytes: 10,
}
const output: StoredFile = {
  id: 'test-output',
  name: 'output.png',
  mime: 'image/png',
  bytes: 20,
}
const prepared: PreparedReference = {
  base64: 'anBlZw==',
  mime: 'image/jpeg',
  name: 'reference.jpg',
  width: 100,
  height: 100,
  bytes: 4,
}

function record(change: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id: 'provider-test-record',
    purpose: 'provider-test',
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    status: 'running',
    stage: 'image',
    mode: 'generate',
    prompt: 'A ceramic cup.',
    presetId: null,
    presetLabel: null,
    size: '1024x1024',
    count: 1,
    providerId: provider.id,
    providerName: provider.name,
    providerKind: provider.kind,
    imageModel: provider.imageModel,
    inputs: [],
    outputs: [],
    title: '测试生图',
    description: null,
    error: null,
    durationMs: null,
    ...change,
  }
}

let hooks: DialogHarness
let props: ComponentProps<typeof ProviderImageTestDialog>
const render = () => hooks.render(() => ProviderImageTestDialog(props))
const button = (label: string) =>
  components(render(), Button).find((node) => text(node.props.children) === label)!.props
const click = (label: string) =>
  button(label).onClick?.({ preventDefault: () => {} } as MouseEvent<HTMLButtonElement>)
const select = (label: string, value: string) =>
  components(render(), LabeledSelect)
    .find((node) => node.props.ariaLabel === label)!
    .props.onValueChange(value)
const promptInput = () => components(render(), Textarea)[0]!.props
const setPrompt = (value: string) =>
  promptInput().onChange?.({ target: { value } } as ChangeEvent<HTMLTextAreaElement>)
const fileInput = () =>
  components(render(), Input).find((node) => node.props.type === 'file')!.props
const submitHandler = () =>
  elements(render()).find((node) => node.type === 'form')!.props.onSubmit as (
    event: FormEvent,
  ) => Promise<void>
const event = { preventDefault: () => {} } as FormEvent
const submit = () => submitHandler()(event)
const errors = () =>
  components(render(), FieldError)
    .map((node) => text(node.props.children))
    .join('\n')

function choose(files: File[]) {
  const target = { files, value: 'C:\\fakepath\\reference.webp' }
  fileInput().onChange?.({
    currentTarget: target,
    target,
  } as unknown as ChangeEvent<HTMLInputElement>)
  expect(target.value).toBe('')
}

async function open() {
  render()
  hooks.flushEffects()
  await flushPromises()
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  hooks = new DialogHarness(state)
  props = {
    provider: { ...provider },
    pluginMethods: ['image.providers.testImage'],
    modelConfigReady: true,
    onClose: vi.fn(),
    onChanged: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(testProviderImage).mockResolvedValue({ record: record() })
  vi.mocked(getRecord).mockResolvedValue({ record: record() })
  vi.mocked(prepareReference).mockResolvedValue(prepared)
  vi.mocked(uploadImage).mockResolvedValue(reference)
})

afterEach(() => {
  hooks.dispose()
  vi.useRealTimers()
  expect(generate).not.toHaveBeenCalled()
  expect(createScenePlan).not.toHaveBeenCalled()
  expect(recognizeRecord).not.toHaveBeenCalled()
})

describe('explicit provider image test', () => {
  it('opens without a request, shows saved configuration and billing, and submits the editable prompt once', async () => {
    await open()
    expect(text(render())).toContain(provider.name)
    expect(text(render())).toContain(provider.baseUrl)
    expect(text(render())).toContain(provider.imageModel)
    expect(text(render())).toContain('已保存')
    expect(text(render())).toContain('1 张')
    expect(text(render())).toContain('计费')
    expect(promptInput().value).toBeTruthy()
    expect(testProviderImage).not.toHaveBeenCalled()
    expect(getRecord).not.toHaveBeenCalled()
    setPrompt(' Custom prompt.\n')
    select('输出尺寸', '1536x1024')
    expect(testProviderImage).not.toHaveBeenCalled()
    await submit()
    expect(testProviderImage).toHaveBeenCalledExactlyOnceWith({
      id: 'saved-provider',
      model: 'saved-image-model',
      mode: 'generate',
      prompt: ' Custom prompt.\n',
      size: '1536x1024',
      inputFileIds: [],
    })
    expect(text(render())).toContain('已提交')
    expect(text(render())).toContain('历史记录')
    expect(props.onChanged).toHaveBeenCalledTimes(1)
  })

  it('holds the saved snapshot through provider refresh and locks the job while submitting', async () => {
    await open()
    setPrompt('Snapshot prompt')
    props.provider = { ...provider, name: 'Changed', imageModel: 'changed-model' }
    const accepted = deferred<{ record: GenerationRecord }>()
    vi.mocked(testProviderImage).mockReturnValueOnce(accepted.promise)
    const action = submitHandler()
    const first = action(event)
    const duplicate = action(event)
    expect(testProviderImage).toHaveBeenCalledTimes(1)
    expect(button('提交中…').disabled).toBe(true)
    expect(promptInput().disabled).toBe(true)
    select('测试方式', 'edit')
    setPrompt('Cannot replace a pending job')
    expect(promptInput().value).toBe('Snapshot prompt')
    expect(text(render())).not.toContain('changed-model')

    accepted.resolve({ record: record() })
    await Promise.all([first, duplicate])
    await submit()
    expect(testProviderImage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(testProviderImage).mock.calls[0]?.[0].model).toBe(
      'saved-image-model',
    )
    expect(getRecord).toHaveBeenCalledExactlyOnceWith('provider-test-record')
  })

  it.each([
    { label: 'missing method', change: { pluginMethods: [] } },
    { label: 'unknown methods', change: { pluginMethods: undefined } },
    { label: 'old model config', change: { modelConfigReady: false } },
    { label: 'missing key', change: { provider: { ...provider, hasApiKey: false } } },
    {
      label: 'missing image model',
      change: { provider: { ...provider, imageModel: '' } },
    },
  ])('blocks $label even if the submit handler is invoked', async ({ change }) => {
    props = { ...props, ...change }
    await open()
    expect(button('开始测试').disabled).toBe(true)
    await submit()
    expect(testProviderImage).not.toHaveBeenCalled()
    expect(getRecord).not.toHaveBeenCalled()
    if ('pluginMethods' in change) expect(text(render())).toContain('更新 AI 生图插件')
  })

  it.each([' \n ', 'a'.repeat(12001)])(
    'rejects an invalid prompt (case %#)',
    async (value) => {
      await open()
      setPrompt(value)
      expect(button('开始测试').disabled).toBe(true)
      await submit()
      expect(promptInput().value).toBe(value)
      expect(testProviderImage).not.toHaveBeenCalled()
    },
  )

  it('shows the complete submission error and only retries on another explicit submit', async () => {
    await open()
    const error =
      'No available channel\nEnable this image model in the gateway and check quota.'
    vi.mocked(testProviderImage).mockRejectedValueOnce(new Error(error))
    await submit()
    expect(errors()).toContain(error)
    await vi.advanceTimersByTimeAsync(7500)
    expect(testProviderImage).toHaveBeenCalledTimes(1)
    expect(button('开始测试').disabled).toBe(false)
    await submit()
    expect(testProviderImage).toHaveBeenCalledTimes(2)
  })
})

describe('accepted test records', () => {
  it('polls one record through success, shows actual output and duration, then stops', async () => {
    await open()
    vi.mocked(getRecord)
      .mockResolvedValueOnce({ record: record() })
      .mockResolvedValueOnce({
        record: record({
          status: 'success',
          stage: 'done',
          outputs: [output],
          durationMs: 4200,
        }),
      })
    await submit()
    expect(text(render())).toContain('正在生成')
    await vi.advanceTimersByTimeAsync(2500)
    expect(
      components(render(), RecordImage).map((node) => node.props.file),
    ).toContainEqual(output)
    expect(text(render())).toContain('4.2 秒')
    expect(text(render())).toContain('已生成')
    expect(props.onChanged).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(7500)
    expect(getRecord).toHaveBeenCalledTimes(2)
    expect(testProviderImage).toHaveBeenCalledTimes(1)
  })

  it('refreshes history when the very first record read is already terminal', async () => {
    await open()
    vi.mocked(getRecord).mockResolvedValueOnce({
      record: record({
        status: 'failed',
        stage: 'done',
        error: 'No available channel\nCheck gateway routing.',
      }),
    })
    await submit()
    await flushPromises()
    expect(errors()).toContain('No available channel\nCheck gateway routing.')
    expect(props.onChanged).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(getRecord).toHaveBeenCalledTimes(1)
  })

  it('retains acceptance after a read error and refreshes results without resubmitting', async () => {
    await open()
    vi.mocked(getRecord).mockRejectedValueOnce(
      new Error('Record read temporarily unavailable'),
    )
    await submit()
    await flushPromises()
    expect(text(render())).toContain('已提交')
    expect(errors()).toContain('Record read temporarily unavailable')
    expect(errors()).toContain('勿重复提交')
    expect(button('开始测试').disabled).toBe(true)
    click('刷新结果')
    await flushPromises()
    expect(getRecord).toHaveBeenCalledTimes(2)
    expect(errors()).not.toContain('Record read temporarily unavailable')
    await submit()
    expect(testProviderImage).toHaveBeenCalledTimes(1)
  })

  it('keeps an accepted task if the main history refresh rejects', async () => {
    await open()
    vi.mocked(props.onChanged).mockRejectedValueOnce(new Error('History unavailable'))
    await submit()
    await flushPromises()
    expect(errors()).toContain('History unavailable')
    expect(text(render())).toContain('已提交')
    click('刷新结果')
    await flushPromises()
    await submit()
    expect(testProviderImage).toHaveBeenCalledTimes(1)
    expect(getRecord).toHaveBeenCalledTimes(2)
  })

  it.each(['close', 'unmount'] as const)(
    'refreshes the main history for late acceptance after %s without polling or writing local state',
    async (finish) => {
      await open()
      const accepted = deferred<{ record: GenerationRecord }>()
      vi.mocked(testProviderImage).mockReturnValueOnce(accepted.promise)
      const pending = submit()
      if (finish === 'close') components(render(), Dialog)[0]!.props.onOpenChange?.(false)
      else hooks.dispose()
      const writes = hooks.writes
      accepted.resolve({ record: record() })
      await pending
      expect(props.onChanged).toHaveBeenCalledTimes(1)
      expect(getRecord).not.toHaveBeenCalled()
      expect(hooks.writes).toBe(writes)
      await vi.advanceTimersByTimeAsync(5000)
      expect(testProviderImage).toHaveBeenCalledTimes(1)
    },
  )

  it('ignores an in-flight record response and stops polling when closed', async () => {
    await open()
    const reading = deferred<{ record: GenerationRecord }>()
    vi.mocked(getRecord).mockReturnValueOnce(reading.promise)
    await submit()
    click('关闭')
    const writes = hooks.writes
    reading.resolve({ record: record({ status: 'success', outputs: [output] }) })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10000)
    expect(hooks.writes).toBe(writes)
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(getRecord).toHaveBeenCalledTimes(1)
    expect(props.onChanged).toHaveBeenCalledTimes(1)
  })
})

describe('single image test input', () => {
  it('requires exactly one prepared JPEG, previews the stored file, and never requests vision', async () => {
    await open()
    select('测试方式', 'edit')
    expect(fileInput().multiple).not.toBe(true)
    expect(fileInput().accept).toBe('image/jpeg,image/png,image/webp')
    await submit()
    expect(testProviderImage).not.toHaveBeenCalled()
    const original = new File(['webp'], 'reference.webp', { type: 'image/webp' })
    choose([original])
    expect(button('开始测试').disabled).toBe(true)
    await flushPromises()
    const signal = vi.mocked(prepareReference).mock.calls[0]?.[1]
    expect(prepareReference).toHaveBeenCalledExactlyOnceWith(original, signal)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(uploadImage).toHaveBeenCalledExactlyOnceWith(prepared, signal)
    expect(components(render(), RecordImage)[0]?.props.file).toEqual(reference)
    await submit()
    expect(testProviderImage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(testProviderImage).mock.calls[0]?.[0]).toMatchObject({
      mode: 'edit',
      inputFileIds: ['uploaded-reference'],
    })
    expect(Object.keys(vi.mocked(testProviderImage).mock.calls[0]![0]).sort()).toEqual(
      ['id', 'model', 'mode', 'prompt', 'size', 'inputFileIds'].sort(),
    )
  })

  it('clears the old reference on failed replacement and refuses multiple files', async () => {
    await open()
    select('测试方式', 'edit')
    const file = new File(['png'], 'source.png', { type: 'image/png' })
    choose([file])
    await flushPromises()
    vi.mocked(prepareReference).mockRejectedValueOnce(
      new Error('Cannot decode source image'),
    )
    choose([file])
    await flushPromises()
    expect(errors()).toContain('Cannot decode source image')
    expect(components(render(), RecordImage)).toHaveLength(0)
    await submit()
    expect(testProviderImage).not.toHaveBeenCalled()
    choose([file, file])
    await flushPromises()
    expect(errors()).toContain('一张')
    expect(prepareReference).toHaveBeenCalledTimes(2)
    expect(uploadImage).toHaveBeenCalledTimes(1)
  })

  it.each(['remove', 'mode', 'close', 'unmount'] as const)(
    'cancels preparation on %s and prevents a stale upload',
    async (action) => {
      await open()
      select('测试方式', 'edit')
      const preparing = deferred<PreparedReference>()
      vi.mocked(prepareReference).mockReturnValueOnce(preparing.promise)
      choose([new File(['png'], 'source.png', { type: 'image/png' })])
      const signal = vi.mocked(prepareReference).mock.calls[0]?.[1]
      if (action === 'remove') click('移除参考图')
      if (action === 'mode') select('测试方式', 'generate')
      if (action === 'close') click('关闭')
      if (action === 'unmount') hooks.dispose()
      expect(signal?.aborted).toBe(true)
      const writes = hooks.writes
      preparing.resolve(prepared)
      await flushPromises()
      expect(uploadImage).not.toHaveBeenCalled()
      expect(hooks.writes).toBe(writes)
    },
  )

  it('ignores a replaced upload that finishes last and only submits the current image', async () => {
    await open()
    select('测试方式', 'edit')
    const older = deferred<StoredFile>()
    vi.mocked(uploadImage).mockReturnValueOnce(older.promise)
    choose([new File(['first'], 'first.png', { type: 'image/png' })])
    await flushPromises()
    const oldSignal = vi.mocked(uploadImage).mock.calls[0]?.[1]
    choose([new File(['second'], 'second.png', { type: 'image/png' })])
    await flushPromises()
    expect(oldSignal?.aborted).toBe(true)
    older.resolve({ ...reference, id: 'obsolete-file' })
    await flushPromises()
    expect(components(render(), RecordImage)[0]?.props.file).toEqual(reference)
    await submit()
    expect(vi.mocked(testProviderImage).mock.calls[0]?.[0].inputFileIds).toEqual([
      reference.id,
    ])
  })
})
