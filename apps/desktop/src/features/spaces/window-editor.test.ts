import type {
  ComponentProps,
  DependencyList,
  EffectCallback,
  FormEvent,
  MouseEvent,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Select, SelectItem } from '@/components/ui/select'
import { getKernelStatus } from '@/lib/platform/native-kernels'
import { listProxyProviders } from '@/lib/platform/native-plugins'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  kernelStatus,
  text,
} from '@/features/settings/kernel-test-support'
import { WindowEditor, type SaveWindow } from './window-editor'
import { WindowKernelField } from './window-kernel-field'

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
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('@/lib/platform/native-kernels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-kernels')>()),
  getKernelStatus: vi.fn(),
}))
vi.mock('@/lib/platform/native-plugins', () => ({ listProxyProviders: vi.fn() }))
vi.mock('@/lib/platform/native-profiles', () => ({
  nativeProfilesAvailable: () => true,
}))
vi.mock('@/features/proxy/api', () => ({ getConfig: vi.fn() }))
vi.mock('./window-proxy', () => ({ checkWindowProxy: vi.fn() }))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

let editorHooks: KernelHookHarness
let fieldHooks: KernelHookHarness
let props: ComponentProps<typeof WindowEditor>
const render = () => editorHooks.render(() => WindowEditor(props))
const field = () => components(render(), WindowKernelField)[0]!.props
const renderField = () => fieldHooks.render(() => WindowKernelField(field()))
const click = (button: ComponentProps<typeof Button>) =>
  button.onClick?.({} as MouseEvent<HTMLButtonElement>)
const refresh = () => click(components(renderField(), Button)[0]!.props)
async function mount() {
  render()
  editorHooks.flushEffects()
  if (!props.window) {
    renderField()
    fieldHooks.flushEffects()
  }
  await flushPromises()
}
async function submit() {
  const form = elements(render()).find((node) => node.type === 'form')!
  ;(form.props.onSubmit as (event: FormEvent) => void)({
    preventDefault: () => {},
  } as FormEvent)
  await flushPromises()
}

beforeEach(() => {
  vi.resetAllMocks()
  editorHooks = new KernelHookHarness(state)
  fieldHooks = new KernelHookHarness(state)
  props = {
    window: null,
    groups: [],
    takenNames: [],
    // A cached plan is not used to reject paid version selection.
    licenseStatus: { configured: true } as ComponentProps<
      typeof WindowEditor
    >['licenseStatus'],
    onSave: vi.fn<SaveWindow>().mockResolvedValue(undefined),
    onCancel: vi.fn(),
  }
  vi.mocked(listProxyProviders).mockResolvedValue([])
  vi.mocked(getKernelStatus).mockResolvedValue(
    kernelStatus(['155.0.8059.39.2', '155.0.8059.39.1']),
  )
})
afterEach(() => {
  editorHooks.dispose()
  fieldHooks.dispose()
})

describe('window kernel selection', () => {
  it.each([false, true])(
    'defaults to latest and forwards exact package selection for batch=%s',
    async (batch) => {
      if (batch) props.batch = { count: 2 }
      await mount()
      expect(field().value).toBeNull()
      expect(getKernelStatus).toHaveBeenCalledExactlyOnceWith(true)
      expect(
        components(renderField(), SelectItem).map((node) => node.props.value),
      ).toEqual(['latest', '155.0.8059.39.2', '155.0.8059.39.1'])
      await submit()
      expect(vi.mocked(props.onSave).mock.calls[0]).toHaveLength(6)
      components(renderField(), Select)[0]!.props.onValueChange?.('155.0.8059.39.1')
      await submit()
      expect(vi.mocked(props.onSave).mock.calls[1]![6]).toBe('155.0.8059.39.1')
      components(renderField(), Select)[0]!.props.onValueChange?.('latest')
      await submit()
      expect(vi.mocked(props.onSave).mock.calls[2]).toHaveLength(6)
    },
  )

  it('allows licensed latest creation while inventory is pending or unavailable', async () => {
    const pending = deferred<Awaited<ReturnType<typeof getKernelStatus>>>()
    vi.mocked(getKernelStatus).mockReturnValueOnce(pending.promise)
    await mount()
    expect(components(renderField(), Button)[0]!.props.disabled).toBe(true)
    expect(
      components(render(), Button).find((node) => node.props.type === 'submit')!.props
        .disabled,
    ).toBe(false)
    await submit()
    expect(props.onSave).toHaveBeenCalledTimes(1)
    pending.reject(new Error('inventory unavailable'))
    await flushPromises()
    expect(text(renderField())).toContain('无法读取已安装内核')
    await submit()
    expect(props.onSave).toHaveBeenCalledTimes(2)
    expect(vi.mocked(props.onSave).mock.calls.every((call) => call.length === 6)).toBe(
      true,
    )
  })

  it('retains selection across refresh failure, retry and a disappearing installed package', async () => {
    await mount()
    components(renderField(), Select)[0]!.props.onValueChange?.('155.0.8059.39.2')
    vi.mocked(getKernelStatus).mockRejectedValueOnce(new Error('offline'))
    refresh()
    await flushPromises()
    expect(field().value).toBe('155.0.8059.39.2')
    expect(text(renderField())).toContain('重试读取')
    vi.mocked(getKernelStatus).mockResolvedValueOnce(kernelStatus([]))
    refresh()
    await flushPromises()
    expect(field().value).toBe('155.0.8059.39.2')
    expect(text(renderField())).toContain('155.0.8059.39.2（保留选择）')
    await submit()
    expect(vi.mocked(props.onSave).mock.calls[0]![6]).toBe('155.0.8059.39.2')
    expect(getKernelStatus).toHaveBeenCalledTimes(3)
  })

  it('does not fetch inventory or expose a selector when editing a fixed binding', async () => {
    props.window = {
      id: 'existing',
      name: 'existing',
      version: '155.0.8059.39',
      kernelVersion: '155.0.8059.39.2',
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      groupId: null,
      running: false,
      createdAt: 10,
      lastOpenedAt: null,
      settings: {
        platform: 'Vinted',
        note: '',
        geoip: true,
        timezone: '',
        locale: '',
        viewport: 'default',
        fingerprintSeed: 42,
        startUrl: '',
      },
    }
    await mount()
    expect(components(render(), WindowKernelField)).toHaveLength(0)
    expect(getKernelStatus).not.toHaveBeenCalled()
    await submit()
    expect(vi.mocked(props.onSave).mock.calls[0]).toHaveLength(6)
    expect(vi.mocked(props.onSave).mock.calls[0]![4].fingerprintSeed).toBe(42)
  })

  it('still requires activation when a cached version is selected', async () => {
    props.licenseStatus = null
    await mount()
    field().onChange('155.0.8059.39.2')
    await submit()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(text(render())).toContain('激活码')
  })
})
