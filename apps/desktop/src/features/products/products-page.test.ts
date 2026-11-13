import type { DependencyList, EffectCallback, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PRODUCT_CAPABILITY,
  PRODUCT_METHODS,
  PRODUCTS_PLUGIN_ID,
  ProductSummarySchema,
  type ProductPage,
} from '@nexus/plugin-products/contracts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { PluginGate } from '@/features/plugins/plugin-gate'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import type { PluginView } from '@/lib/platform/native-plugins'
import { ProductsPage, ProductsWorkspace } from './products-page'
import { listProducts } from './api'
import { ProductPublicationDialog } from './product-publication-history'
import { publication } from './publication.test-data'

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
    useCallback: <T extends (...args: never[]) => unknown>(
      callback: T,
      deps: DependencyList,
    ) => (state.hooks ? callback : react.useCallback(callback, deps)),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('./api', () => ({
  listProducts: vi.fn(),
  getProduct: vi.fn(),
  listProductPublications: vi.fn(),
  saveProduct: vi.fn(),
  removeProduct: vi.fn(),
  uploadProductImage: vi.fn(),
  discardProductImages: vi.fn(),
  productImageUrl: vi.fn(),
  releaseProductImageUrls: vi.fn(),
  importProductText: vi.fn(),
}))
vi.mock('./ai-import', () => ({ importGenerationProduct: vi.fn() }))
vi.mock('@/features/plugins/watch-plugin-catalog', () => ({
  watchPluginCatalog: () => () => {},
}))

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: PRODUCTS_PLUGIN_ID,
    name: '商品',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: [PRODUCT_CAPABILITY],
    granted: [PRODUCT_CAPABILITY],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: [...PRODUCT_METHODS],
    status: { pid: 100 },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
    ...overrides,
  }
}

describe('products plugin gate', () => {
  it.each([
    { hostAvailable: false, plugin: plugin() },
    { hostAvailable: true, plugin: null },
    { hostAvailable: true, plugin: plugin({ state: 'retrying' }) },
  ])('does not mount a product session without its host and process', (props) => {
    const tree = ProductsPage(props)
    expect(components(tree, PluginGate)).toHaveLength(1)
    expect(components(tree, ProductsWorkspace)).toHaveLength(0)
  })

  it.each([
    { granted: [] },
    { methods: ['products.list'] },
    { enabled: false },
    { id: 'another.plugin' },
  ])('does not expose writable forms to an incompatible plugin: %j', (overrides) => {
    const tree = ProductsPage({ hostAvailable: true, plugin: plugin(overrides) })
    expect(components(tree, ProductsWorkspace)).toHaveLength(0)
    expect(text(tree)).toBeTruthy()
  })

  it('remounts on process replacement, while ordinary status changes retain the session', () => {
    const session = (value: PluginView) =>
      components(
        ProductsPage({ plugin: value, hostAvailable: true }),
        ProductsWorkspace,
      )[0]!
    const initial = session(plugin())

    expect(session(plugin({ status: { pid: 100, count: 2 } })).key).toBe(initial.key)
    expect(session(plugin({ status: { pid: 101 } })).key).not.toBe(initial.key)
  })
})

