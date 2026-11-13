import type { DependencyList, EffectCallback, MouseEvent, ReactNode } from 'react'
import type { ProductPublicationPage } from '@nexus/plugin-products/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { clearToasts, toastSnapshot } from '@/components/ui/toast'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { openExternalUrl } from '@/lib/platform/external-url'
import { getProduct, listProductPublications } from './api'
import {
  ProductPublicationDialog,
  ProductPublicationHistory,
  type ProductPublicationDialogProps,
} from './product-publication-history'
import { publication, publicationPage, publicationRecords } from './publication.test-data'

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
vi.mock('./api', () => ({ getProduct: vi.fn(), listProductPublications: vi.fn() }))
vi.mock('@/lib/platform/external-url', async (original) => ({
  ...(await original<typeof import('@/lib/platform/external-url')>()),
  openExternalUrl: vi.fn(),
}))

const productId = publicationPage().productId
let hooks: KernelHookHarness
let props: ProductPublicationDialogProps
const render = (): ReactNode => hooks.render(() => ProductPublicationDialog(props))
async function settle() {
  render()
  hooks.flushEffects()
  await flushPromises()
}
function click(label: string) {
  const button = components(render(), Button).find(
    (node) => text(node.props.children) === label || node.props['aria-label'] === label,
  )
  expect(button, `Missing action: ${label}`).toBeDefined()
  button!.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
}
function pageSize(value: '20' | '50') {
  const control = components(render(), LabeledSelect).find(
    (node) => node.props.ariaLabel === '每页发布历史数量',
  )
  expect(control).toBeDefined()
  control!.props.onValueChange(value)
}
function history() {
  const component = components(render(), ProductPublicationHistory)[0]
  expect(component).toBeDefined()
  return ProductPublicationHistory(component!.props)
}

beforeEach(() => {
  vi.resetAllMocks()
  clearToasts()
  hooks = new KernelHookHarness(state)
  props = { productId, productName: 'List name', onClose: vi.fn() }
  vi.mocked(getProduct).mockRejectedValue(new Error('历史不应读取商品详情'))
  vi.mocked(listProductPublications).mockResolvedValue(publicationPage())
  vi.mocked(openExternalUrl).mockResolvedValue()
})
afterEach(() => {
  hooks.dispose()
  clearToasts()
})

