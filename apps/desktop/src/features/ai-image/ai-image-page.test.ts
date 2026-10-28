import type { DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FieldError } from '@/components/ui/field'
import type { PluginView } from '@/lib/platform/native-plugins'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { AiImagePage, type AiImagePageProps } from './ai-image-page'
import {
  createScenePlan,
  generate,
  listPresets,
  listProviders,
  listRecords,
  recognizeRecord,
  retryRecord,
} from './api'
import { GenerateDialog } from './generate-dialog'
import { ProvidersSheet } from './providers-sheet'
import type { ProviderCatalog } from './types'

const state = vi.hoisted(() => ({ hooks: null as PageHookHarness | null }))
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
    useLayoutEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks
        ? state.hooks.effect(effect, deps)
        : react.useLayoutEffect(effect, deps),
    useMemo: <T>(factory: () => T, deps: DependencyList) =>
      state.hooks ? state.hooks.memo(factory, deps) : react.useMemo(factory, deps),
    useCallback: <T extends (...args: never[]) => unknown>(
      callback: T,
      deps: DependencyList,
    ) =>
      state.hooks
        ? state.hooks.memo(() => callback, deps)
        : react.useCallback(callback, deps),
  }
})
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  listProviders: vi.fn(),
  listRecords: vi.fn(),
  listPresets: vi.fn(),
  generate: vi.fn(),
  createScenePlan: vi.fn(),
  recognizeRecord: vi.fn(),
  retryRecord: vi.fn(),
}))

class PageHookHarness extends KernelHookHarness {
  writes = 0

  override state(initial: unknown): [unknown, (next: unknown) => void] {
    const [value, setValue] = super.state(initial)
    return [
      value,
      (next) => {
        this.writes += 1
        setValue(next)
      },
    ]
  }

  memo<T>(factory: () => T, deps: DependencyList): T {
    const [cached, setCached] = this.state(undefined)
    const previous = cached as { value: T; deps: DependencyList } | undefined
    if (
      previous &&
      previous.deps.length === deps.length &&
      deps.every((dep, index) => Object.is(dep, previous.deps[index]))
    ) {
      return previous.value
    }
    const value = factory()
    setCached({ value, deps })
    return value
  }
}

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: 'studio.ai-image',
    name: 'AI image',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: ['image.provider'],
    granted: ['image.provider'],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: ['image.plans.create', 'image.plans.get'],
    status: { pid: 100, running: 0 },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
    ...overrides,
  }
}

function catalog(
  name: string,
  overrides: Partial<ProviderCatalog> = {},
): ProviderCatalog {
  return {
    items: [
      {
        id: name,
        name,
        kind: 'openai_compatible',
        baseUrl: 'https://models.example.invalid/v1',
        imageModel: `${name}-image`,
        visionModel: `${name}-vision`,
        imageTimeoutSeconds: 900,
        imageResponseMode: 'auto',
        hasApiKey: true,
        apiKeyHint: 'test',
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
      },
    ],
    modelConfigVersion: 2,
    storageDurable: true,
    selections: {
      image: { providerId: name, model: `${name}-image` },
      vision: { providerId: name, model: `${name}-vision` },
    },
    ...overrides,
  }
}

let hooks: PageHookHarness
let props: AiImagePageProps
const render = () => hooks.render(() => AiImagePage(props))
const generation = () => components(render(), GenerateDialog)[0]!.props
const configuration = () => components(render(), ProvidersSheet)[0]!.props
const errors = () =>
  components(render(), FieldError).map((node) => text(node.props.children))

async function settle() {
  render()
  hooks.flushEffects()
  await flushPromises()
}

