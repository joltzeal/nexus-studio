import type {
  ChangeEvent,
  ComponentProps,
  DependencyList,
  EffectCallback,
  FormEvent,
  MouseEvent,
  ReactElement,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertDialog, AlertDialogAction } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { SheetDescription } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { listProviders, removeProvider, saveProvider, testProvider } from './api'
import { ProvidersSheet } from './providers-sheet'
import type { Provider } from './types'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (callback: EffectCallback, dependencies?: DependencyList) =>
      state.hooks
        ? state.hooks.effect(callback, dependencies)
        : react.useEffect(callback, dependencies),
  }
})
vi.mock('./api', () => ({
  listProviders: vi.fn(),
  removeProvider: vi.fn(),
  saveProvider: vi.fn(),
  testProvider: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn() },
}))

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'provider-1',
    name: 'Saved provider',
    kind: 'openai_compatible',
    baseUrl: 'https://gateway.example/v1',
    imageModel: 'image-example',
    visionModel: 'vision-example',
    imageTimeoutSeconds: 900,
    imageResponseMode: 'auto',
    hasApiKey: true,
    apiKeyHint: 'test',
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    ...overrides,
  }
}

const modelCases = [
  { role: 'image only', imageModel: 'image-example', visionModel: '' },
  { role: 'vision only', imageModel: '', visionModel: 'vision-example' },
  { role: 'both roles', imageModel: 'image-example', visionModel: 'vision-example' },
]
type InputField = 'name' | 'base' | 'key' | 'image' | 'vision-model' | 'image-timeout'
type Fields = Partial<Record<InputField, string>>

let hooks: KernelHookHarness
let props: ComponentProps<typeof ProvidersSheet>
const render = () => hooks.render(() => ProvidersSheet(props))
const input = (field: InputField) =>
  components(render(), Input).find((node) => node.props.id === `ai-provider-${field}`)!
    .props
const button = (label: string) =>
  components(render(), Button).find((node) => text(node.props.children) === label)!.props
const responseMode = () =>
  components(render(), LabeledSelect).find(
    (node) => node.props.id === 'ai-provider-response-mode',
  )!.props
const deleteButton = () =>
  components(render(), Button).find(
    (node) => node.props['aria-label'] === '删除 Saved provider',
  )!.props
const click = (control: Pick<ComponentProps<typeof Button>, 'onClick'>) =>
  control.onClick?.({ preventDefault: () => {} } as MouseEvent<HTMLButtonElement>)

function fill(fields: Partial<Fields>) {
  for (const [field, value] of Object.entries(fields)) {
    input(field as InputField).onChange?.({
      target: { value },
    } as ChangeEvent<HTMLInputElement>)
  }
}

function expectFields(fields: Partial<Fields>) {
  for (const [field, value] of Object.entries(fields)) {
    expect(input(field as InputField).value).toBe(value)
  }
}

async function submit() {
  const form = elements(render()).find((node) => node.type === 'form')!
  await (form.props.onSubmit as (event: FormEvent) => Promise<void>)({
    preventDefault: () => {},
  } as FormEvent)
}

function expectNoRequests() {
  expect(saveProvider).not.toHaveBeenCalled()
  expect(testProvider).not.toHaveBeenCalled()
  expect(removeProvider).not.toHaveBeenCalled()
  expect(props.onChanged).not.toHaveBeenCalled()
  expect(toast.success).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  props = {
    providers: [],
    storageDurable: true,
    transportSettingsVersion: 1,
    pluginMethods: ['image.providers.testImage'],
    onOpenChange: vi.fn(),
    onChanged: vi.fn().mockResolvedValue(undefined),
    onTestSubmitted: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(saveProvider).mockResolvedValue(provider())
  vi.mocked(listProviders).mockResolvedValue({
    items: [],
    storageDurable: true,
    modelConfigVersion: 2,
    transportSettingsVersion: 1,
    selections: { image: null, vision: null },
  })
})
afterEach(() => hooks.dispose())

