import type { DependencyList, EffectCallback, ReactNode } from 'react'
import type { ProductPage, ProductSummary } from '@nexus/plugin-products/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  components,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { listProducts } from '@/features/products/api'
import { readPickedProducts } from './api'
import { ProductPicker } from './product-picker'
import { ids, now, product } from './test-data'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('@/features/products/api', async (original) => ({
  ...(await original<typeof import('@/features/products/api')>()),
  listProducts: vi.fn(),
}))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  readPickedProducts: vi.fn(),
}))

function summary(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id: product.id,
    revision: product.revision,
    sequence: product.sequence,
    name: product.name,
    title: product.title,
    sku: product.sku,
    price: product.price,
    currency: product.currency,
    category: product.category,
    status: product.status,
    source: { kind: product.source.kind },
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: now,
    publicationCount: product.publicationCount,
    latestPublication: product.latestPublication,
    cover: product.images[0]!,
    imageCount: product.images.length,
    ...overrides,
  }
}

describe('product library picker metadata and selection', () => {
  let hooks: KernelHookHarness
  const onAdd = vi.fn()
  const onClose = vi.fn()
  const render = (): ReactNode =>
    hooks.render(() => ProductPicker({ existingIds: [], onAdd, onClose }))
  const settle = async () => {
    render()
    hooks.flushEffects()
    await flushPromises()
  }
  const checkbox = (name: string) =>
    components(render(), Checkbox).find(
      (node) => node.props['aria-label'] === `选择商品 ${name}`,
    )!

  beforeEach(() => {
    vi.clearAllMocks()
    hooks = new KernelHookHarness(state)
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now))
    vi.mocked(listProducts).mockResolvedValue({
      items: [summary()],
      total: 1,
      page: 1,
      pageSize: 20,
      storageDurable: true,
    })
  })
  afterEach(() => hooks.dispose())

  it('shows the plugin creation time with an absolute title and its publication count', async () => {
    await settle()
    const tree = render()
    expect(text(tree)).toContain('添加时间')
    expect(text(tree)).toContain('2 天前')
    expect(text(tree)).toContain('上架次数 0')
    const time = elements(tree).find((node) => node.type === 'time')!
    expect(time.props.dateTime).toBe('2026-11-11T00:00:00.000Z')
    expect(time.props.title).toContain('2026-11-11T00:00:00.000Z')
    expect(checkbox(product.name).props.disabled).toBe(false)
    expect(listProducts).toHaveBeenCalledExactlyOnceWith({
      query: '',
      page: 1,
      pageSize: 20,
      publicationStatus: 'unpublished',
    })
  })

  it('does not replace missing or invalid timestamps with the current time', async () => {
    vi.mocked(listProducts).mockResolvedValue({
      items: [
        summary({ createdAt: '', name: 'Missing time' }),
        summary({ id: ids.job, createdAt: 'invalid', name: 'Invalid time' }),
      ],
      total: 2,
      page: 1,
      pageSize: 20,
      storageDurable: true,
    })
    await settle()
    const tree = render()
    expect(text(tree).match(/添加时间 未知/g)).toHaveLength(2)
    expect(text(tree)).not.toContain('刚刚')
    expect(
      elements(tree).filter(
        (node) => node.type === 'time' && node.props.dateTime !== undefined,
      ),
    ).toHaveLength(0)
  })

  it('keeps cross-page picks while displaying the metadata of each fetched page', async () => {
    const firstPage = [
      summary(),
      ...Array.from({ length: 19 }, (_, index) =>
        summary({ id: crypto.randomUUID(), name: `Other product ${index}` }),
      ),
    ]
    const second = summary({
      id: ids.job,
      name: 'Second page product',
      createdAt: '2026-11-12T23:00:00.000Z',
    })
    vi.mocked(listProducts).mockImplementation(async (input): Promise<ProductPage> => ({
      items: input.page === 2 ? [second] : firstPage,
      total: 21,
      page: input.page ?? 1,
      pageSize: 20,
      storageDurable: true,
    }))
    const secondDetail = { ...product, id: second.id, name: second.name }
    vi.mocked(readPickedProducts).mockResolvedValue([product, secondDetail])
    await settle()
    checkbox(product.name).props.onCheckedChange?.(true)
    components(render(), Button)
      .find((node) => node.props['aria-label'] === '下一页商品库')!
      .props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    await settle()
    expect(text(render())).toContain('1 小时前')
    checkbox(second.name).props.onCheckedChange?.(true)
    expect(text(render())).toContain('已选 2 件')
    const add = components(render(), Button).find(
      (node) => text(node.props.children) === '加入 2 件商品',
    )!
    expect(add.props.disabled).toBe(false)
    add.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    await flushPromises()
    expect(readPickedProducts).toHaveBeenCalledExactlyOnceWith([product.id, second.id])
    expect(onAdd).toHaveBeenCalledExactlyOnceWith([product, secondDetail])
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
