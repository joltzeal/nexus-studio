import type { DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFERENCES } from '@nexus/contracts'
import { Tabs } from '@/components/ui/tabs'
import { AiImagePage } from '@/features/ai-image/ai-image-page'
import { PluginPage } from '@/features/plugins/plugin-page'
import type {
  PluginNavigationAction,
  PluginNavigationState,
} from '@/features/plugins/plugin-navigation'
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import { components, KernelHookHarness } from '@/features/settings/kernel-test-support'
import { itemAiHandoff } from '@/features/vinted-monitor/item-ai-handoff'
import { sendToAiImage } from '@/lib/page-handoff'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AppShell } from './app-shell'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
    useCallback: <T extends (...args: never[]) => unknown>(
      callback: T,
      deps: DependencyList,
    ) => (state.hooks ? callback : react.useCallback(callback, deps)),
    useReducer: (
      reducer: (
        current: PluginNavigationState,
        action: PluginNavigationAction,
      ) => PluginNavigationState,
      initial: PluginNavigationState,
    ) => {
      if (!state.hooks) return react.useReducer(reducer, initial)
      const [value, setValue] = state.hooks.state(initial)
      return [
        value,
        (action: PluginNavigationAction) =>
          setValue((current: PluginNavigationState) => reducer(current, action)),
      ]
    },
  }
})
vi.mock('@/hooks/use-preferences', () => ({
  usePreferences: () => ({
    preferences: DEFAULT_PREFERENCES,
    loading: false,
    loadError: null,
    saveError: null,
    resolvedTheme: 'light',
  }),
}))
vi.mock('@/features/plugins/watch-plugin-catalog', () => ({
  watchPluginCatalog: vi.fn(),
}))
vi.mock('@/features/accounts/sms-wait-runtime', () => ({
  reconcileSmsWaitPlugin: vi.fn(),
  disposeSmsWaits: vi.fn(),
}))

function plugin(id: string): PluginView {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: [],
    granted: [],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: [],
    status: { pid: 100 },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
  }
}

const item = {
  id: 'vinted.fr:123',
  title: 'Blue coat',
  url: 'https://www.vinted.fr/items/123',
  brand: 'Synthetic brand',
  size: 'M',
  condition: 'Good',
  detail: { description: 'Cotton lining.' },
}
const vintedPage = 'plugin:studio.vinted-monitor'
let hooks: KernelHookHarness
const render = () => hooks.render(AppShell)
const navigation = () => components(render(), Tabs)[0]!.props
const composer = () => components(render(), AiImagePage)[0]!.props

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  hooks = new KernelHookHarness(state)
  vi.mocked(watchPluginCatalog).mockImplementation((onCatalog) => {
    onCatalog([
      plugin('studio.vinted-monitor'),
      plugin('studio.ai-image'),
      plugin('studio.shared-supply'),
    ])
    return () => {}
  })
  render()
  hooks.flushEffects()
  navigation().onValueChange?.(vintedPage)
})

afterEach(() => {
  hooks.dispose()
  vi.unstubAllGlobals()
})

describe('product image generation navigation', () => {
  it('keeps Vinted mounted while composing and after the generation dialog closes', () => {
    const handoff = itemAiHandoff(item, ['third.webp', 'first.webp'])
    sendToAiImage(handoff)

    expect(navigation().value).toBe(vintedPage)
    expect(composer()).toMatchObject({
      presentation: 'dialog',
      plugin: { id: 'studio.ai-image' },
      handoff,
    })
    expect(
      components(render(), PluginPage).every((page) => page.props.handoff === null),
    ).toBe(true)

    composer().onHandoffConsumed?.()
    expect(navigation().value).toBe(vintedPage)
    expect(components(render(), AiImagePage)).toHaveLength(0)

    navigation().onValueChange?.('plugin:studio.ai-image')
    expect(
      components(render(), PluginPage).find(
        (page) => page.props.plugin.id === 'studio.ai-image',
      )?.props.handoff,
    ).toBeNull()
  })

  it('opens another product in place without reviving the previous selection', () => {
    sendToAiImage(itemAiHandoff(item, ['first.webp']))
    composer().onHandoffConsumed?.()
    const next = itemAiHandoff({ ...item, id: 'vinted.fr:456' }, ['second.webp'])
    sendToAiImage(next)

    expect(navigation().value).toBe(vintedPage)
    expect(composer().handoff).toEqual(next)
  })

  it('preserves the existing page navigation for sources that request the AI page', () => {
    const handoff = { images: ['photo.jpg'], title: 'Supply product' }
    sendToAiImage(handoff)

    expect(navigation().value).toBe('plugin:studio.ai-image')
    expect(components(render(), AiImagePage)).toHaveLength(0)
    expect(
      components(render(), PluginPage).find(
        (page) => page.props.plugin.id === 'studio.ai-image',
      )?.props.handoff,
    ).toEqual(handoff)
  })
})