describe('provider image request settings', () => {
  it('starts with fifteen minutes and automatic response, and explains streaming and retries', () => {
    expectFields({ 'image-timeout': '15' })
    expect(input('image-timeout').min).toBe(1)
    expect(input('image-timeout').max).toBe(60)
    expect(responseMode().value).toBe('auto')
    expect(responseMode().options).toEqual([
      { value: 'auto', label: '自动' },
      { value: 'stream', label: '流式' },
      { value: 'json', label: '普通' },
    ])
    expect(text(render())).toContain('网关')
    expect(text(render())).toContain('不会自动重试')
    expectNoRequests()
  })

  it.each([
    { minutes: '1', seconds: 60, mode: 'auto' },
    { minutes: '15', seconds: 900, mode: 'stream' },
    { minutes: '60', seconds: 3600, mode: 'json' },
    { minutes: '1.5', seconds: 90, mode: 'json' },
  ])(
    'saves $minutes minutes as $seconds seconds with $mode response',
    async ({ minutes, seconds, mode }) => {
      fill({ key: 'synthetic-key', image: 'image-model', 'image-timeout': minutes })
      responseMode().onValueChange(mode)
      await submit()
      expect(saveProvider).toHaveBeenCalledExactlyOnceWith({
        name: 'OpenAI',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'synthetic-key',
        imageModel: 'image-model',
        visionModel: '',
        imageTimeoutSeconds: seconds,
        imageResponseMode: mode,
      })
    },
  )

  it.each(['', ' ', '0', '0.99', '61', '-2', 'Infinity', 'not-a-number'])(
    'rejects invalid minute input %s without clearing the draft or sending a request',
    async (minutes) => {
      fill({ key: 'synthetic-key', image: 'image-model', 'image-timeout': minutes })
      await submit()
      expectNoRequests()
      expectFields({
        'image-timeout': minutes,
        image: 'image-model',
        key: 'synthetic-key',
      })
      expect(text(components(render(), FieldError)[0]!.props.children)).toContain('1–60')
    },
  )

  it('preserves a saved integer-second value across an unrelated edit and resets new drafts', async () => {
    props.providers = [provider({ imageTimeoutSeconds: 61, imageResponseMode: 'stream' })]
    click(button('编辑'))
    expect(responseMode().value).toBe('stream')
    fill({ name: 'Renamed' })
    await submit()
    expect(saveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        imageTimeoutSeconds: 61,
        imageResponseMode: 'stream',
      }),
    )
    click(button('新建'))
    expectFields({ 'image-timeout': '15' })
    expect(responseMode().value).toBe('auto')
  })

  it('includes the response mode in saved-provider dirty detection', async () => {
    props.providers = [provider()]
    click(button('编辑'))
    responseMode().onValueChange('stream')
    expect(button('测试连接').disabled).toBe(true)
    expect(button('测试生图').disabled).toBe(true)
    click(button('测试连接'))
    click(button('测试生图'))
    await flushPromises()
    expectNoRequests()
    responseMode().onValueChange('auto')
    expect(button('测试连接').disabled).toBe(false)
    expect(button('测试生图').disabled).toBe(false)
  })

  it('retains transport drafts after save failure', async () => {
    props.providers = [provider()]
    click(button('编辑'))
    fill({ 'image-timeout': '60' })
    responseMode().onValueChange('json')
    vi.mocked(saveProvider).mockRejectedValue(new Error('Save failed'))
    await submit()
    expectFields({ 'image-timeout': '60' })
    expect(responseMode().value).toBe('json')
    expect(props.onChanged).not.toHaveBeenCalled()
  })
})