function expectCatalog(expected: ProviderCatalog) {
  const current = generation()
  expect(current.providers).toEqual(expected.items)
  expect(current.selections).toEqual(expected.selections)
  expect(current.modelConfigReady).toBe(expected.modelConfigVersion === 2)
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new PageHookHarness(state)
  props = {
    hostAvailable: true,
    plugin: plugin(),
    handoff: { images: [], title: 'Product' },
  }
  vi.mocked(listProviders).mockResolvedValue(catalog('initial'))
  vi.mocked(listRecords).mockResolvedValue({
    items: [],
    total: 0,
    page: 0,
    pageSize: 10,
    storageDurable: true,
  })
  vi.mocked(listPresets).mockResolvedValue({ presets: [] })
})

afterEach(() => {
  hooks.dispose()
  expect(generate).not.toHaveBeenCalled()
  expect(createScenePlan).not.toHaveBeenCalled()
  expect(recognizeRecord).not.toHaveBeenCalled()
  expect(retryRecord).not.toHaveBeenCalled()
})

describe('provider catalog request ordering', () => {
  it('keeps the accepted-task refresh when the initial load arrives later', async () => {
    const initial = deferred<ProviderCatalog>()
    const accepted = deferred<ProviderCatalog>()
    vi.mocked(listProviders)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(accepted.promise)
    await settle()

    const submitted = generation().onSubmitted()
    accepted.resolve(catalog('accepted'))
    await expect(submitted).resolves.toBeUndefined()
    expectCatalog(catalog('accepted'))

    initial.resolve(catalog('obsolete', { modelConfigVersion: 1, storageDurable: false }))
    await flushPromises()

    expectCatalog(catalog('accepted'))
    generation().onConfigure()
    expect(configuration().storageDurable).toBe(true)
    expect(listProviders).toHaveBeenCalledTimes(2)
  })

  it('keeps the newest explicit refresh when responses arrive in reverse order', async () => {
    await settle()
    const older = deferred<ProviderCatalog>()
    const newer = deferred<ProviderCatalog>()
    vi.mocked(listProviders)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const refresh = generation().onModelsChanged
    const first = refresh()
    const second = refresh()

    newer.resolve(catalog('newer'))
    await second
    older.resolve(catalog('older'))
    await first

    expectCatalog(catalog('newer'))
    expect(listProviders).toHaveBeenCalledTimes(3)
  })

  it.each(['initial', 'refresh'] as const)(
    'ignores a stale %s error after a newer refresh succeeds',
    async (origin) => {
      const older = deferred<ProviderCatalog>()
      if (origin === 'initial')
        vi.mocked(listProviders).mockReturnValueOnce(older.promise)
      await settle()
      const cause = new Error('Obsolete catalog error')
      let rejection: Promise<void> | undefined
      if (origin === 'refresh') {
        vi.mocked(listProviders).mockReturnValueOnce(older.promise)
        rejection = expect(generation().onModelsChanged()).rejects.toBe(cause)
      }
      vi.mocked(listProviders).mockResolvedValueOnce(catalog('newer'))
      await generation().onModelsChanged()

      older.reject(cause)
      await rejection
      await flushPromises()

      expectCatalog(catalog('newer'))
      expect(errors()).toEqual([])
    },
  )

  it('still rejects and displays a current explicit preference refresh failure', async () => {
    await settle()
    const cause = new Error('Current catalog error')
    vi.mocked(listProviders).mockRejectedValueOnce(cause)

    await expect(generation().onModelsChanged()).rejects.toBe(cause)

    expect(errors()).toEqual([cause.message])
    expectCatalog(catalog('initial'))
  })

  it('does not reject an accepted task or repeat it when preference refresh fails', async () => {
    await settle()
    const refresh = deferred<ProviderCatalog>()
    vi.mocked(listProviders).mockReturnValueOnce(refresh.promise)

    const submitted = generation().onSubmitted()
    await flushPromises()
    refresh.reject(new Error('Preferences could not be read'))
    await expect(submitted).resolves.toBeUndefined()
    await flushPromises()

    expect(errors()).toEqual(['Preferences could not be read'])
    expectCatalog(catalog('initial'))
    expect(listProviders).toHaveBeenCalledTimes(2)
    expect(listRecords).toHaveBeenCalledTimes(2)
  })
})

