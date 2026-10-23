import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  installFromMarket,
  installPlugin,
  uninstallPlugin,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { notifyPluginCatalogChanged } from '@/lib/platform/plugin-catalog-events'
import {
  initialPluginNavigation,
  pluginNavigationReducer as reduce,
  type PluginNavigationState,
} from '@/features/plugins/plugin-navigation'
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import { PluginPage } from '@/features/plugins/plugin-page'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: 'studio.sim8',
    name: 'SIM8 接码',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: ['verification.provider'],
    granted: ['verification.provider'],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: ['sim8.config.get'],
    status: null,
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
    ...overrides,
  }
}

describe('installed plugin navigation', () => {
  it('includes SIM8 and unknown plugins but excludes uninstalled and disabled entries', () => {
    const state = reduce(initialPluginNavigation, {
      type: 'catalog',
      plugins: [
        plugin({ id: 'studio.uninstalled', state: 'available' }),
        plugin({ id: 'studio.disabled', enabled: false }),
        plugin(),
        plugin({ id: 'studio.new-provider', name: 'New provider' }),
      ],
    })
    expect(state.plugins.map(({ id }) => id)).toEqual([
      'studio.new-provider',
      'studio.sim8',
    ])
  })

  it('keeps starting and retrying plugins reachable, with current host names', () => {
    const state = reduce(initialPluginNavigation, {
      type: 'catalog',
      plugins: [
        plugin({ state: 'starting', name: 'My SMS provider' }),
        plugin({ id: 'studio.other', state: 'retrying', name: 'Other provider' }),
      ],
    })
    expect(state.plugins.map(({ name }) => name)).toEqual([
      'Other provider',
      'My SMS provider',
    ])
    expect(reduce(state, { type: 'navigate', page: 'plugin:studio.sim8' }).page).toBe(
      'plugin:studio.sim8',
    )
  })

  it('leaves an uninstalled page and does not reopen it when the plugin returns', () => {
    let state = reduce(initialPluginNavigation, { type: 'catalog', plugins: [plugin()] })
    state = reduce(state, { type: 'navigate', page: 'plugin:studio.sim8' })
    state = reduce(state, { type: 'catalog', plugins: [] })
    expect(state.page).toBe('plugins')
    expect(reduce(state, { type: 'catalog', plugins: [plugin()] }).page).toBe('plugins')
  })

  it('does not redirect a core page when the catalog changes', () => {
    const state = reduce(initialPluginNavigation, { type: 'navigate', page: 'settings' })
    expect(reduce(state, { type: 'catalog', plugins: [plugin()] }).page).toBe('settings')
  })

  it('routes missing handoff targets to the plugin center and keeps failures distinct from removal', () => {
    expect(
      reduce(initialPluginNavigation, {
        type: 'navigate',
        page: 'plugin:studio.ai-image',
      }).page,
    ).toBe('plugins')
    let state = reduce(initialPluginNavigation, { type: 'catalog', plugins: [plugin()] })
    state = reduce(state, { type: 'navigate', page: 'plugin:studio.sim8' })
    state = reduce(state, { type: 'error' })
    expect(state.page).toBe('plugin:studio.sim8')
    expect(state.plugins).toHaveLength(1)
    expect(state.catalogError).toBe(true)
    expect(reduce(state, { type: 'catalog', plugins: [plugin()] }).catalogError).toBe(
      false,
    )
  })
})

describe('catalog refresh lifecycle', () => {
  const stops: (() => void)[] = []
  let state: PluginNavigationState
  let catalog: PluginView[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(isTauri).mockReturnValue(true)
    state = initialPluginNavigation
    catalog = []
    vi.mocked(invoke)
      .mockReset()
      .mockImplementation(async (command) => {
        if (command === 'plugin_catalog') return catalog
        if (command === 'plugin_uninstall') catalog = []
        else catalog = [plugin()]
        return catalog[0]
      })
  })
  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
    vi.useRealTimers()
  })

  function start() {
    stops.push(
      watchPluginCatalog(
        (plugins) => {
          state = reduce(state, { type: 'catalog', plugins })
        },
        () => {
          state = reduce(state, { type: 'error' })
        },
      ),
    )
  }

  it.each([
    ['local', () => installPlugin('/synthetic/plugin')],
    ['market', () => installFromMarket('studio.sim8')],
  ] as const)(
    'refreshes immediately after %s installation and after uninstall',
    async (_, install) => {
      start()
      await vi.advanceTimersByTimeAsync(0)
      expect(state.plugins).toHaveLength(0)
      await install()
      await vi.advanceTimersByTimeAsync(0)
      expect(state.plugins.map(({ id }) => id)).toEqual(['studio.sim8'])
      await uninstallPlugin('studio.sim8')
      await vi.advanceTimersByTimeAsync(0)
      expect(state.plugins).toHaveLength(0)
    },
  )

  it('rejects stale pre-mutation results and reloads without concurrent reads', async () => {
    let complete!: (value: PluginView[]) => void
    const pending = new Promise<PluginView[]>((resolve) => {
      complete = resolve
    })
    vi.mocked(invoke).mockReturnValueOnce(pending)
    start()
    notifyPluginCatalogChanged()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    complete([plugin({ name: 'Stale result' })])
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(state.plugins).toHaveLength(0)
  })

  it('polls background changes and preserves the last menu on a failed read', async () => {
    catalog = [plugin()]
    start()
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(invoke).mockRejectedValueOnce(new Error('offline'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.plugins).toHaveLength(1)
    expect(state.catalogError).toBe(true)
    catalog = []
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.plugins).toHaveLength(0)
    expect(state.catalogError).toBe(false)
  })

  it('does not publish a successful installation when the native command fails', async () => {
    start()
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(invoke).mockRejectedValueOnce(new Error('install failed'))
    await expect(installFromMarket('studio.sim8')).rejects.toThrow('install failed')
    await vi.advanceTimersByTimeAsync(0)
    expect(state.plugins).toHaveLength(0)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('ignores late results and releases timers and mutation listeners on disposal', async () => {
    let complete!: (value: PluginView[]) => void
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    start()
    stops[0]!()
    complete([plugin()])
    notifyPluginCatalogChanged()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(state.plugins).toHaveLength(0)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not call the native host from a web preview', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    start()
    notifyPluginCatalogChanged()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('plugin page dispatch', () => {
  function render(entry: PluginView) {
    return renderToStaticMarkup(
      createElement(PluginPage, {
        plugin: entry,
        hostAvailable: true,
        aiImageReady: false,
        handoff: null,
        onHandoffConsumed: () => {},
        onManage: () => {},
        onWindows: () => {},
      }),
    )
  }

  it('opens the actual SIM8 workbench', () => {
    const html = render(plugin())
    expect(html).toContain('SIM8 接码')
    expect(html).toContain('正在读取配置')
    expect(html).not.toContain('管理插件')
  })

  it('shows a usable detail page for new plugin IDs', () => {
    const html = render(plugin({ id: 'studio.unregistered', name: 'Custom provider' }))
    expect(html).toContain('Custom provider')
    expect(html).toContain('studio.unregistered')
    expect(html).toContain('管理插件')
  })

  it('links transport-only sync plugins to the existing window workflow', () => {
    const html = render(
      plugin({ id: 'studio.window-sync', capabilities: ['window.sync'] }),
    )
    expect(html).toContain('前往窗口管理')
  })
})
