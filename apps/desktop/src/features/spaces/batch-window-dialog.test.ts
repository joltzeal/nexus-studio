import type { DependencyList, EffectCallback, MouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import {
  components,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import {
  createNativeProfile,
  listNativeProfiles,
  type WindowSettings,
} from '@/lib/platform/native-profiles'
import { BatchWindowDialog } from './batch-window-dialog'
import { WindowEditor } from './window-editor'

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
vi.mock('@/lib/platform/native-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-profiles')>()),
  createNativeProfile: vi.fn(),
  listNativeProfiles: vi.fn(),
}))
vi.mock('@/lib/platform/native-groups', () => ({ listGroups: async () => [] }))
vi.mock('@/lib/platform/native-license', () => ({
  getLicenseStatus: async () => ({ configured: true }),
}))
vi.mock('@/features/accounts/api', () => ({
  listAccounts: vi.fn(),
  bindAccount: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const settings: WindowSettings = {
  platform: 'Vinted',
  note: 'batch',
  geoip: true,
  timezone: '',
  locale: '',
  viewport: 'default',
  fingerprintSeed: null,
  startUrl: '',
}
let hooks: KernelHookHarness
const onSettled = vi.fn()
const onClose = vi.fn()
const render = () => hooks.render(() => BatchWindowDialog({ onSettled, onClose }))
const editor = () => components(render(), WindowEditor)[0]!.props

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  vi.mocked(listNativeProfiles).mockResolvedValue([])
  vi.mocked(createNativeProfile).mockImplementation(
    async (name, proxy, proxyPlugin, proxyEndpoint, values, groupId, kernelVersion) => ({
      id: name,
      name,
      proxy,
      proxyPlugin,
      proxyEndpoint,
      settings: values,
      groupId: groupId ?? null,
      version: '155.0.8059.39',
      kernelVersion: kernelVersion ?? '155.0.8059.39.2',
      running: false,
      createdAt: 10,
      lastOpenedAt: null,
    }),
  )
})
afterEach(() => hooks.dispose())

describe('batch dialog kernel forwarding', () => {
  it('keeps the selected package and seed when retrying from the result screen', async () => {
    render()
    hooks.flushEffects()
    await flushPromises()
    editor().batch?.onCountChange?.(2)
    vi.mocked(createNativeProfile).mockRejectedValueOnce(new Error('download failed'))
    await editor().onSave(
      'fixed',
      null,
      null,
      null,
      settings,
      'group-one',
      '155.0.8059.39.1',
    )
    expect(vi.mocked(createNativeProfile).mock.calls.map((call) => call[6])).toEqual([
      '155.0.8059.39.1',
      '155.0.8059.39.1',
    ])
    expect(components(render(), WindowEditor)).toHaveLength(0)
    const retry = components(render(), Button).find(
      (node) => text(node.props.children) === '重试未完成项',
    )!
    retry.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
    await flushPromises()
    expect(vi.mocked(createNativeProfile).mock.calls[2]![6]).toBe('155.0.8059.39.1')
    expect(vi.mocked(createNativeProfile).mock.calls[2]![4].fingerprintSeed).toBe(
      vi.mocked(createNativeProfile).mock.calls[0]![4].fingerprintSeed,
    )
    expect(onSettled).toHaveBeenCalledTimes(2)
    expect(text(render())).toContain('已完成 2/2')
  })

  it('keeps default latest source compatible, then forwards the actual full package', async () => {
    render()
    hooks.flushEffects()
    await flushPromises()
    editor().batch?.onCountChange?.(2)
    await editor().onSave('latest', null, null, null, settings, null)
    expect(vi.mocked(createNativeProfile).mock.calls[0]).toHaveLength(6)
    expect(vi.mocked(createNativeProfile).mock.calls[1]![6]).toBe('155.0.8059.39.2')
    expect(text(render())).toContain('已完成 2/2')
    expect(settings.fingerprintSeed).toBeNull()
  })
})
