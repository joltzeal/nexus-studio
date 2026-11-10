import type { DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelHookHarness, flushPromises } from '@/features/settings/kernel-test-support'
import type { PluginView } from '@/lib/platform/native-plugins'
import { expiryApi } from './expiry-api'
import { useNumberExpiry } from './use-number-expiry'

const state = vi.hoisted(() => ({
  hooks: null as KernelHookHarness | null,
  catalog: null as ((plugins: PluginView[]) => void) | null,
  unsubscribe: vi.fn(),
}))

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (callback: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(callback, deps) : react.useEffect(callback, deps),
  }
})
vi.mock('@/features/plugins/watch-plugin-catalog', () => ({
  watchPluginCatalog: (callback: (plugins: PluginView[]) => void) => {
    state.catalog = callback
    return state.unsubscribe
  },
}))
vi.mock('./expiry-api', () => ({
  expiryApi: { list: vi.fn(), refresh: vi.fn(), dismiss: vi.fn() },
}))

let harness: KernelHookHarness
const plugin: PluginView = {
  id: 'studio.sim8',
  name: 'SIM8 接码',
  version: 'test',
  apiVersion: 1,
  minCoreVersion: '0.1.0',
  capabilities: ['verification.provider'],
  granted: ['verification.provider'],
  permissions: {
    networkDomains: ['api.cc'],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: ['api-token'],
  },
  source: 'test',
  enabled: true,
  state: 'running',
  methods: ['sim8.expiry.list', 'sim8.expiry.refresh', 'sim8.expiry.dismiss'],
  status: { pid: 123 },
  lastError: null,
  storageDurable: true,
  secretSlots: ['api-token'],
  sourceDirectory: null,
}
const item = {
  tel: '+14155550100',
  expiresAt: '2026-11-03T10:00:00.000Z',
  checkedAt: null,
}
const snapshot = { items: [item], pendingTels: [], failed: 0, storageDurable: true }

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  harness = new KernelHookHarness(state)
  vi.mocked(expiryApi.list).mockResolvedValue(snapshot)
  vi.mocked(expiryApi.dismiss).mockResolvedValue({ ...snapshot, items: [] })
})
afterEach(() => {
  harness.dispose()
  vi.useRealTimers()
})

function render(refreshKey = 0) {
  const result = harness.render(() => useNumberExpiry(refreshKey))
  harness.flushEffects()
  return result
}

describe('expiry reminders on the window page', () => {
  it('refreshes while the page remains open and restores the next day after dismissal', async () => {
    vi.setSystemTime(new Date(2026, 9, 30, 23, 59, 30))
    render()
    state.catalog?.([plugin])
    await flushPromises()
    await render().dismiss(item)
    expect(render().snapshot?.items).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(render().snapshot?.items).toEqual([item])
    expect(expiryApi.list).toHaveBeenCalledTimes(2)
    render(1)
    await flushPromises()
    expect(expiryApi.list).toHaveBeenCalledTimes(3)
    harness.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(expiryApi.list).toHaveBeenCalledTimes(3)
  })

  it('does not poll disabled or old plugins, and resumes when the updated plugin is ready', async () => {
    render()
    state.catalog?.([{ ...plugin, methods: [] }])
    expect(render().availability).toBe('upgrade')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(expiryApi.list).not.toHaveBeenCalled()
    state.catalog?.([plugin])
    await flushPromises()
    expect(render().snapshot?.items).toEqual([item])
    state.catalog?.([{ ...plugin, enabled: false }])
    expect(render().availability).toBe('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(expiryApi.list).toHaveBeenCalledTimes(1)
  })
})