describe('current publication history', () => {
  it('loads a current history page without fetching product details, including repeated windows', async () => {
    const earlier = {
      ...publication,
      id: '6198ca69-4f78-4705-ac59-2d48bc790194',
      operationId: '7198ca69-4f78-4705-ac59-2d48bc790194',
      windowId: '8198ca69-4f78-4705-ac59-2d48bc790194',
      windowName: '另一店铺窗口',
      platform: 'Other platform',
      listingId: 'item-1',
      listingUrl: 'https://example.org/items/1',
      publishedAt: '2026-11-13T00:30:00.000Z',
      recordedAt: '2026-11-13T00:31:00.000Z',
    }
    const repeated = {
      ...publication,
      id: '9198ca69-4f78-4705-ac59-2d48bc790194',
      operationId: 'a198ca69-4f78-4705-ac59-2d48bc790194',
      listingId: 'item-3',
      listingUrl: 'https://example.com/items/3',
      publishedAt: '2026-11-13T02:00:00.000Z',
      recordedAt: '2026-11-13T02:01:00.000Z',
    }
    const publications = [earlier, publication, repeated]
    const pending = deferred<ProductPublicationPage>()
    vi.mocked(listProductPublications).mockReturnValueOnce(pending.promise)
    await settle()
    expect(listProductPublications).toHaveBeenCalledExactlyOnceWith({
      productId,
      page: 1,
      pageSize: 20,
    })
    expect(getProduct).not.toHaveBeenCalled()
    expect(text(render())).toContain('正在读取发布历史')
    expect(text(render())).not.toContain('未发布')
    pending.resolve(publicationPage({ items: publications, total: 3 }))
    await flushPromises()

    expect(text(render())).toContain('Published mug')
    const tree = history()
    expect(text(tree)).toContain('共 3 次发布')
    expect(text(tree)).toContain('本页 3 条')
    const records = elements(tree).filter((node) => node.type === 'li')
    expect(records).toHaveLength(3)
    expect(records.map((node) => text(node))).toEqual([
      expect.stringContaining('item-3'),
      expect.stringContaining('item-2'),
      expect.stringContaining('item-1'),
    ])
    for (const record of publications) {
      const row = records.find((node) => text(node).includes(record.listingId))!
      expect(text(row)).toContain(record.windowName)
      expect(text(row)).toContain(record.windowId)
      expect(text(row)).toContain(record.platform)
      expect(text(row)).toContain(record.listingId)
      expect(
        elements(row)
          .filter((node) => node.type === 'time')
          .map((node) => node.props.dateTime),
      ).toEqual([record.publishedAt, record.recordedAt])
      expect(elements(row).find((node) => node.type === 'a')!.props.href).toBe(
        record.listingUrl,
      )
    }
    expect(publications[0]).toBe(earlier)
  })

  it('shows an actual empty history as unpublished without treating preparation as publication', async () => {
    vi.mocked(listProductPublications).mockResolvedValue(
      publicationPage({ items: [], total: 0 }),
    )
    await settle()
    const tree = history()
    expect(components(tree, Badge).map((node) => text(node.props.children))).toEqual([
      '未发布',
    ])
    expect(text(tree)).toContain('暂无发布记录')
  })

  it.each([
    ['2026-11-13T02:00:00.00011Z', '2026-11-13T02:00:00.00019Z'],
    ['2026-11-13T02:00:00.000Z', '2026-11-13T02:00:00.000Z'],
  ])(
    'orders history consistently with the latest publication summary (%s, %s)',
    (earlier, later) => {
      const tree = ProductPublicationHistory({
        total: 2,
        publications: [
          {
            ...publication,
            id: '1198ca69-4f78-4705-ac59-2d48bc790194',
            listingId: 'earlier-listing',
            publishedAt: earlier,
            recordedAt: '2026-11-13T03:00:00.000Z',
          },
          {
            ...publication,
            id: '9198ca69-4f78-4705-ac59-2d48bc790194',
            listingId: 'latest-listing',
            publishedAt: later,
            recordedAt: '2026-11-13T02:30:00.000Z',
          },
        ],
      })
      const records = elements(tree).filter((node) => node.type === 'li')
      expect(text(records[0])).toContain('latest-listing')
      expect(text(records[1])).toContain('earlier-listing')
    },
  )

  it('visits all 55 records through three bounded pages without prefetching them', async () => {
    const publications = publicationRecords(55)
    vi.mocked(listProductPublications).mockImplementation(async (query) => {
      const page = query.page ?? 1
      const pageSize = query.pageSize ?? 20
      return publicationPage({
        page,
        pageSize,
        items: publications.slice((page - 1) * pageSize, page * pageSize),
        total: 55,
      })
    })
    await settle()
    expect(listProductPublications).toHaveBeenCalledTimes(1)
    const visited: string[] = []
    for (const [index, count] of [20, 20, 15].entries()) {
      if (index > 0) {
        click('下一页发布历史')
        expect(components(render(), ProductPublicationHistory)).toHaveLength(0)
        expect(text(render())).not.toContain('未发布')
        await settle()
      }
      const tree = history()
      expect(elements(tree).filter((node) => node.type === 'li')).toHaveLength(count)
      expect(text(tree)).toContain('共 55 次发布')
      expect(text(tree)).toContain(`本页 ${count} 条`)
      expect(text(render())).toContain(`第 ${index + 1} / 3 页`)
      visited.push(
        ...components(render(), ProductPublicationHistory)[0]!.props.publications.map(
          (record) => record.id,
        ),
      )
    }
    expect(visited).toEqual(publications.map((record) => record.id))
    expect(new Set(visited).size).toBe(55)
    expect(listProductPublications).toHaveBeenCalledTimes(3)
    expect(getProduct).not.toHaveBeenCalled()
    expect(
      components(render(), Button).find(
        (node) => node.props['aria-label'] === '下一页发布历史',
      )!.props.disabled,
    ).toBe(true)
  })

  it('resets to page one when changing to 50 records and supports the previous page', async () => {
    const publications = publicationRecords(55)
    vi.mocked(listProductPublications).mockImplementation(async (query) => {
      const page = query.page ?? 1
      const pageSize = query.pageSize ?? 20
      return publicationPage({
        page,
        pageSize,
        items: publications.slice((page - 1) * pageSize, page * pageSize),
        total: 55,
      })
    })
    await settle()
    click('下一页发布历史')
    await settle()
    pageSize('50')
    await settle()
    expect(listProductPublications).toHaveBeenLastCalledWith({
      productId,
      page: 1,
      pageSize: 50,
    })
    expect(text(history())).toContain('本页 50 条')
    expect(text(render())).toContain('第 1 / 2 页')
    click('下一页发布历史')
    await settle()
    expect(text(history())).toContain('本页 5 条')
    click('上一页发布历史')
    await settle()
    expect(text(render())).toContain('第 1 / 2 页')
  })

  it('uses a backend clamped page for navigation without refetching the same result', async () => {
    const publications = publicationRecords(21)
    vi.mocked(listProductPublications).mockResolvedValueOnce(
      publicationPage({ items: publications.slice(0, 20), total: 21 }),
    )
    await settle()
    vi.mocked(listProductPublications).mockResolvedValue(
      publicationPage({ items: publications.slice(0, 20), total: 20 }),
    )
    click('下一页发布历史')
    await settle()
    expect(listProductPublications).toHaveBeenLastCalledWith({
      productId,
      page: 2,
      pageSize: 20,
    })
    expect(text(render())).toContain('第 1 / 1 页')
    expect(listProductPublications).toHaveBeenCalledTimes(2)
    click('刷新记录')
    await settle()
    expect(listProductPublications).toHaveBeenLastCalledWith({
      productId,
      page: 1,
      pageSize: 20,
    })
  })

  it('does not label an empty current page as unpublished when other records exist', () => {
    const tree = ProductPublicationHistory({ publications: [], total: 55 })
    expect(components(tree, Badge).map((node) => text(node.props.children))).toEqual([
      '已发布',
    ])
    expect(text(tree)).toContain('共 55 次发布')
    expect(text(tree)).toContain('本页 0 条')
    expect(text(tree)).not.toContain('未发布')
  })

  it('keeps load errors distinct from unpublished and retries against the current product', async () => {
    const retry = deferred<ProductPublicationPage>()
    vi.mocked(listProductPublications)
      .mockRejectedValueOnce(new Error('商品已经删除或无法读取'))
      .mockReturnValueOnce(retry.promise)
    await settle()
    expect(text(render())).toContain('发布历史读取失败')
    expect(text(render())).toContain('商品已经删除或无法读取')
    expect(text(render())).not.toContain('未发布')
    expect(components(render(), ProductPublicationHistory)).toHaveLength(0)
    click('重试读取')
    expect(text(render())).toContain('正在读取发布历史')
    expect(text(render())).not.toContain('商品已经删除或无法读取')
    await settle()
    retry.resolve(publicationPage())
    await flushPromises()
    expect(listProductPublications).toHaveBeenNthCalledWith(2, {
      productId,
      page: 1,
      pageSize: 20,
    })
    expect(text(history())).toContain(publication.windowName)
  })

  it('retries a failed later page without restarting the history at page one', async () => {
    const records = publicationRecords(21)
    vi.mocked(listProductPublications)
      .mockResolvedValueOnce(publicationPage({ items: records.slice(0, 20), total: 21 }))
      .mockRejectedValueOnce(new Error('第二页读取失败'))
      .mockResolvedValueOnce(
        publicationPage({ items: records.slice(20), total: 21, page: 2 }),
      )
    await settle()
    click('下一页发布历史')
    await settle()
    expect(text(render())).toContain('第二页读取失败')
    expect(text(render())).not.toContain('未发布')
    click('重试读取')
    await settle()
    expect(listProductPublications).toHaveBeenLastCalledWith({
      productId,
      page: 2,
      pageSize: 20,
    })
    expect(text(render())).toContain('第 2 / 2 页')
    expect(text(history())).toContain('本页 1 条')
  })

  it('refreshes records without briefly presenting stale history as current', async () => {
    await settle()
    expect(text(history())).toContain('共 1 次发布')
    const refresh = deferred<ProductPublicationPage>()
    vi.mocked(listProductPublications).mockReturnValueOnce(refresh.promise)
    click('刷新记录')
    expect(components(render(), ProductPublicationHistory)).toHaveLength(0)
    await settle()
    refresh.resolve(publicationPage({ items: [], total: 0 }))
    await flushPromises()
    expect(text(history())).toContain('未发布')
    expect(listProductPublications).toHaveBeenCalledTimes(2)
  })

  it.each(['success', 'failure'] as const)(
    'ignores a late %s after switching the product',
    async (outcome) => {
      const old = deferred<ProductPublicationPage>()
      vi.mocked(listProductPublications).mockReturnValueOnce(old.promise)
      await settle()
      props = { ...props, productId: 'b198ca69-4f78-4705-ac59-2d48bc790194' }
      vi.mocked(listProductPublications).mockResolvedValue(
        publicationPage({
          productId: props.productId,
          productName: 'Current product',
          items: [],
          total: 0,
        }),
      )
      await settle()
      if (outcome === 'success') old.resolve(publicationPage())
      else old.reject(new Error('旧商品读取错误'))
      await flushPromises()
      expect(text(render())).toContain('Current product')
      expect(text(render())).not.toContain('旧商品读取错误')
      expect(text(history())).toContain('未发布')
      expect(text(history())).not.toContain(publication.windowName)
    },
  )

  it.each(['success', 'failure'] as const)(
    'ignores a late %s after changing the page size',
    async (outcome) => {
      const old = deferred<ProductPublicationPage>()
      vi.mocked(listProductPublications).mockReturnValueOnce(old.promise)
      await settle()
      pageSize('50')
      vi.mocked(listProductPublications).mockResolvedValue(
        publicationPage({
          productName: 'Current history page',
          pageSize: 50,
          items: [],
          total: 0,
        }),
      )
      await settle()
      if (outcome === 'success') old.resolve(publicationPage())
      else old.reject(new Error('旧页错误'))
      await flushPromises()
      expect(text(render())).toContain('Current history page')
      expect(text(render())).not.toContain('旧页错误')
      expect(text(history())).not.toContain(publication.windowName)
      expect(listProductPublications).toHaveBeenLastCalledWith({
        productId,
        page: 1,
        pageSize: 50,
      })
    },
  )

  it('fetches again on reopening and ignores a response belonging to the closed dialog', async () => {
    const closed = deferred<ProductPublicationPage>()
    vi.mocked(listProductPublications).mockReturnValueOnce(closed.promise)
    await settle()
    components(render(), Dialog)[0]!.props.onOpenChange?.(false)
    expect(props.onClose).toHaveBeenCalledOnce()
    hooks.dispose()
    hooks = new KernelHookHarness(state)
    vi.mocked(listProductPublications).mockResolvedValue(
      publicationPage({ items: [], total: 0 }),
    )
    await settle()
    closed.resolve(publicationPage())
    await flushPromises()

    expect(text(history())).toContain('未发布')
    expect(text(history())).not.toContain(publication.windowName)
    expect(listProductPublications).toHaveBeenCalledTimes(2)
  })
})

