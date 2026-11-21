import type { ComponentProps, DependencyList, EffectCallback, FormEvent } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  vi.mocked(saveBrowserConnection).mockResolvedValue(props.connection!)
})
afterEach(() => hooks.dispose())

it('connects in one action and hides internal account-scope terminology', async () => {
  render()
  hooks.flushEffects()
  const connected = { ...props.connection!, scopeConfirmed: true, enabled: true }
  vi.mocked(confirmBrowserConnection).mockResolvedValueOnce({
    ...connected,
    enabled: false,
  })
  vi.mocked(activateBrowserConnection).mockResolvedValueOnce(connected)
  expect(text(render())).not.toContain('账户 / 工作区名称')
  expect(text(render())).not.toContain('确认作用域')
  await submit()
  expect(confirmBrowserConnection).toHaveBeenCalledExactlyOnceWith('ads', 'My team')
  expect(activateBrowserConnection).toHaveBeenCalledExactlyOnceWith('ads')
  expect(props.onUpdated).toHaveBeenCalledExactlyOnceWith(connected)
})

it('uses defaults for a new provider and does not ask BitBrowser for an unsupported API key', () => {
  props.connection = null
  props.initialProvider = 'bitbrowser'
  const tree = render()
  expect(
    components(tree, Input).find((node) => node.props.id === 'connection-endpoint')?.props
      .value,
  ).toBe('http://127.0.0.1:54345')
  expect(components(tree, Input).some((node) => node.props.id === 'connection-key')).toBe(
    false,
  )
})

it('remembers the saved connection after an offline failure and retries without creating another identity', async () => {
  props.connection = null
  const saved = browserConnection({
    id: 'new-ads',
    providerId: 'adspower',
    scopeLabel: 'AdsPower',
  })
  vi.mocked(saveBrowserConnection).mockResolvedValue(saved)
  vi.mocked(confirmBrowserConnection).mockRejectedValueOnce(new Error('API offline'))
  render()
  hooks.flushEffects()
  await submit()
  expect(text(render())).toContain('API offline')
  expect(activateBrowserConnection).not.toHaveBeenCalled()
  vi.mocked(confirmBrowserConnection).mockResolvedValueOnce(saved)
  vi.mocked(activateBrowserConnection).mockResolvedValueOnce(saved)
  await submit()
  expect(saveBrowserConnection).toHaveBeenCalledTimes(1)
  expect(vi.mocked(confirmBrowserConnection).mock.calls.map((call) => call[0])).toEqual([
    'new-ads',
    'new-ads',
  ])
})

it('ignores repeat clicks while connecting and retains input on save failure', async () => {
  const saving = deferred<Awaited<ReturnType<typeof saveBrowserConnection>>>()
  vi.mocked(saveBrowserConnection).mockReturnValueOnce(saving.promise)
  render()
  hooks.flushEffects()
  components(render(), Input)
    .find((node) => node.props.id === 'connection-endpoint')!
    .props.onChange?.({
      target: { value: 'http://localhost:5555' },
    } as never)
  const form = elements(render()).find((node) => node.type === 'form')!
  const handler = form.props.onSubmit as (event: FormEvent) => void
  handler({ preventDefault() {} } as FormEvent)
  handler({ preventDefault() {} } as FormEvent)
  expect(saveBrowserConnection).toHaveBeenCalledTimes(1)
  expect(action('连接中…').disabled).toBe(true)
  saving.reject(new Error('disk full'))
  await flushPromises()
  expect(text(render())).toContain('disk full')
  expect(
    components(render(), Input).find((node) => node.props.id === 'connection-endpoint')
      ?.props.value,
  ).toBe('http://localhost:5555')
  expect(props.onUpdated).not.toHaveBeenCalled()
})