describe('provider catalog lifecycle', () => {
  it.each(['success', 'failure'] as const)(
    'ignores a pending refresh %s after stop, then loads fresh preferences on restart',
    async (outcome) => {
      await settle()
      generation().onConfigure()
      const pending = deferred<ProviderCatalog>()
      vi.mocked(listProviders).mockReturnValueOnce(pending.promise)
      const cause = new Error('Stopped plugin response')
      const task = configuration().onChanged()
      const completion = task.catch((failure: unknown) => failure)

      props.plugin = plugin({ state: 'retrying' })
      await settle()
      expect(configuration().modelConfigReady).toBe(false)
      const writes = hooks.writes
      if (outcome === 'failure') pending.reject(cause)
      else pending.resolve(catalog('stopped'))
      expect(await completion).toBe(outcome === 'failure' ? cause : undefined)
      expect(hooks.writes).toBe(writes)

      const restarted = deferred<ProviderCatalog>()
      vi.mocked(listProviders).mockReturnValueOnce(restarted.promise)
      props.plugin = plugin()
      await settle()
      expect(configuration().modelConfigReady).toBe(false)
      expect(generation().selections).toEqual({ image: null, vision: null })
      restarted.resolve(catalog('restarted'))
      await flushPromises()

      expectCatalog(catalog('restarted'))
      expect(errors()).toEqual([])
    },
  )

  it.each([
    { label: 'process', next: plugin({ status: { pid: 200, running: 0 } }) },
    { label: 'version', next: plugin({ version: '2.0.0' }) },
  ])(
    'invalidates the catalog when the plugin $label changes without a stopped render',
    async ({ next }) => {
      await settle()
      const older = deferred<ProviderCatalog>()
      const fresh = deferred<ProviderCatalog>()
      vi.mocked(listProviders)
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(fresh.promise)
      const task = generation().onModelsChanged()
      props.plugin = next
      await settle()
      expect(generation().modelConfigReady).toBe(false)

      older.resolve(catalog('obsolete'))
      await task
      expect(generation().modelConfigReady).toBe(false)
      fresh.resolve(catalog('replacement', { modelConfigVersion: 1 }))
      await flushPromises()

      expectCatalog(catalog('replacement', { modelConfigVersion: 1 }))
      expect(listProviders).toHaveBeenCalledTimes(3)
    },
  )

  it('does not reload preferences for an ordinary plugin status update', async () => {
    await settle()
    props.plugin = plugin({ status: { pid: 100, running: 1 } })
    await settle()

    expectCatalog(catalog('initial'))
    expect(listProviders).toHaveBeenCalledTimes(1)
  })

  it('ignores both accepted-task and model-refresh callbacks after parent unmount', async () => {
    await settle()
    const { onSubmitted, onModelsChanged } = generation()
    hooks.dispose()
    const writes = hooks.writes

    await Promise.all([onSubmitted(), onModelsChanged()])
    await flushPromises()

    expect(hooks.writes).toBe(writes)
    expect(listProviders).toHaveBeenCalledTimes(1)
    expect(listRecords).toHaveBeenCalledTimes(1)
  })

  it.each(['success', 'failure'] as const)(
    'ignores a refresh %s after unmount and does not read from a retained callback',
    async (outcome) => {
      await settle()
      const pending = deferred<ProviderCatalog>()
      vi.mocked(listProviders).mockReturnValueOnce(pending.promise)
      const refresh = generation().onModelsChanged
      const task = refresh()
      const cause = new Error('Unmounted response')
      const completion = task.catch((failure: unknown) => failure)
      hooks.dispose()
      const writes = hooks.writes

      if (outcome === 'failure') pending.reject(cause)
      else pending.resolve(catalog('unmounted'))
      expect(await completion).toBe(outcome === 'failure' ? cause : undefined)
      await refresh()

      expect(hooks.writes).toBe(writes)
      expect(listProviders).toHaveBeenCalledTimes(2)
    },
  )
})

