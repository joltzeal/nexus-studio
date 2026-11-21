import type { DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { browserConnection } from '@/lib/platform/browser-test-support'
import { listBrowserConnections, setManagedCloakBrowser } from '@/lib/platform/browser-connections'
import { components, deferred, flushPromises, KernelHookHarness, text } from './kernel-test-support'
import { LabPage } from './lab-page'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('@/lib/platform/windows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/windows')>()),
  browserWindowsAvailable: () => true,
}))
vi.mock('@/lib/platform/browser-connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/browser-connections')>()),
  listBrowserConnections: vi.fn(),
  setManagedCloakBrowser: vi.fn(),
}))

let hooks: KernelHookHarness
const render = () => hooks.render(LabPage)
const toggle = () => components(render(), Switch)[0]!.props

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', new EventTarget())
  hooks = new KernelHookHarness(state)
})
afterEach(() => {
  hooks.dispose()
  vi.unstubAllGlobals()
})

it('does not enable an unknown connection when loading fails, and retries the read', async () => {
  vi.mocked(listBrowserConnections)
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockResolvedValueOnce([browserConnection({ enabled: true })])
  render()
  hooks.flushEffects()
  await flushPromises()
  expect(text(render())).toContain('database unavailable')
  expect(toggle().disabled).toBe(true)
  expect(components(render(), Button).some((button) => text(button.props.children) === '重试')).toBe(true)
  const retry = components(render(), Button).find((button) => text(button.props.children) === '重试')!
  retry.props.onClick?.({} as never)
  render()
  hooks.flushEffects()
  await flushPromises()
  expect(toggle().checked).toBe(true)
  expect(toggle().disabled).toBe(false)
  expect(text(render())).not.toContain('database unavailable')
})

it('keeps the saved state on failure and emits a change only after a confirmed save', async () => {
  vi.mocked(listBrowserConnections).mockResolvedValue([browserConnection({ enabled: false })])
  const saving = deferred<Awaited<ReturnType<typeof setManagedCloakBrowser>>>()
  vi.mocked(setManagedCloakBrowser).mockReturnValueOnce(saving.promise)
  const listener = vi.fn()
  window.addEventListener('raccoon:connections-change', listener)
  try {
    render()
    hooks.flushEffects()
    await flushPromises()
    toggle().onCheckedChange?.(true)
    expect(toggle().disabled).toBe(true)
    expect(toggle().checked).toBe(false)
    saving.reject(new Error('disk full'))
    await flushPromises()
    expect(text(render())).toContain('disk full')
    expect(toggle().checked).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    vi.mocked(setManagedCloakBrowser).mockResolvedValueOnce(browserConnection({ enabled: true }))
    toggle().onCheckedChange?.(true)
    await flushPromises()
    expect(toggle().checked).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  } finally {
    window.removeEventListener('raccoon:connections-change', listener)
  }
})
