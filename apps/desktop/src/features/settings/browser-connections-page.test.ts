import type { ComponentProps, DependencyList, EffectCallback, FormEvent } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectItem } from '@/components/ui/select'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from './kernel-test-support'
import {
  activateBrowserConnection,
  confirmBrowserConnection,
  listBrowserProviderGroups,
  probeBrowserConnection,
  saveBrowserConnection,
} from '@/lib/platform/browser-connections'
import { browserConnection } from '@/lib/platform/browser-test-support'
import { BrowserConnectionEditor } from './browser-connections-page'

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
vi.mock('@/lib/platform/browser-connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/browser-connections')>()),
  listBrowserProviderGroups: vi.fn(),
  probeBrowserConnection: vi.fn(),
  saveBrowserConnection: vi.fn(),
  confirmBrowserConnection: vi.fn(),
  activateBrowserConnection: vi.fn(),
}))

let hooks: KernelHookHarness
let props: ComponentProps<typeof BrowserConnectionEditor>
const render = () => hooks.render(() => BrowserConnectionEditor(props))
function action(label: string) {
  return components(render(), Button).find((node) => text(node.props.children) === label)!
    .props
}
async function click(label: string) {
  action(label).onClick?.({} as never)
  await flushPromises()
}
async function submit() {
  const form = elements(render()).find((node) => node.type === 'form')!
  ;(form.props.onSubmit as (event: FormEvent) => void)({
    preventDefault() {},
  } as FormEvent)
  await flushPromises()
}
beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  props = {
    connection: browserConnection({
      id: 'ads',
      providerId: 'adspower',
      enabled: false,
      scopeConfirmed: false,
      name: 'Team',
      endpoint: 'http://localhost:50325',
      scopeLabel: 'My team',
    }),
    onUpdated: vi.fn(),
    onClose: vi.fn(),
  }
  vi.mocked(listBrowserProviderGroups).mockResolvedValue([
    { id: 'official-group', name: 'Official team' },
  ])
  vi.mocked(probeBrowserConnection).mockResolvedValue({
    connected: true,
    message: '已连接',
    scopeId: null,
    capabilities: browserConnection().capabilities,
  })
  vi.mocked(saveBrowserConnection).mockResolvedValue(props.connection!)
})
afterEach(() => hooks.dispose())

it('loads official groups from the selected connection and saves only the new input fields', async () => {
  render()
  hooks.flushEffects()
  await flushPromises()
  expect(listBrowserProviderGroups).toHaveBeenCalledExactlyOnceWith('ads')
  expect(
    components(render(), SelectItem).some(
      (node) => node.props.value === 'official-group',
    ),
  ).toBe(true)
  components(render(), Select)[1]!.props.onValueChange?.('official-group')
  expect(action('检测连接').disabled).toBe(true)
  await submit()
  expect(saveBrowserConnection).toHaveBeenCalledExactlyOnceWith({
    id: 'ads',
    providerId: 'adspower',
    name: 'Team',
    endpoint: 'http://localhost:50325',
    apiKey: null,
    defaultGroupId: 'official-group',
    scopeLabel: 'My team',
  })
  expect(props.onUpdated).toHaveBeenCalledWith(props.connection)
})

it('requires a successful current probe before confirming scope and an explicit activation afterwards', async () => {
  render()
  hooks.flushEffects()
  expect(action('确认作用域').disabled).toBe(true)
  expect(action('启用此接入').disabled).toBe(true)
  await click('检测连接')
  expect(action('确认作用域').disabled).toBe(false)
  expect(text(render())).toContain('官方未提供作用域 ID')
  const confirmed = browserConnection({ ...props.connection!, scopeConfirmed: true })
  vi.mocked(confirmBrowserConnection).mockResolvedValueOnce(confirmed)
  await click('确认作用域')
  expect(confirmBrowserConnection).toHaveBeenCalledExactlyOnceWith('ads', 'My team')
  props.connection = confirmed
  render()
  vi.mocked(activateBrowserConnection).mockResolvedValueOnce({
    ...confirmed,
    enabled: true,
  })
  await click('启用此接入')
  expect(activateBrowserConnection).toHaveBeenCalledExactlyOnceWith('ads')
})

it('invalidates probing and scope confirmation when an unsaved field changes', async () => {
  render()
  hooks.flushEffects()
  await click('检测连接')
  const input = components(render(), Input).find(
    (node) => node.props.id === 'connection-endpoint',
  )!
  input.props.onChange?.({ target: { value: 'http://localhost:5555' } } as never)
  expect(action('确认作用域').disabled).toBe(true)
  expect(action('启用此接入').disabled).toBe(true)
  expect(action('检测连接').disabled).toBe(true)
  await click('确认作用域')
  expect(confirmBrowserConnection).not.toHaveBeenCalled()
})

it('does not apply an old probe response after switching to another saved connection', async () => {
  const probe = deferred<Awaited<ReturnType<typeof probeBrowserConnection>>>()
  vi.mocked(probeBrowserConnection).mockReturnValueOnce(probe.promise)
  render()
  hooks.flushEffects()
  action('检测连接').onClick?.({} as never)
  props.connection = browserConnection({ id: 'bit', providerId: 'bitbrowser' })
  render()
  hooks.flushEffects()
  probe.resolve({
    connected: true,
    message: 'stale Ads response',
    scopeId: 'old-team',
    capabilities: browserConnection().capabilities,
  })
  await flushPromises()
  expect(text(render())).not.toContain('stale Ads response')
  expect(props.onUpdated).not.toHaveBeenCalled()
})

it('retains saved group selection and editable fields when group discovery is offline', async () => {
  props.connection = { ...props.connection!, defaultGroupId: 'saved-group' }
  vi.mocked(listBrowserProviderGroups).mockRejectedValueOnce({
    code: 'unavailable',
    message: 'API offline',
    retryable: true,
  })
  render()
  hooks.flushEffects()
  await flushPromises()
  expect(text(render())).toContain('API offline')
  expect(
    components(render(), SelectItem).some((node) => node.props.value === 'saved-group'),
  ).toBe(true)
  await submit()
  expect(vi.mocked(saveBrowserConnection).mock.calls[0]![0].defaultGroupId).toBe(
    'saved-group',
  )
})