describe('provider transport compatibility gate', () => {
  it('blocks new settings and saves for old plugins while keeping saved connectivity and image tests usable', async () => {
    props.providers = [provider()]
    props.transportSettingsVersion = 0
    expect(input('image-timeout').disabled).toBe(true)
    expect(responseMode().disabled).toBe(true)
    expect(button('保存配置').disabled).toBe(true)
    expect(button('测试连接').disabled).toBe(false)
    expect(button('测试生图').disabled).toBe(false)
    expect(text(render())).toContain('更新 AI 生图插件')
    click(button('编辑'))
    await submit()
    expectNoRequests()
  })

  it('checks the catalog itself when the parent has not supplied the new marker', async () => {
    props.transportSettingsVersion = undefined
    expect(button('保存配置').disabled).toBe(true)
    hooks.flushEffects()
    await flushPromises()
    expect(listProviders).toHaveBeenCalledTimes(1)
    expect(button('保存配置').disabled).toBe(false)
    expect(input('image-timeout').disabled).toBe(false)
  })

  it('treats a missing marker as unsupported even with modelConfigVersion 2', async () => {
    props.transportSettingsVersion = undefined
    vi.mocked(listProviders).mockResolvedValue({
      items: [],
      storageDurable: true,
      modelConfigVersion: 2,
      selections: { image: null, vision: null },
    })
    render()
    hooks.flushEffects()
    await flushPromises()
    expect(button('保存配置').disabled).toBe(true)
    expect(text(render())).toContain('更新 AI 生图插件')
    await submit()
    expectNoRequests()
  })

  it('reports a failed capability read and allows a read-only recheck', async () => {
    props.transportSettingsVersion = undefined
    vi.mocked(listProviders).mockRejectedValueOnce(new Error('Plugin disconnected'))
    render()
    hooks.flushEffects()
    await flushPromises()
    expect(button('保存配置').disabled).toBe(true)
    expect(text(render())).toContain('Plugin disconnected')
    click(button('重新检查'))
    render()
    hooks.flushEffects()
    await flushPromises()
    expect(listProviders).toHaveBeenCalledTimes(2)
    expect(button('保存配置').disabled).toBe(false)
    expectNoRequests()
  })
})

