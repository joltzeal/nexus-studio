import type { ComponentProps, DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { Select, SelectItem, SelectTrigger } from '@/components/ui/select'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { browserCreateInput, browserWindow } from '@/lib/platform/browser-test-support'
import { discoverBrowserProfiles } from '@/lib/platform/browser-connections'
import {
  listBrowserOperations,
  reconcileBrowserOperation,
  resolveBrowserOperation,
} from '@/lib/platform/windows'
import {
  BrowserOperationRecovery,
  BrowserOperationResolutionDialog,
} from './browser-operation-recovery'

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
vi.mock('@/lib/platform/windows', () => ({
  listBrowserOperations: vi.fn(),
  reconcileBrowserOperation: vi.fn(),
  resolveBrowserOperation: vi.fn(),
}))
vi.mock('@/lib/platform/browser-connections', () => ({
  discoverBrowserProfiles: vi.fn(),
}))
const id = browserCreateInput().operationId
const operation = {
  id,
  windowId: 'window-1',
  connectionId: 'ads',
  kind: 'create',
  phase: 'uncertain',
  message: 'response lost',
  createdAt: 1,
  updatedAt: 2,
}
let hooks: KernelHookHarness
let dialogHooks: KernelHookHarness | null
let props: ComponentProps<typeof BrowserOperationRecovery>
let dialogProps: ComponentProps<typeof BrowserOperationResolutionDialog>
const render = () => hooks.render(() => BrowserOperationRecovery(props))
const renderDialog = () =>
  dialogHooks!.render(() => BrowserOperationResolutionDialog(dialogProps))
function button(tree: ReturnType<typeof render>, label: string) {
  return components(tree, Button).find((node) => text(node.props.children) === label)
}
function selectControl(label: string) {
  return components(renderDialog(), Select).find((node) =>
    components(node, SelectTrigger).some(
      (trigger) => trigger.props['aria-label'] === label,
    ),
  )!
}
async function openManual() {
  const manual = button(render(), '手动处理')
  expect(manual).toBeDefined()
  manual!.props.onClick?.({} as never)
  const dialog = components(render(), BrowserOperationResolutionDialog)[0]
  expect(dialog).toBeDefined()
  dialogProps = dialog!.props
  dialogHooks = new KernelHookHarness(state)
  renderDialog()
  dialogHooks.flushEffects()
  await flushPromises()
}
function selectProfile(id: string) {
  selectControl('选择官方环境').props.onValueChange?.(id)
}
function selectAction(action: 'associate' | 'abandon') {
  selectControl('处理方式').props.onValueChange?.(action)
  renderDialog()
  dialogHooks!.flushEffects()
}
function confirmResolution() {
  components(renderDialog(), Checkbox)[0]!.props.onCheckedChange?.(true)
}
function submitResolution() {
  button(renderDialog(), '确认处理')!.props.onClick?.({} as never)
}
async function mount() {
  render()
  hooks.flushEffects()
  await flushPromises()
}
beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  dialogHooks = null
  props = {
    connectionId: 'ads',
    providerId: 'adspower',
    refreshKey: 0,
    onRecovered: vi.fn(),
  }
  vi.mocked(listBrowserOperations).mockResolvedValue([operation])
  vi.mocked(discoverBrowserProfiles).mockResolvedValue([
    {
      id: 'official-1',
      name: 'same name',
      kernelVersion: null,
      createdAt: null,
      providerConfig: {},
    },
    {
      id: 'official-2',
      name: 'same name',
      kernelVersion: null,
      createdAt: null,
      providerConfig: {},
    },
  ])
})
afterEach(() => {
  hooks.dispose()
  dialogHooks?.dispose()
})

it('associates only a selected official environment after explicit confirmation', async () => {
  await mount()
  await openManual()
  expect(discoverBrowserProfiles).toHaveBeenCalledExactlyOnceWith('ads')
  expect(text(renderDialog())).toContain(operation.windowId)
  expect(text(renderDialog())).toContain('官方环境的当前配置')
  expect(text(renderDialog())).toContain('沿用浏览器设置')
  expect(selectControl('选择官方环境').props.value).toBe('')
  confirmResolution()
  submitResolution()
  expect(resolveBrowserOperation).not.toHaveBeenCalled()
  selectProfile('official-2')
  submitResolution()
  expect(resolveBrowserOperation).not.toHaveBeenCalled()
  confirmResolution()
  const result = browserWindow({
    id: operation.windowId,
    connectionId: 'ads',
    providerId: 'adspower',
    providerProfileId: 'official-2',
    proxyMode: 'provider',
  })
  vi.mocked(resolveBrowserOperation).mockResolvedValueOnce(result)
  submitResolution()
  await flushPromises()
  expect(resolveBrowserOperation).toHaveBeenCalledExactlyOnceWith({
    id,
    action: 'associate',
    providerProfileId: 'official-2',
    confirmed: true,
  })
  expect(props.onRecovered).toHaveBeenCalledExactlyOnceWith(result)
  expect(reconcileBrowserOperation).not.toHaveBeenCalled()
  expect(components(render(), BrowserOperationResolutionDialog)).toHaveLength(0)
  hooks.flushEffects()
  await flushPromises()
  expect(listBrowserOperations).toHaveBeenCalledTimes(2)
})