describe('product list request ordering', () => {
  let hooks: KernelHookHarness
  const render = (): ReactNode => hooks.render(() => ProductsWorkspace())
  const result = (total: number, page = 1): ProductPage => ({
    items: [],
    total,
    page,
    pageSize: 20,
    storageDurable: true,
  })
  const settle = async () => {
    render()
    hooks.flushEffects()
    await flushPromises()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    hooks = new KernelHookHarness(state)
    vi.mocked(listProducts).mockResolvedValue(result(0))
  })
  afterEach(() => hooks.dispose())

  it('uses backend filters and ignores an old response after a search changes', async () => {
    const old = deferred<ProductPage>()
    vi.mocked(listProducts).mockReturnValueOnce(old.promise)
    await settle()
    const search = components(render(), Input).find(
      (node) => node.props['aria-label'] === '搜索商品',
    )!
    search.props.onChange?.({
      target: { value: 'Cabinet' },
    } as React.ChangeEvent<HTMLInputElement>)
    vi.mocked(listProducts).mockResolvedValue(result(8))
    await settle()

    expect(listProducts).toHaveBeenLastCalledWith({
      query: 'Cabinet',
      page: 1,
      pageSize: 20,
    })
    old.resolve(result(999))
    await flushPromises()
    expect(text(render())).toContain('共 8 件')
    expect(text(render())).not.toContain('999')
  })

  it('resets backend pagination for status changes and corrects an emptied last page', async () => {
    vi.mocked(listProducts).mockResolvedValue(result(21))
    await settle()
    const next = components(render(), Button).find(
      (node) => node.props['aria-label'] === '下一页商品',
    )!
    next.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    vi.mocked(listProducts).mockResolvedValue(result(20, 2))
    await settle()
    await settle()

    expect(listProducts).toHaveBeenLastCalledWith({
      query: '',
      page: 1,
      pageSize: 20,
    })
    const status = components(render(), LabeledSelect).find(
      (node) => node.props.ariaLabel === '商品状态',
    )!
    status.props.onValueChange('draft')
    await settle()
    expect(listProducts).toHaveBeenLastCalledWith({
      query: '',
      status: 'draft',
      page: 1,
      pageSize: 20,
    })
  })

  it('keeps a late failed request from replacing the current page with an error', async () => {
    const old = deferred<ProductPage>()
    vi.mocked(listProducts).mockReturnValueOnce(old.promise)
    await settle()
    components(render(), LabeledSelect)
      .find((node) => node.props.ariaLabel === '商品来源')!
      .props.onValueChange('manual')
    await settle()
    old.reject(new Error('旧请求错误'))
    await flushPromises()

    expect(text(render())).not.toContain('旧请求错误')
    expect(listProducts).toHaveBeenLastCalledWith({
      query: '',
      sourceKind: 'manual',
      page: 1,
      pageSize: 20,
    })
  })

  it('filters publication independently of preparation and source, resetting the page', async () => {
    vi.mocked(listProducts).mockResolvedValue(result(41))
    await settle()
    const select = (label: string, value: string) => {
      const control = components(render(), LabeledSelect).find(
        (node) => node.props.ariaLabel === label,
      )
      expect(control, `Missing filter: ${label}`).toBeDefined()
      control!.props.onValueChange(value)
    }
    select('商品状态', 'ready')
    await settle()
    select('商品来源', 'manual')
    await settle()
    components(render(), Button)
      .find((node) => node.props['aria-label'] === '下一页商品')!
      .props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    await settle()

    select('发布状态', 'published')
    await settle()
    expect(listProducts).toHaveBeenLastCalledWith({
      query: '',
      status: 'ready',
      sourceKind: 'manual',
      publicationStatus: 'published',
      page: 1,
      pageSize: 20,
    })
    select('发布状态', 'unpublished')
    await settle()
    expect(listProducts).toHaveBeenLastCalledWith(
      expect.objectContaining({ publicationStatus: 'unpublished', page: 1 }),
    )
    select('发布状态', 'all')
    await settle()
    expect(listProducts).toHaveBeenLastCalledWith({
      query: '',
      status: 'ready',
      sourceKind: 'manual',
      page: 1,
      pageSize: 20,
    })
  })

  it('does not use a late unfiltered response after changing publication status', async () => {
    const old = deferred<ProductPage>()
    vi.mocked(listProducts).mockReturnValueOnce(old.promise)
    await settle()
    const filter = components(render(), LabeledSelect).find(
      (node) => node.props.ariaLabel === '发布状态',
    )
    expect(filter).toBeDefined()
    filter!.props.onValueChange('published')
    await settle()
    old.resolve(result(999))
    await flushPromises()

    expect(text(render())).toContain('没有匹配的商品')
    expect(text(render())).not.toContain('999')
  })

  it('shows publication separately from a ready product and an archived product', async () => {
    const ready = ProductSummarySchema.parse({
      name: 'Prepared mug',
      id: '1198ca69-4f78-4705-ac59-2d48bc790194',
      status: 'ready' as const,
      revision: 3,
      sequence: 1,
      cover: null,
      imageCount: 0,
      source: { kind: 'manual' as const },
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
      publicationCount: 0,
      latestPublication: null,
    })
    const published = {
      ...ready,
      id: '2198ca69-4f78-4705-ac59-2d48bc790194',
      name: 'Archived mug',
      status: 'archived' as const,
      publicationCount: 2,
      latestPublication: publication,
    }
    vi.mocked(listProducts).mockResolvedValue({
      ...result(2),
      items: [ready, published],
    })
    await settle()

    const badges = components(render(), Badge).map((node) => text(node.props.children))
    expect(badges).toEqual(['待上架', '未发布', '已归档', '已发布'])
    expect(text(render())).toContain('准备状态')
    expect(text(render())).toContain('发布使用')
    expect(text(render())).toContain('英国店铺窗口')
    expect(text(render())).toContain('共 2 次发布')
    const history = components(render(), Button).find(
      (node) => node.props['aria-label'] === '查看商品 Archived mug 的发布历史',
    )
    expect(history).toBeDefined()
    history!.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    const dialog = components(render(), ProductPublicationDialog)[0]!
    expect(dialog.props).toMatchObject({
      productId: published.id,
      productName: published.name,
    })
    dialog.props.onClose()
    expect(components(render(), ProductPublicationDialog)).toHaveLength(0)
  })
})