describe('provider model configuration', () => {
  it('offers exactly two empty model fields with guidance and no vision switch', () => {
    const tree = render()
    const modelLabels = components(tree, FieldLabel)
      .map((node) => text(node.props.children))
      .filter((label) => label.endsWith('模型'))
    expect(modelLabels.sort()).toEqual(['生图模型', '识图模型'].sort())
    expect(components(tree, Switch)).toHaveLength(0)
    expect(text(tree)).not.toContain('文案模型')
    expectFields({ image: '', 'vision-model': '' })
    expect(input('image').placeholder).toContain('服务商支持')
    expect(input('vision-model').placeholder).toContain('gpt-4o-mini')
    const description = text(components(tree, SheetDescription)[0]!.props.children)
    expect(description).toContain('识图提取商品标题、描述与生图提示词')
    expect(description).toContain('生图负责生成/改图')
    expect(description).toContain('至少')
    expect(description).toContain('同时')
    expectNoRequests()
  })

  it.each(modelCases)(
    'lists both roles for $role without exposing a saved key',
    (models) => {
      const saved = { ...provider(models), apiKey: 'saved-key-must-stay-private' }
      props.providers = [saved]
      const tree = render()
      const row = elements(tree).find(
        (node) => node.props.className === 'ai-provider-row',
      )!
      const summary = text(row)
      expect(summary).toContain(`识图 ${models.visionModel || '未配置'}`)
      expect(summary).toContain(`生图 ${models.imageModel || '未配置'}`)
      expect(summary).toContain('Key test')
      expect(summary).not.toContain('文案')
      expect(summary).not.toContain('saved-key-must-stay-private')
      click(button('编辑'))
      expect(input('key').value).toBe('')
      expect(input('key').type).toBe('password')
    },
  )

  it.each(modelCases)(
    'saves $role with normalized input and only the two model fields',
    async (models) => {
      fill({
        name: '  Custom provider  ',
        base: '  https://gateway.example/v1  ',
        key: '  sk-test-only  ',
        image: `  ${models.imageModel}  `,
        'vision-model': `  ${models.visionModel}  `,
      })
      components(render(), LabeledSelect)[0]!.props.onValueChange('openai_compatible')
      vi.mocked(saveProvider).mockResolvedValue(
        provider({ ...models, name: 'Custom provider' }),
      )

      await submit()

      expect(saveProvider).toHaveBeenCalledExactlyOnceWith({
        name: 'Custom provider',
        kind: 'openai_compatible',
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'sk-test-only',
        imageModel: models.imageModel,
        visionModel: models.visionModel,
        imageTimeoutSeconds: 900,
        imageResponseMode: 'auto',
      })
      expect(props.onChanged).toHaveBeenCalledTimes(1)
      expect(toast.success).toHaveBeenCalledTimes(1)
      expectFields({ name: 'Custom provider', key: '' })
    },
  )

  it.each<{ reason: string; values: Partial<Fields>; error: string }>([
    {
      reason: 'both models empty',
      values: { image: '', 'vision-model': '' },
      error: '至少',
    },
    {
      reason: 'both models blank',
      values: { image: ' \t ', 'vision-model': ' \t ' },
      error: '至少',
    },
    { reason: 'name blank', values: { name: '  ' }, error: '名称' },
    { reason: 'base URL blank', values: { base: '  ' }, error: '基础地址' },
    { reason: 'new API key blank', values: { key: ' \t ' }, error: 'API Key' },
  ])(
    'blocks $reason before any request and preserves the draft',
    async ({ values, error }) => {
      const draft: Fields = {
        name: ' Draft provider ',
        base: ' https://gateway.example/v1 ',
        key: ' sk-draft-only ',
        image: ' image-example ',
        'vision-model': ' vision-example ',
        ...values,
      }
      fill(draft)

      await submit()

      expectNoRequests()
      expect(text(components(render(), FieldError)[0]!.props.children)).toContain(error)
      expectFields(draft)
      expect(button('保存配置').disabled).toBe(false)
    },
  )

  it.each(modelCases)(
    'edits $role without guessing a missing model or resending the key',
    async (models) => {
      props.providers = [provider(models)]
      click(button('编辑'))
      expectFields({
        image: models.imageModel,
        'vision-model': models.visionModel,
        key: '',
      })
      expect(input('key').placeholder).toContain('留空')
      fill({ key: ' \t ' })

      await submit()

      expect(saveProvider).toHaveBeenCalledExactlyOnceWith({
        id: 'provider-1',
        name: 'Saved provider',
        kind: 'openai_compatible',
        baseUrl: 'https://gateway.example/v1',
        imageModel: models.imageModel,
        visionModel: models.visionModel,
        imageTimeoutSeconds: 900,
        imageResponseMode: 'auto',
      })
    },
  )

  it.each(modelCases.slice(0, 2))(
    'explicitly clears the other model when editing to $role',
    async (models) => {
      props.providers = [provider()]
      click(button('编辑'))
      fill({ image: models.imageModel, 'vision-model': models.visionModel })

      await submit()

      expect(saveProvider).toHaveBeenCalledExactlyOnceWith({
        id: 'provider-1',
        name: 'Saved provider',
        kind: 'openai_compatible',
        baseUrl: 'https://gateway.example/v1',
        imageModel: models.imageModel,
        visionModel: models.visionModel,
        imageTimeoutSeconds: 900,
        imageResponseMode: 'auto',
      })
    },
  )

  it('resets both model fields and the draft key when starting another provider', () => {
    props.providers = [provider()]
    click(button('编辑'))
    fill({ key: 'sk-replacement-draft' })
    click(button('新建'))
    expectFields({ image: '', 'vision-model': '', key: '' })
    expect(input('key').placeholder).not.toContain('留空')
    expectNoRequests()
  })

  it.each([new Error('保存失败，请重试'), '保存失败，请重试'])(
    'keeps every input after a failed save and permits retry: %s',
    async (cause) => {
      props.providers = [provider()]
      click(button('编辑'))
      const draft: Fields = {
        name: ' Unsaved provider ',
        base: ' https://changed.example/v1 ',
        key: ' sk-replacement-draft ',
        image: ' image-changed ',
        'vision-model': ' vision-changed ',
      }
      fill(draft)
      const saving = deferred<Provider>()
      vi.mocked(saveProvider).mockReturnValueOnce(saving.promise)
      const submitted = submit()
      expect(button('保存中…').disabled).toBe(true)
      expect(components(render(), Input).every((node) => node.props.disabled)).toBe(true)

      saving.reject(cause)
      await submitted

      expectFields(draft)
      expect(text(components(render(), FieldError)[0]!.props.children)).toContain(
        '保存失败',
      )
      expect(props.onChanged).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
      expect(button('保存配置').disabled).toBe(false)
      await submit()
      expect(saveProvider).toHaveBeenCalledTimes(2)
      expect(vi.mocked(saveProvider).mock.calls[1]).toEqual([
        {
          id: 'provider-1',
          name: 'Unsaved provider',
          kind: 'openai_compatible',
          baseUrl: 'https://changed.example/v1',
          apiKey: 'sk-replacement-draft',
          imageModel: 'image-changed',
          visionModel: 'vision-changed',
          imageTimeoutSeconds: 900,
          imageResponseMode: 'auto',
        },
      ])
      expect(props.onChanged).toHaveBeenCalledTimes(1)
      expect(components(render(), FieldError)).toHaveLength(0)
      expect(input('key').value).toBe('')
    },
  )

  it.each(modelCases)(
    'accepts saved $role before refresh and retries the same id without the key',
    async (models) => {
      const saved = provider({ ...models, id: 'created-provider' })
      const draft: Fields = {
        name: ' Draft provider ',
        base: ' https://draft.example/v1 ',
        key: ' sk-new-provider ',
        image: ' draft-image ',
        'vision-model': ' draft-vision ',
      }
      fill(draft)
      vi.mocked(saveProvider).mockResolvedValue(saved)
      const refreshing = deferred<void>()
      vi.mocked(props.onChanged).mockReturnValueOnce(refreshing.promise)

      const submitted = submit()
      await flushPromises()

      expect(saveProvider).toHaveBeenCalledExactlyOnceWith({
        name: 'Draft provider',
        kind: 'openai',
        baseUrl: 'https://draft.example/v1',
        apiKey: 'sk-new-provider',
        imageModel: 'draft-image',
        visionModel: 'draft-vision',
        imageTimeoutSeconds: 900,
        imageResponseMode: 'auto',
      })
      expect(props.onChanged).toHaveBeenCalledTimes(1)
      expectFields({
        name: 'Saved provider',
        base: 'https://gateway.example/v1',
        key: '',
        image: models.imageModel,
        'vision-model': models.visionModel,
      })
      expect(input('key').placeholder).toContain('留空')
      expect(button('保存中…').disabled).toBe(true)

      refreshing.reject(new Error('目录暂时不可用'))
      await submitted

      const error = text(components(render(), FieldError)[0]!.props.children)
      expect(error).toContain('已保存')
      expect(error).toContain('刷新')
      expect(error).toContain('失败')
      expect(error).toContain('目录暂时不可用')
      expectFields({
        name: 'Saved provider',
        base: 'https://gateway.example/v1',
        key: '',
        image: models.imageModel,
        'vision-model': models.visionModel,
      })
      expect(button('保存配置').disabled).toBe(false)

      await submit()

      expect(saveProvider).toHaveBeenCalledTimes(2)
      expect(vi.mocked(saveProvider).mock.calls[1]).toEqual([
        {
          id: 'created-provider',
          name: 'Saved provider',
          kind: 'openai_compatible',
          baseUrl: 'https://gateway.example/v1',
          imageModel: models.imageModel,
          visionModel: models.visionModel,
          imageTimeoutSeconds: 900,
          imageResponseMode: 'auto',
        },
      ])
      expect(props.onChanged).toHaveBeenCalledTimes(2)
      expect(components(render(), FieldError)).toHaveLength(0)
    },
  )
})

