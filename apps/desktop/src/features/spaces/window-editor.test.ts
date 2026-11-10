import type {
  ComponentProps,
  DependencyList,
  EffectCallback,
  FormEvent,
  MouseEvent,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserConnection, browserWindow } from '@/lib/platform/browser-test-support'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectItem, SelectTrigger } from '@/components/ui/select'
import * as random from '@/lib/random-name'
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
vi.mock('@/lib/platform/windows', () => ({
  browserWindowsAvailable: () => true,
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
    connection: browserConnection(),
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
  vi.restoreAllMocks()
})

function select(id: string) {
  return components(render(), Select).find((node) =>
    components(node, SelectTrigger).some((trigger) => trigger.props.id === id),
  )!
}

function input(id: string, value: string) {
  components(render(), Input)
    .find((node) => node.props.id === id)!
    .props.onChange?.({ target: { value } } as never)
}

it.each(['create', 'batch', 'edit'] as const)(
  'preserves authenticated manual proxy URLs for %s',
  async (mode) => {
    props.connection = browserConnection({ id: 'bit', providerId: 'bitbrowser' })
    if (mode === 'batch') props.batch = { count: 2 }
    if (mode === 'edit')
      props.window = browserWindow({ connectionId: 'bit', providerId: 'bitbrowser' })
    for (const protocol of ['http', 'https', 'socks5']) {
      select('window-proxy-source').props.onValueChange?.('manual')
      select('window-protocol').props.onValueChange?.(protocol)
      const server = `${protocol}://fixture%40user:fixture%3Apass@proxy.test:1080`
      input('window-proxy', server)
      await submit()
      expect(vi.mocked(props.onSave).mock.lastCall?.[0]).toMatchObject({
        proxyMode: 'manual',
        proxy: server,
      })
    }
    expect(props.onSave).toHaveBeenCalledTimes(3)
  },
)

it.each(['adspower', 'bitbrowser'] as const)(
  'defaults new %s windows to Direct and reserves Provider for existing windows',
  async (providerId) => {
    props.connection = browserConnection({ providerId })
    expect(select('window-proxy-source').props.value).toBe('direct')
    expect(
      components(render(), SelectItem).some((node) => node.props.value === 'provider'),
    ).toBe(false)
    await submit()
    expect(vi.mocked(props.onSave).mock.lastCall?.[0].proxyMode).toBe('direct')
  },
)

it('preserves a verified external name longer than the built-in name limit when editing', async () => {
  const name = 'Official name '.repeat(6).trim()
  props.connection = browserConnection({ id: 'bit', providerId: 'bitbrowser' })
  props.window = browserWindow({ connectionId: 'bit', providerId: 'bitbrowser', name })
  expect(
    components(render(), Input).find((node) => node.props.id === 'window-name')!.props
      .maxLength,
  ).toBe(100)
  await submit()
  expect(vi.mocked(props.onSave).mock.lastCall?.[0].name).toBe(name)
})

it.each(['manual', 'plugin'] as const)(
  'preserves geoip, timezone and locale when changing %s to Provider',
  async (proxyMode) => {
    props.connection = browserConnection({ id: 'bit', providerId: 'bitbrowser' })
    props.window = browserWindow({
      connectionId: 'bit',
      providerId: 'bitbrowser',
      proxyMode,
      proxy: proxyMode === 'manual' ? 'https://proxy.test:8443' : null,
      proxyPlugin: proxyMode === 'plugin' ? 'studio.proxy-pool' : null,
      settings: {
        ...browserWindow().settings,
        geoip: true,
        timezone: 'America/New_York',
        locale: 'en-US',
      },
    })
    select('window-proxy-source').props.onValueChange?.('provider')
    await submit()
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith({
      name: props.window.name,
      proxyMode: 'provider',
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      settings: props.window.settings,
      groupId: props.window.groupId,
    })
  },
)

it('freezes generated blank name and seed for an unchanged draft retry', async () => {
  render()
  input('window-seed', '')
  const names = vi.spyOn(random, 'randomWindowName').mockReturnValue('first-name')
  const seeds = vi.spyOn(random, 'randomFingerprintSeed').mockReturnValue(123)
  vi.mocked(props.onSave).mockRejectedValueOnce(new Error('response lost'))
  await submit()
  const first = vi.mocked(props.onSave).mock.calls[0]![0]
  names.mockReturnValue('different-name')
  seeds.mockReturnValue(456)
  await submit()
  expect(props.onSave).toHaveBeenNthCalledWith(2, first)
  expect(first.name).toBe('first-name')
  expect(first.settings.fingerprintSeed).toBe(123)
  expect(names).toHaveBeenCalledOnce()
  expect(seeds).toHaveBeenCalledOnce()
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
      expect(vi.mocked(props.onSave).mock.calls[0]![0]).toHaveProperty(
        'kernelVersion',
        null,
      )
      components(renderField(), Select)[0]!.props.onValueChange?.('155.0.8059.39.1')
      await submit()
      expect(vi.mocked(props.onSave).mock.calls[1]![0]).toHaveProperty(
        'kernelVersion',
        '155.0.8059.39.1',
      )
      components(renderField(), Select)[0]!.props.onValueChange?.('latest')
      await submit()
      expect(vi.mocked(props.onSave).mock.calls[2]![0]).toHaveProperty(
        'kernelVersion',
        null,
      )
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
    expect(
      vi
        .mocked(props.onSave)
        .mock.calls.every(
          ([input]) => 'kernelVersion' in input && input.kernelVersion === null,
        ),
    ).toBe(true)
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
    expect(vi.mocked(props.onSave).mock.calls[0]![0]).toHaveProperty(
      'kernelVersion',
      '155.0.8059.39.2',
    )
    expect(getKernelStatus).toHaveBeenCalledTimes(3)
  })

  it('does not fetch inventory or expose a selector when editing a fixed binding', async () => {
    props.window = browserWindow()
    await mount()
    expect(components(render(), WindowKernelField)).toHaveLength(0)
    expect(getKernelStatus).not.toHaveBeenCalled()
    await submit()
    expect(vi.mocked(props.onSave).mock.calls[0]![0]).not.toHaveProperty('kernelVersion')
    expect(vi.mocked(props.onSave).mock.calls[0]![0].settings.fingerprintSeed).toBe(42)
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

it('creates external windows without builtin activation, kernel inventory or fake seeds', async () => {
  props.connection = browserConnection({
    id: 'ads-1',
    providerId: 'adspower',
    capabilities: {
      ...browserConnection().capabilities,
      kernelSelection: false,
      fingerprintSeed: false,
    },
  })
  props.licenseStatus = null
  render()
  editorHooks.flushEffects()
  await flushPromises()
  expect(components(render(), WindowKernelField)).toHaveLength(0)
  expect(
    components(render(), Input).some((node) => node.props.id === 'window-seed'),
  ).toBe(false)
  await submit()
  expect(vi.mocked(props.onSave).mock.calls[0]![0]).toMatchObject({
    proxyMode: 'direct',
    kernelVersion: null,
    settings: { fingerprintSeed: null, geoip: false },
  })
})

it('saves local metadata without resolving or rewriting an external read-only proxy', async () => {
  props.connection = browserConnection({
    id: 'ads',
    providerId: 'adspower',
    capabilities: {
      ...browserConnection().capabilities,
      update: false,
      kernelSelection: false,
      fingerprintSeed: false,
    },
  })
  props.window = browserWindow({
    connectionId: 'ads',
    providerId: 'adspower',
    proxyMode: 'plugin',
    proxyPlugin: 'studio.proxy-pool',
    proxyEndpoint: null,
    kernelVersion: 'vendor-managed',
  })
  render()
  editorHooks.flushEffects()
  await flushPromises()
  await submit()
  expect(props.onSave).toHaveBeenCalledWith({
    name: props.window.name,
    proxyMode: 'plugin',
    proxy: null,
    proxyPlugin: 'studio.proxy-pool',
    proxyEndpoint: null,
    settings: props.window.settings,
    groupId: null,
  })
})

it.each(['running', 'unknown', 'missing'] as const)(
  'preserves remote configuration and saves only metadata when state is %s',
  async (windowState) => {
    props.window = browserWindow({ state: windowState })
    render()
    editorHooks.flushEffects()
    await flushPromises()
    expect(
      components(render(), Input).find((node) => node.props.id === 'window-name')!.props
        .disabled,
    ).toBe(true)
    components(render(), Input)
      .find((node) => node.props.id === 'window-note')!
      .props.onChange?.({ target: { value: 'offline note' } } as never)
    await submit()
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith({
      name: props.window.name,
      proxyMode: props.window.proxyMode,
      proxy: props.window.proxy,
      proxyPlugin: props.window.proxyPlugin,
      proxyEndpoint: props.window.proxyEndpoint,
      settings: { ...props.window.settings, note: 'offline note' },
      groupId: props.window.groupId,
    })
  },
)

it('does not offer AdsPower plugin proxies or unsafe remote edits when capabilities are false', async () => {
  props.connection = browserConnection({
    id: 'ads',
    providerId: 'adspower',
    capabilities: {
      ...browserConnection().capabilities,
      update: false,
      proxyPlugin: false,
      kernelSelection: false,
      fingerprintSeed: false,
    },
  })
  props.licenseStatus = null
  render()
  expect(
    components(render(), SelectItem).some((node) => node.props.value === 'plugin'),
  ).toBe(false)
  props.window = browserWindow({
    providerId: 'adspower',
    connectionId: 'ads',
    proxyMode: 'provider',
  })
  editorHooks.dispose()
  editorHooks = new KernelHookHarness(state)
  render()
  expect(
    components(render(), Input).find((node) => node.props.id === 'window-name')!.props
      .disabled,
  ).toBe(true)
  expect(text(render())).toContain('仅可修改 Nexus 平台、备注和分组')
})
