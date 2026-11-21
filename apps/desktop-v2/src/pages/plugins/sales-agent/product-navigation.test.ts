import {
  isValidElement,
  type DependencyList,
  type EffectCallback,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProductsPage } from '../products'
import { ProductEditor } from '../products/ProductEditor'
import { productApi } from '../../../raccoon/plugins/products/api'
import { KernelHookHarness, components, flushPromises } from './test-support'
import { product } from './test-data'
import type { DetailNavigation } from '../../../raccoon/plugins/detail-navigation'

const context = vi.hoisted(() => ({
  hooks: null as KernelHookHarness | null,
  detail: null as ((request: DetailNavigation) => void) | null,
}))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      context.hooks ? context.hooks.state(initial) : react.useState(initial),
    useRef: (initial: unknown) =>
      context.hooks
        ? context.hooks.state(() => ({ current: initial }))[0]
        : react.useRef(initial),
    useEffect: (effect: EffectCallback, dependencies?: DependencyList) =>
      context.hooks
        ? context.hooks.effect(effect, dependencies)
        : react.useEffect(effect, dependencies),
  }
})
vi.mock('../../../raccoon/plugins/detail-navigation', () => ({
  useDetailNavigation: (_kind: string, listener: (request: DetailNavigation) => void) => {
    context.detail = listener
  },
}))
vi.mock('../../../raccoon/plugins/products/api', () => ({
  productApi: { get: vi.fn(), list: vi.fn() },
  supportsProductPage: () => true,
  supportsProduct: () => true,
}))
vi.mock('../../../raccoon/plugins/catalog', () => ({
  usePluginCatalog: (select: (state: unknown) => unknown) =>
    select({ plugins: [{ id: 'studio.products', storageDurable: true }] }),
}))
vi.mock('../../../raccoon/runtime', () => ({ isNativeRaccoon: () => true }))
vi.mock('../../../widgets/PageHeader', () => ({
  PageHeader: () => null,
  PageBody: () => null,
}))
vi.mock('../products/ProductEditor', () => ({ ProductEditor: () => null }))
vi.mock('../products/AiImportDialog', () => ({ AiImportDialog: () => null }))
vi.mock('../products/ImportDialog', () => ({ ImportDialog: () => null }))
vi.mock('../products/PublicationHistory', () => ({ PublicationHistory: () => null }))

let hooks: KernelHookHarness
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  hooks = new KernelHookHarness(context)
})
afterEach(() => {
  hooks.dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function render() {
  const page = ProductsPage({ onManage: vi.fn() })
  if (!isValidElement(page) || typeof page.type !== 'function')
    throw new Error('Expected product catalog')
  const Catalog = page.type as (props: unknown) => ReactNode
  return hooks.render(() => Catalog(page.props))
}

it('opens an Agent-linked product before the independent catalog list has loaded', async () => {
  vi.mocked(productApi.get).mockResolvedValue(product)
  render()
  context.detail?.({ kind: 'product', id: product.id })
  await flushPromises()
  const editor = components(render(), ProductEditor)[0]
  expect(productApi.list).not.toHaveBeenCalled()
  expect(productApi.get).toHaveBeenCalledExactlyOnceWith(product.id)
  expect(editor?.props.product?.id).toBe(product.id)
  expect(editor?.props.canWrite).toBe(false)
})