it.each(['create', 'start', 'stop', 'update', 'delete'])(
  'allows explicitly abandoning an uncertain external %s operation',
  async (kind) => {
    vi.mocked(listBrowserOperations).mockResolvedValue([{ ...operation, kind }])
    await mount()
    await openManual()
    if (kind === 'create') selectAction('abandon')
    expect(text(renderDialog())).toContain('原操作不能自动重试')
    expect(text(renderDialog())).toContain('不会发送')
    expect(text(renderDialog())).toContain('官方应用')
    if (kind === 'update')
      expect(text(renderDialog())).toContain('重新采用官方环境的当前设置')
    submitResolution()
    expect(resolveBrowserOperation).not.toHaveBeenCalled()
    confirmResolution()
    vi.mocked(resolveBrowserOperation).mockResolvedValueOnce(null)
    submitResolution()
    await flushPromises()
    expect(resolveBrowserOperation).toHaveBeenCalledExactlyOnceWith({
      id,
      action: 'abandon',
      confirmed: true,
    })
    expect(props.onRecovered).toHaveBeenCalledExactlyOnceWith(null)
    expect(reconcileBrowserOperation).not.toHaveBeenCalled()
    if (kind !== 'create') expect(discoverBrowserProfiles).not.toHaveBeenCalled()
  },
)

it.each(['start', 'stop'])('allows only abandonment for built-in %s', async (kind) => {
  props.providerId = 'cloakbrowser'
  vi.mocked(listBrowserOperations).mockResolvedValue([
    { ...operation, kind, phase: 'submitted' },
  ])
  await mount()
  await openManual()
  expect(
    components(renderDialog(), SelectItem).some(
      (node) => node.props.value === 'associate',
    ),
  ).toBe(false)
  expect(discoverBrowserProfiles).not.toHaveBeenCalled()
  confirmResolution()
  vi.mocked(resolveBrowserOperation).mockResolvedValueOnce(browserWindow())
  submitResolution()
  await flushPromises()
  expect(resolveBrowserOperation).toHaveBeenCalledExactlyOnceWith({
    id,
    action: 'abandon',
    confirmed: true,
  })
})

it.each(['create', 'update', 'delete'])(
  'keeps built-in %s recheck-only',
  async (kind) => {
    props.providerId = 'cloakbrowser'
    vi.mocked(listBrowserOperations).mockResolvedValue([{ ...operation, kind }])
    await mount()
    expect(button(render(), '手动处理')).toBeUndefined()
    expect(button(render(), '重新核对操作')).toBeDefined()
  },
)

it.each(['prepared', 'confirmed'])('keeps a %s operation recheck-only', async (phase) => {
  vi.mocked(listBrowserOperations).mockResolvedValue([{ ...operation, phase }])
  await mount()
  expect(button(render(), '手动处理')).toBeUndefined()
  expect(button(render(), '重新核对操作')).toBeDefined()
})

it('offers both explicit resolution actions for a submitted BitBrowser create', async () => {
  props.providerId = 'bitbrowser'
  vi.mocked(listBrowserOperations).mockResolvedValue([
    { ...operation, phase: 'submitted' },
  ])
  await mount()
  await openManual()
  expect(components(renderDialog(), SelectItem).map((node) => node.props.value)).toEqual(
    expect.arrayContaining(['associate', 'abandon', 'official-1', 'official-2']),
  )
})

it('excludes cancelled operations from pending recovery and retry controls', async () => {
  vi.mocked(listBrowserOperations).mockResolvedValue([
    { ...operation, phase: 'cancelled' },
  ])
  await mount()
  expect(render()).toBeNull()
  expect(resolveBrowserOperation).not.toHaveBeenCalled()
})