describe('provider removal refresh', () => {
  it('accepts deletion before refresh and reports refresh failure without retrying deletion', async () => {
    props.providers = [provider()]
    click(button('编辑'))
    fill({ key: 'sk-unsaved-replacement' })
    click(deleteButton())
    vi.mocked(removeProvider).mockResolvedValue({ id: 'provider-1', removed: true })
    const refreshing = deferred<void>()
    vi.mocked(props.onChanged).mockReturnValueOnce(refreshing.promise)

    click(components(render(), AlertDialogAction)[0]!.props)
    await flushPromises()

    expect(removeProvider).toHaveBeenCalledExactlyOnceWith('provider-1')
    expect(props.onChanged).toHaveBeenCalledTimes(1)
    expect(components(render(), AlertDialog)[0]!.props.open).toBe(false)
    expectFields({ image: '', 'vision-model': '', key: '' })
    expect(input('key').placeholder).not.toContain('留空')

    refreshing.reject(new Error('目录暂时不可用'))
    await flushPromises()

    const error = text(components(render(), FieldError)[0]!.props.children)
    expect(error).toContain('已删除')
    expect(error).toContain('刷新')
    expect(error).toContain('失败')
    expect(error).toContain('目录暂时不可用')
    expect(components(render(), AlertDialog)[0]!.props.open).toBe(false)
    expect(button('保存配置').disabled).toBe(false)
    click(components(render(), AlertDialogAction)[0]!.props)
    await flushPromises()
    expect(removeProvider).toHaveBeenCalledTimes(1)
    expect(saveProvider).not.toHaveBeenCalled()
  })

  it('retains the confirmation and draft if deletion itself fails', async () => {
    props.providers = [provider()]
    click(button('编辑'))
    fill({ key: 'sk-unsaved-replacement' })
    click(deleteButton())
    vi.mocked(removeProvider).mockRejectedValue(new Error('删除失败，请重试'))

    click(components(render(), AlertDialogAction)[0]!.props)
    await flushPromises()

    expect(components(render(), AlertDialog)[0]!.props.open).toBe(true)
    expectFields({
      name: 'Saved provider',
      image: 'image-example',
      'vision-model': 'vision-example',
      key: 'sk-unsaved-replacement',
    })
    expect(text(components(render(), FieldError)[0]!.props.children)).toContain(
      '删除失败',
    )
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('provider model compatibility gate', () => {
  it('keeps saved entries visible but blocks configuration until compatibility is confirmed', async () => {
    props.providers = [provider()]
    props.modelConfigReady = false
    expect(text(render())).toContain('请先更新 AI 生图插件，再配置识图与生图模型。')
    expect(text(render())).toContain('Saved provider')
    for (const label of ['保存配置', '测试连接', '测试生图', '编辑']) {
      expect(button(label).disabled).toBe(true)
    }
    expect(deleteButton().disabled).toBe(true)
    expect(components(render(), Input).every((node) => node.props.disabled)).toBe(true)
    expect(components(render(), LabeledSelect)[0]!.props.disabled).toBe(true)
    await submit()
    click(button('测试连接'))
    await flushPromises()
    expectNoRequests()

    props.modelConfigReady = true
    expect(text(render())).not.toContain('请先更新 AI 生图插件')
    expect(button('编辑').disabled).toBe(false)
    click(button('编辑'))
    await submit()
    expect(saveProvider).toHaveBeenCalledTimes(1)
  })

  it('blocks save, test and an already-open delete confirmation if compatibility changes', async () => {
    props.providers = [provider()]
    click(button('编辑'))
    click(deleteButton())
    props.modelConfigReady = false
    expect(button('新建').disabled).toBe(true)
    expect(button('保存配置').disabled).toBe(true)
    const confirmation = components(render(), AlertDialogAction)[0]!.props
    expect(confirmation.disabled).toBe(true)

    await submit()
    click(button('测试连接'))
    click(confirmation)
    await flushPromises()

    expectNoRequests()
    expectFields({
      name: 'Saved provider',
      image: 'image-example',
      'vision-model': 'vision-example',
    })
  })
})

describe('provider image test entry', () => {
  const dialog = () =>
    elements(render()).find(
      (node) =>
        typeof node.type === 'function' && node.type.name === 'ProviderImageTestDialog',
    ) as
      | ReactElement<{
          provider: Provider
          onClose: () => void
          onChanged: () => Promise<void>
          pluginMethods?: string[]
          modelConfigReady: boolean
        }>
      | undefined

  it('labels the read-only connectivity test separately from actual image generation', async () => {
    props.providers = [provider()]
    vi.mocked(testProvider).mockResolvedValue({
      ok: true,
      message: 'Connected',
      modelCount: 3,
      durationMs: 20,
    })
    expect(text(render())).toContain('连接测试')
    expect(text(render())).toContain('不代表')
    expect(text(render())).toContain('生图')
    click(button('测试连接'))
    await flushPromises()
    expect(testProvider).toHaveBeenCalledExactlyOnceWith('provider-1')
    expect(dialog()).toBeUndefined()
    expect(props.onTestSubmitted).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'undeclared method', change: { pluginMethods: [] } },
    { label: 'unknown methods', change: { pluginMethods: undefined } },
    { label: 'old configuration', change: { modelConfigReady: false } },
    { label: 'missing key', saved: { hasApiKey: false } },
    { label: 'missing image model', saved: { imageModel: '  ' } },
  ])('blocks actual tests for $label without falling back', ({ change, saved }) => {
    props = { ...props, ...change, providers: [provider(saved)] }
    expect(button('测试生图').disabled).toBe(true)
    click(button('测试生图'))
    expect(dialog()).toBeUndefined()
    expectNoRequests()
    if (change && !change.pluginMethods && change.modelConfigReady !== false) {
      expect(text(render())).toContain('更新 AI 生图插件')
    }
  })

  it('opens the saved snapshot and preserves an unrelated new draft across open, refresh and close', async () => {
    props.providers = [provider()]
    const draft: Fields = {
      name: 'Unsaved name',
      base: 'https://unsaved.example/v1',
      key: 'synthetic-unsaved-key',
      image: 'unsaved-image',
      'vision-model': 'unsaved-vision',
    }
    fill(draft)
    click(button('测试生图'))
    const opened = dialog()
    expect(opened).toBeDefined()
    expect(opened?.props.provider).toEqual(provider())
    expect(opened?.props.pluginMethods).toEqual(['image.providers.testImage'])
    expect(opened?.props.modelConfigReady).toBe(true)
    expectFields(draft)
    expectNoRequests()

    props.providers = [provider({ name: 'Refreshed name', imageModel: 'new-model' })]
    expect(dialog()?.props.provider).toEqual(provider())
    await dialog()?.props.onChanged()
    expect(props.onTestSubmitted).toHaveBeenCalledTimes(1)
    expect(props.onChanged).not.toHaveBeenCalled()
    dialog()?.props.onClose()
    expect(dialog()).toBeUndefined()
    expectFields(draft)
  })

  it.each<{ field: InputField; value: string }>([
    { field: 'name', value: 'Changed name' },
    { field: 'base', value: 'https://changed.example.invalid/v1' },
    { field: 'key', value: 'synthetic-replacement-key' },
    { field: 'image', value: 'changed-image-model' },
    { field: 'vision-model', value: 'changed-vision-model' },
    { field: 'image-timeout', value: '30' },
  ])(
    'blocks both tests until the edited $field is saved or reverted',
    async ({ field, value }) => {
      props.providers = [provider()]
      click(button('编辑'))
      const original = String(input(field).value)
      fill({ [field]: value })

      expect(button('测试连接').disabled).toBe(true)
      expect(button('测试生图').disabled).toBe(true)
      expect(text(render())).toContain('请先保存修改后再测试')
      click(button('测试连接'))
      click(button('测试生图'))
      await flushPromises()

      expectNoRequests()
      expect(dialog()).toBeUndefined()
      expectFields({ [field]: value })
      fill({ [field]: original })
      expect(button('测试连接').disabled).toBe(false)
      expect(button('测试生图').disabled).toBe(false)
      expect(text(render())).not.toContain('请先保存修改后再测试')
    },
  )

  it('blocks tests when the edited interface type changes', async () => {
    props.providers = [provider()]
    click(button('编辑'))
    components(render(), LabeledSelect)[0]!.props.onValueChange('openai')
    expect(button('测试连接').disabled).toBe(true)
    expect(button('测试生图').disabled).toBe(true)
    click(button('测试连接'))
    click(button('测试生图'))
    await flushPromises()
    expectNoRequests()
    expect(dialog()).toBeUndefined()
  })

  it('allows testing another saved provider while retaining the edited draft', async () => {
    const other = provider({
      id: 'provider-2',
      name: 'Other saved provider',
      imageModel: 'other-image',
    })
    props.providers = [provider(), other]
    click(button('编辑'))
    fill({ key: 'synthetic-unsaved-key', image: 'unsaved-model' })
    const row = elements(render()).find(
      (node) =>
        node.props.className === 'ai-provider-row' &&
        text(node).includes('Other saved provider'),
    )!
    const otherButton = (label: string) =>
      components(row, Button).find((node) => text(node.props.children) === label)!.props
    expect(otherButton('测试连接').disabled).toBe(false)
    expect(otherButton('测试生图').disabled).toBe(false)
    click(otherButton('测试生图'))
    expect(dialog()?.props.provider).toEqual(other)
    expectFields({ key: 'synthetic-unsaved-key', image: 'unsaved-model' })
    dialog()?.props.onClose()
    expectFields({ key: 'synthetic-unsaved-key', image: 'unsaved-model' })
    expectNoRequests()
  })
})
