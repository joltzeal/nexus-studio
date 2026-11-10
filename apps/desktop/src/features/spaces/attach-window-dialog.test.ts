import type { ComponentProps, DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import {
  attachBrowserWindows,
  discoverBrowserProfiles,
} from '@/lib/platform/browser-connections'
import { browserConnection, browserWindow } from '@/lib/platform/browser-test-support'
import { AttachWindowDialog } from './attach-window-dialog'

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
  discoverBrowserProfiles: vi.fn(),
  attachBrowserWindows: vi.fn(),
}))

let hooks: KernelHookHarness
let props: ComponentProps<typeof AttachWindowDialog>
const render = () => hooks.render(() => AttachWindowDialog(props))
const remote = (id: string) => ({
  id,
  name: `remote-${id}`,
  kernelVersion: null,
  createdAt: null,
  providerConfig: {},
})
async function mount() {
  render()
  hooks.flushEffects()
  await flushPromises()
}
beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  props = {
    connection: browserConnection({
      id: 'ads',
      providerId: 'adspower',
      capabilities: { ...browserConnection().capabilities, attach: true },
    }),
    onAttached: vi.fn(),
    onClose: vi.fn(),
  }
  vi.mocked(discoverBrowserProfiles).mockResolvedValue([remote('a'), remote('b')])
  vi.mocked(attachBrowserWindows).mockResolvedValue([
    browserWindow({ origin: 'attached', proxyMode: 'provider' }),
  ])
})
afterEach(() => hooks.dispose())

it('attaches only explicitly selected official environments and preserves full returned windows', async () => {
  await mount()
  components(render(), Checkbox)[1]!.props.onCheckedChange?.(true)
  components(render(), Button)
    .find((node) => text(node.props.children) === '接入 1 个窗口')!
    .props.onClick?.({} as never)
  await flushPromises()
  expect(attachBrowserWindows).toHaveBeenCalledExactlyOnceWith('ads', ['b'])
  expect(props.onAttached).toHaveBeenCalledWith([
    expect.objectContaining({ origin: 'attached', proxyMode: 'provider' }),
  ])
})

it('rejects an old discovery response and clears selection on a connection switch', async () => {
  const old = deferred<Awaited<ReturnType<typeof discoverBrowserProfiles>>>()
  vi.mocked(discoverBrowserProfiles).mockReturnValueOnce(old.promise)
  render()
  hooks.flushEffects()
  props.connection = { ...props.connection, id: 'bit', providerId: 'bitbrowser' }
  render()
  hooks.flushEffects()
  await flushPromises()
  old.resolve([remote('old')])
  await flushPromises()
  expect(text(render())).not.toContain('remote-old')
  expect(
    components(render(), Checkbox).every((node) => node.props.checked === false),
  ).toBe(true)
})

it('does not reuse a previous selection while reloading or after discovery fails', async () => {
  await mount()
  components(render(), Checkbox)[0]!.props.onCheckedChange?.(true)
  vi.mocked(discoverBrowserProfiles).mockRejectedValueOnce(new Error('offline'))
  components(render(), Button)
    .find((node) => text(node.props.children) === '重新读取')!
    .props.onClick?.({} as never)
  render()
  hooks.flushEffects()
  await flushPromises()
  expect(text(render())).toContain('offline')
  expect(
    components(render(), Button).find(
      (node) => text(node.props.children) === '接入 0 个窗口',
    )!.props.disabled,
  ).toBe(true)
  expect(attachBrowserWindows).not.toHaveBeenCalled()
})