it('keeps the operation and selection on a failed resolution and blocks duplicate pending submissions', async () => {
  await mount()
  await openManual()
  selectProfile('official-1')
  confirmResolution()
  const result = deferred<Awaited<ReturnType<typeof resolveBrowserOperation>>>()
  vi.mocked(resolveBrowserOperation).mockReturnValueOnce(result.promise)
  const submit = button(renderDialog(), '确认处理')!.props.onClick!
  submit({} as never)
  submit({} as never)
  expect(resolveBrowserOperation).toHaveBeenCalledTimes(1)
  expect(button(renderDialog(), '正在处理…')!.props.disabled).toBe(true)
  expect(components(renderDialog(), Checkbox)[0]!.props.disabled).toBe(true)
  button(renderDialog(), '取消')!.props.onClick?.({} as never)
  components(renderDialog(), Dialog)[0]!.props.onOpenChange?.(false)
  expect(components(render(), BrowserOperationResolutionDialog)).toHaveLength(1)
  const preventDefault = vi.fn()
  components(renderDialog(), DialogContent)[0]!.props.onEscapeKeyDown?.({
    preventDefault,
  } as never)
  expect(preventDefault).toHaveBeenCalledOnce()
  result.reject({
    code: 'operation_uncertain',
    message: '请重新核对当前状态',
    retryable: false,
  })
  await flushPromises()
  expect(components(renderDialog(), FieldError).map((node) => text(node))).toContain(
    '请重新核对当前状态',
  )
  expect(selectControl('选择官方环境').props.value).toBe('official-1')
  expect(props.onRecovered).not.toHaveBeenCalled()
  expect(button(renderDialog(), '确认处理')!.props.disabled).toBe(false)
  vi.mocked(resolveBrowserOperation).mockResolvedValueOnce(
    browserWindow({
      id: operation.windowId,
      connectionId: 'ads',
      providerId: 'adspower',
      providerProfileId: 'official-1',
      proxyMode: 'provider',
    }),
  )
  submitResolution()
  await flushPromises()
  expect(resolveBrowserOperation).toHaveBeenNthCalledWith(2, {
    id,
    action: 'associate',
    providerProfileId: 'official-1',
    confirmed: true,
  })
})

it.each([
  null,
  browserWindow({
    id: 'other-window',
    connectionId: 'ads',
    providerId: 'adspower',
    providerProfileId: 'official-1',
  }),
])(
  'does not report association success for a result that loses the reserved identity',
  async (result) => {
    await mount()
    await openManual()
    selectProfile('official-1')
    confirmResolution()
    vi.mocked(resolveBrowserOperation).mockResolvedValueOnce(result)
    submitResolution()
    await flushPromises()
    expect(props.onRecovered).not.toHaveBeenCalled()
    expect(components(renderDialog(), FieldError)).toHaveLength(1)
    expect(components(render(), BrowserOperationResolutionDialog)).toHaveLength(1)
  },
)

it('keeps discovery failures inline and requires a fresh selection and confirmation after reload', async () => {
  vi.mocked(discoverBrowserProfiles).mockRejectedValueOnce(new Error('官方环境读取失败'))
  await mount()
  await openManual()
  expect(text(renderDialog())).toContain('官方环境读取失败')
  confirmResolution()
  submitResolution()
  expect(resolveBrowserOperation).not.toHaveBeenCalled()
  button(renderDialog(), '重新读取环境')!.props.onClick?.({} as never)
  renderDialog()
  dialogHooks!.flushEffects()
  await flushPromises()
  selectProfile('official-2')
  expect(components(renderDialog(), Checkbox)[0]!.props.checked).toBe(false)
  expect(button(renderDialog(), '确认处理')!.props.disabled).toBe(true)
})

it('requires fresh discovery and confirmation when switching back to association', async () => {
  await mount()
  await openManual()
  selectProfile('official-1')
  confirmResolution()
  selectAction('abandon')
  confirmResolution()
  const discovery = deferred<Awaited<ReturnType<typeof discoverBrowserProfiles>>>()
  vi.mocked(discoverBrowserProfiles).mockReturnValueOnce(discovery.promise)
  selectAction('associate')
  expect(text(renderDialog())).toContain('正在读取官方环境')
  expect(selectControl('选择官方环境').props.value).toBe('')
  expect(components(renderDialog(), Checkbox)[0]!.props.checked).toBe(false)
  submitResolution()
  expect(resolveBrowserOperation).not.toHaveBeenCalled()
  discovery.resolve([])
  await flushPromises()
  expect(text(renderDialog())).toContain('没有可选择的官方环境')
})

it('ignores resolution results from an older connection', async () => {
  await mount()
  await openManual()
  selectProfile('official-1')
  confirmResolution()
  const result = deferred<Awaited<ReturnType<typeof resolveBrowserOperation>>>()
  vi.mocked(resolveBrowserOperation).mockReturnValueOnce(result.promise)
  submitResolution()
  props.connectionId = 'bit'
  props.providerId = 'bitbrowser'
  render()
  hooks.flushEffects()
  expect(components(render(), BrowserOperationResolutionDialog)).toHaveLength(0)
  result.resolve(
    browserWindow({
      id: operation.windowId,
      connectionId: 'ads',
      providerId: 'adspower',
      providerProfileId: 'official-1',
      proxyMode: 'provider',
    }),
  )
  await flushPromises()
  expect(props.onRecovered).not.toHaveBeenCalled()
})

