import type { DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_PREFERENCES } from '@nexus/contracts'
import { Button } from '@/components/ui/button'
import { usePreferences } from '@/hooks/use-preferences'
import { listPlugins } from '@/lib/platform/native-plugins'
import {
  openConfigurationFile,
  saveConfigurationFile,
  type ConfigurationArchive,
} from '@/lib/platform/configuration'
import { components, flushPromises, KernelHookHarness, text } from './kernel-test-support'
import { ConfigurationPage } from './configuration-page'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
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
vi.mock('@/hooks/use-preferences', () => ({ usePreferences: vi.fn() }))
vi.mock('@/lib/platform/native-plugins', () => ({
  pluginHostAvailable: () => true,
  listPlugins: vi.fn(),
  callPlugin: vi.fn(),
}))
vi.mock('@/lib/platform/native-network-proxy', () => ({
  getNetworkProxy: vi.fn().mockResolvedValue({ mode: 'direct', url: null }),
  setNetworkProxy: vi.fn().mockResolvedValue({ mode: 'direct', url: null }),
}))
vi.mock('@/lib/platform/configuration', async (original) => ({
  ...(await original<typeof import('@/lib/platform/configuration')>()),
  openConfigurationFile: vi.fn(),
  saveConfigurationFile: vi.fn(),
}))

let hooks: KernelHookHarness
const render = () => hooks.render(ConfigurationPage)
async function click(label: string) {
  const button = components(render(), Button).find((node) =>
    text(node.props.children).includes(label),
  )
  expect(button?.props.disabled).toBe(false)
  button!.props.onClick?.({} as never)
  await flushPromises()
}
beforeEach(() => {
  vi.clearAllMocks()
  hooks = new KernelHookHarness(state)
  vi.mocked(listPlugins).mockResolvedValue([])
  vi.mocked(usePreferences).mockReturnValue({
    preferences: { ...DEFAULT_PREFERENCES },
    loading: false,
    loadError: null,
    saveError: null,
    saveStatus: 'idle',
    resolvedTheme: 'light',
    update: vi.fn().mockResolvedValue(true),
    reload: vi.fn(),
    retrySave: vi.fn(),
  })
})
afterEach(() => hooks.dispose())

it('exports persisted settings through a native save dialog and reports cancellation accurately', async () => {
  render()
  hooks.flushEffects()
  await flushPromises()
  vi.mocked(saveConfigurationFile).mockResolvedValueOnce(null)
  await click('导出所选')
  expect(saveConfigurationFile).toHaveBeenCalledOnce()
  expect(text(render())).not.toContain('已导出')
  vi.mocked(saveConfigurationFile).mockResolvedValueOnce('/fixture/nexus.json')
  await click('导出所选')
  expect(text(render())).toContain('已导出到 /fixture/nexus.json')
})

it('previews imported settings and does not mutate them until the import button is clicked', async () => {
  const archive: ConfigurationArchive = {
    format: 'nexus-configuration',
    schemaVersion: 1,
    exportedAt: '2026-11-11T00:00:00Z',
    preferences: { ...DEFAULT_PREFERENCES, workspaceName: 'Imported studio' },
    networkProxy: null,
    plugins: [],
  }
  vi.mocked(openConfigurationFile).mockResolvedValueOnce({
    name: 'fixture.json',
    archive,
  })
  render()
  hooks.flushEffects()
  await flushPromises()
  await click('选择配置文件')
  expect(usePreferences().update).not.toHaveBeenCalled()
  expect(text(render())).toContain('待导入：fixture.json')
  await click('导入所选')
  expect(usePreferences().update).toHaveBeenCalledExactlyOnceWith(archive.preferences)
  expect(text(render())).toContain('已导入 1 项配置')
})

it('retains the import file and reports a failed preference write without claiming success', async () => {
  const archive: ConfigurationArchive = {
    format: 'nexus-configuration',
    schemaVersion: 1,
    exportedAt: '2026-11-11T00:00:00Z',
    preferences: { ...DEFAULT_PREFERENCES },
    networkProxy: null,
    plugins: [],
  }
  vi.mocked(usePreferences().update).mockResolvedValueOnce(false)
  vi.mocked(openConfigurationFile).mockResolvedValueOnce({
    name: 'fixture.json',
    archive,
  })
  render()
  hooks.flushEffects()
  await flushPromises()
  await click('选择配置文件')
  await click('导入所选')
  expect(text(render())).toContain('1 项失败')
  expect(text(render())).toContain('偏好保存失败')
  expect(text(render())).toContain('fixture.json')
})