describe('provider image test lifecycle', () => {
  it('passes declared methods and refreshes history even after configuration closes', async () => {
    props.plugin = plugin({ methods: ['image.providers.testImage'] })
    await settle()
    generation().onConfigure()
    const sheet = configuration()
    expect(sheet.pluginMethods).toEqual(['image.providers.testImage'])
    expect(sheet.onTestSubmitted).toBeTypeOf('function')

    sheet.onOpenChange(false)
    await sheet.onTestSubmitted()

    expect(listRecords).toHaveBeenCalledTimes(2)
    expect(listProviders).toHaveBeenCalledTimes(2)
    expect(components(render(), ProvidersSheet)).toHaveLength(0)
  })

  it.each([
    { label: 'process', next: plugin({ status: { pid: 200, running: 0 } }) },
    { label: 'methods', next: plugin({ methods: ['image.providers.testImage'] }) },
  ])(
    'rekeys tests on $label replacement and ignores old submit callbacks',
    async ({ next }) => {
      await settle()
      generation().onConfigure()
      const before = components(render(), ProvidersSheet)[0]!
      expect(before.props.onTestSubmitted).toBeTypeOf('function')

      props.plugin = next
      await settle()
      const after = components(render(), ProvidersSheet)[0]!
      expect(after.key).not.toEqual(before.key)
      const reads = vi.mocked(listRecords).mock.calls.length
      const catalogs = vi.mocked(listProviders).mock.calls.length
      const writes = hooks.writes
      await before.props.onTestSubmitted()

      expect(listRecords).toHaveBeenCalledTimes(reads)
      expect(listProviders).toHaveBeenCalledTimes(catalogs)
      expect(hooks.writes).toBe(writes)
    },
  )

  it.each(['success', 'failure'] as const)(
    'ignores a history refresh %s from a replaced process',
    async (outcome) => {
      await settle()
      generation().onConfigure()
      const sheet = configuration()
      expect(sheet.onTestSubmitted).toBeTypeOf('function')
      const oldRead = deferred<Awaited<ReturnType<typeof listRecords>>>()
      vi.mocked(listRecords).mockReturnValueOnce(oldRead.promise)
      const submitted = sheet.onTestSubmitted()
      props.plugin = plugin({ status: { pid: 200, running: 0 } })
      await settle()
      const writes = hooks.writes

      if (outcome === 'failure') oldRead.reject(new Error('Old history error'))
      else
        oldRead.resolve({
          items: [],
          total: 999,
          page: 0,
          pageSize: 10,
          storageDurable: false,
        })
      await submitted

      expect(hooks.writes).toBe(writes)
      expect(errors()).toEqual([])
    },
  )
})

describe('in-place product image generation', () => {
  beforeEach(() => {
    props = { ...props, presentation: 'dialog', onHandoffConsumed: vi.fn() }
  })

  it('loads the composer without replacing the source page or reading global history', async () => {
    await settle()

    expectCatalog(catalog('initial'))
    expect(
      elements(render()).some((node) => node.props['aria-labelledby'] === 'ai-heading'),
    ).toBe(false)
    expect(listRecords).not.toHaveBeenCalled()

    await generation().onSubmitted()
    generation().onOpenChange(false)
    expect(props.onHandoffConsumed).toHaveBeenCalledOnce()
    expect(listRecords).not.toHaveBeenCalled()
  })

  it('allows model configuration and surfaces a failed catalog read in the dialog', async () => {
    vi.mocked(listProviders).mockRejectedValueOnce(new Error('Cannot read providers'))
    await settle()
    expect(generation().loadError).toBe('Cannot read providers')
    generation().onConfigure()
    await configuration().onChanged()

    expectCatalog(catalog('initial'))
    expect(generation().loadError).toBeNull()
    expect(listRecords).not.toHaveBeenCalled()
  })
})