it('rejects stale discovered profiles after the dialog scope changes', async () => {
  const old = deferred<Awaited<ReturnType<typeof discoverBrowserProfiles>>>()
  vi.mocked(discoverBrowserProfiles).mockReturnValueOnce(old.promise)
  await mount()
  await openManual()
  expect(text(renderDialog())).toContain('正在读取官方环境')
  dialogProps = {
    ...dialogProps,
    connectionId: 'bit',
    providerId: 'bitbrowser',
    operation: {
      ...operation,
      id: '15b41684-b179-46c9-a1b8-e1b66812dc34',
      connectionId: 'bit',
    },
  }
  renderDialog()
  dialogHooks!.flushEffects()
  await flushPromises()
  old.resolve([
    {
      id: 'stale-profile',
      name: 'previous account',
      kernelVersion: null,
      createdAt: null,
      providerConfig: {},
    },
  ])
  await flushPromises()
  expect(text(renderDialog())).not.toContain('previous account')
  selectProfile('stale-profile')
  confirmResolution()
  submitResolution()
  expect(resolveBrowserOperation).not.toHaveBeenCalled()
})

it('keeps a rejected abandonment inline when the backend cannot verify current state', async () => {
  vi.mocked(listBrowserOperations).mockResolvedValue([{ ...operation, kind: 'stop' }])
  await mount()
  await openManual()
  confirmResolution()
  vi.mocked(resolveBrowserOperation).mockRejectedValueOnce({
    code: 'operation_uncertain',
    message: '当前状态未知，暂不能放弃',
    retryable: false,
  })
  submitResolution()
  await flushPromises()
  expect(text(renderDialog())).toContain('当前状态未知，暂不能放弃')
  expect(text(renderDialog())).toContain(id)
  expect(props.onRecovered).not.toHaveBeenCalled()
  expect(components(render(), BrowserOperationResolutionDialog)).toHaveLength(1)
  expect(resolveBrowserOperation).toHaveBeenCalledExactlyOnceWith({
    id,
    action: 'abandon',
    confirmed: true,
  })
})

it('recovers a persisted operation UUID and refreshes only a confirmed result', async () => {
  await mount()
  vi.mocked(reconcileBrowserOperation).mockResolvedValueOnce(browserWindow())
  components(render(), Button)[0]!.props.onClick?.({} as never)
  await flushPromises()
  expect(reconcileBrowserOperation).toHaveBeenCalledExactlyOnceWith(id)
  expect(props.onRecovered).toHaveBeenCalledExactlyOnceWith(browserWindow())
  expect(listBrowserOperations).toHaveBeenCalledExactlyOnceWith('ads')
})

it('refreshes a completed delete recovery without a false error when its result is null', async () => {
  vi.mocked(listBrowserOperations).mockResolvedValueOnce([
    { ...operation, kind: 'delete' },
  ])
  await mount()
  vi.mocked(reconcileBrowserOperation).mockResolvedValueOnce(null)
  vi.mocked(listBrowserOperations).mockResolvedValueOnce([
    { ...operation, kind: 'delete', phase: 'committed' },
  ])
  components(render(), Button)[0]!.props.onClick?.({} as never)
  await flushPromises()
  expect(props.onRecovered).toHaveBeenCalledExactlyOnceWith(null)
  expect(text(render())).not.toContain('尚未确认成功')
  render()
  hooks.flushEffects()
  await flushPromises()
  expect(listBrowserOperations).toHaveBeenCalledTimes(2)
  expect(render()).toBeNull()
})

it('keeps a structured uncertain result visible without refreshing it as success', async () => {
  await mount()
  vi.mocked(reconcileBrowserOperation).mockRejectedValueOnce({
    code: 'operation_uncertain',
    message: '环境结果尚未确认，请继续核对',
    retryable: false,
  })
  components(render(), Button)[0]!.props.onClick?.({} as never)
  await flushPromises()
  expect(props.onRecovered).not.toHaveBeenCalled()
  expect(text(render())).toContain('环境结果尚未确认')
  expect(text(render())).toContain('结果待核对')
})

it('ignores a delayed recovery after the active connection changes', async () => {
  await mount()
  const recovery = deferred<Awaited<ReturnType<typeof reconcileBrowserOperation>>>()
  vi.mocked(reconcileBrowserOperation).mockReturnValueOnce(recovery.promise)
  components(render(), Button)[0]!.props.onClick?.({} as never)
  props.connectionId = 'bit'
  render()
  hooks.flushEffects()
  recovery.resolve(browserWindow())
  await flushPromises()
  expect(props.onRecovered).not.toHaveBeenCalled()
})