describe('publication platform links', () => {
  function link(tree: ReactNode) {
    return elements(tree).find((node) => node.type === 'a')!
  }

  it('opens through the existing default browser helper for primary and middle clicks', async () => {
    const tree = ProductPublicationHistory({ publications: [publication], total: 1 })
    const preventDefault = vi.fn()
    const anchor = link(tree)
    expect(anchor.props.rel).toBe('noopener noreferrer')
    ;(anchor.props.onClick as (event: MouseEvent<HTMLAnchorElement>) => void)({
      preventDefault,
    } as unknown as MouseEvent<HTMLAnchorElement>)
    await flushPromises()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/items/2')
    ;(anchor.props.onAuxClick as (event: MouseEvent<HTMLAnchorElement>) => void)({
      button: 1,
      preventDefault,
    } as unknown as MouseEvent<HTMLAnchorElement>)
    await flushPromises()
    expect(openExternalUrl).toHaveBeenCalledTimes(2)
  })

  it.each([
    'javascript:alert(1)',
    'file:///private/items/1',
    'https://user:password@example.com/items/1',
    'https://example.com\\@elsewhere.invalid/items/1',
  ])('never creates an unsafe platform link for %s', (listingUrl) => {
    const tree = ProductPublicationHistory({
      total: 1,
      publications: [{ ...publication, listingUrl }],
    })
    expect(elements(tree).some((node) => node.type === 'a')).toBe(false)
    expect(text(tree)).toContain('链接不可用')
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('reports a browser open failure and leaves the link available for retry', async () => {
    vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error('Open failed'))
    const tree = ProductPublicationHistory({ publications: [publication], total: 1 })
    const clickLink = () =>
      (link(tree).props.onClick as (event: MouseEvent<HTMLAnchorElement>) => void)({
        preventDefault: vi.fn(),
      } as unknown as MouseEvent<HTMLAnchorElement>)
    clickLink()
    await flushPromises()
    expect(toastSnapshot().some((item) => item.message.includes('无法打开'))).toBe(true)
    clickLink()
    await flushPromises()
    expect(openExternalUrl).toHaveBeenCalledTimes(2)
  })
})
