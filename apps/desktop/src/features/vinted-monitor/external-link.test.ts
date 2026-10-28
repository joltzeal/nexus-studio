import {
  isValidElement,
  type AnchorHTMLAttributes,
  type DependencyList,
  type EffectCallback,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { openExternalUrl } from '@/lib/platform/external-url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from '@/components/ui/toast'
import { Button } from '@/components/ui/button'
import { onAiImageHandoff } from '@/lib/page-handoff'
import {
  components,
  elements,
  flushPromises,
  KernelHookHarness as HookHarness,
} from '@/features/settings/kernel-test-support'
import { getItem, listItems, listMonitors, listProxies } from './api'
import { VintedExternalLink } from './external-link'
import { ItemDetailSheet } from './item-detail-sheet'
import { VintedItemsTable } from './items-table'
import { MonitorListView } from './monitor-list'
import { SellerProfile } from './seller-profile'
import { DEFAULT_MONITOR, type Item, type Seller } from './types'

const state = vi.hoisted(() => ({ hooks: null as HookHarness | null }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('@/lib/platform/external-url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/external-url')>()),
  openExternalUrl: vi.fn(),
}))
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  getItem: vi.fn(),
  listItems: vi.fn(),
  listMonitors: vi.fn(),
  listProxies: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const seller: Seller = {
  id: 'vinted.fr:456',
  externalId: '456',
  domain: 'vinted.fr',
  login: 'synthetic-seller',
  name: null,
  profileUrl: 'https://www.vinted.fr/member/456',
  avatarUrl: null,
  country: 'France',
  city: null,
  feedbackReputation: null,
  feedbackCount: null,
  followersCount: null,
  itemCount: null,
  verification: {},
  lastLogedOnTs: null,
  updatedOn: null,
  collectedAt: null,
  checkedAt: '2026-10-26T10:00:00Z',
  error: null,
  detail: null,
}
const item: Item = {
  id: 'vinted.fr:123',
  externalId: '123',
  domain: 'vinted.fr',
  monitorId: 'monitor-1',
  monitorIds: ['monitor-1'],
  title: 'Synthetic product',
  price: '10',
  currency: 'EUR',
  brand: '',
  size: '',
  condition: '',
  url: 'https://www.vinted.fr/items/123',
  imageUrl: '',
  seller: 'synthetic-seller',
  userId: '456',
  sellerProfile: seller,
  favouriteCount: 0,
  viewCount: null,
  starred: false,
  availabilityStatus: 'unknown',
  missingSince: null,
  missingMonitorId: null,
  statusCheckedAt: null,
  statusNote: null,
  collectedAt: '2026-10-26T10:00:00Z',
  listedAt: null,
  firstSeenAt: '2026-10-26T10:00:00Z',
  lastSeenAt: '2026-10-26T10:00:00Z',
  images: [],
  detail: {},
}

let hooks: HookHarness
beforeEach(() => {
  vi.resetAllMocks()
  hooks = new HookHarness(state)
  vi.mocked(openExternalUrl).mockResolvedValue(undefined)
  vi.mocked(listItems).mockResolvedValue({
    items: [item],
    total: 1,
    page: 0,
    pageSize: 20,
    totalPages: 1,
  })
  vi.mocked(listMonitors).mockResolvedValue({
    items: [],
    itemCounts: {},
    total: 0,
    storageDurable: true,
  })
  vi.mocked(listProxies).mockResolvedValue({
    items: [],
    defaultProxyId: null,
    storageDurable: true,
  })
  vi.mocked(getItem).mockResolvedValue({ item })
})
afterEach(() => hooks.dispose())

function anchor(props: Parameters<typeof VintedExternalLink>[0]) {
  const node = VintedExternalLink(props)
  if (!isValidElement<AnchorHTMLAttributes<HTMLAnchorElement>>(node)) {
    throw new Error('Expected an external link')
  }
  return node
}

function click(node: ReactElement<AnchorHTMLAttributes<HTMLAnchorElement>>, button = 0) {
  const event = {
    button,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
  const handler = button === 0 ? node.props.onClick : node.props.onAuxClick
  handler?.(event as unknown as MouseEvent<HTMLAnchorElement>)
  return event
}

function openLink(tree: ReactNode, url: string) {
  const link = components(tree, VintedExternalLink).find(
    (node) => node.props.href === url,
  )
  expect(link).toBeDefined()
  click(anchor(link!.props))
}

describe('Vinted external links', () => {
  it('dispatches clicks to the native opener and prevents WebView/row navigation', async () => {
    const link = anchor({ href: item.url, children: '查看原商品' })
    const event = click(link)
    await flushPromises()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(item.url)
    expect(link.props).toMatchObject({
      href: item.url,
      target: '_blank',
      rel: 'noopener noreferrer',
    })
    const key = { key: 'Enter', stopPropagation: vi.fn(), preventDefault: vi.fn() }
    link.props.onKeyDown?.(key as unknown as KeyboardEvent<HTMLAnchorElement>)
    expect(key.stopPropagation).toHaveBeenCalledOnce()
    expect(key.preventDefault).not.toHaveBeenCalled()
  })

  it('handles middle click once and leaves right click available for copying', () => {
    const link = anchor({ href: item.url, children: '查看原商品' })
    const middle = click(link, 1)
    expect(middle.preventDefault).toHaveBeenCalledOnce()
    expect(openExternalUrl).toHaveBeenCalledOnce()
    const right = click(link, 2)
    expect(right.preventDefault).not.toHaveBeenCalled()
    expect(openExternalUrl).toHaveBeenCalledOnce()
  })

  it('reports opener failure without raw diagnostics and permits retry', async () => {
    vi.mocked(openExternalUrl).mockRejectedValueOnce(
      new Error('sensitive native diagnostics'),
    )
    const link = anchor({ href: item.url, children: '查看原商品' })
    click(link)
    await flushPromises()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      '无法打开链接，请重试或复制链接后在浏览器中打开。',
    )
    click(link)
    await flushPromises()
    expect(openExternalUrl).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('renders no actionable link for unsafe archived URLs', () => {
    for (const href of ['javascript:alert(1)', 'https://user:secret@vinted.fr/items/1']) {
      expect(VintedExternalLink({ href, children: '查看原商品' })).toBeNull()
      expect(VintedExternalLink({ href, children: '查看原商品', fallback: '—' })).toBe(
        '—',
      )
    }
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('opens the original product from the main item table', async () => {
    const tree = () => hooks.render(() => VintedItemsTable({ aiImageReady: false }))
    tree()
    hooks.flushEffects()
    await flushPromises()
    openLink(tree(), item.url)
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(item.url)
  })

  it('hands the gallery selection and editable public product text to AI without generating', async () => {
    const tree = () => hooks.render(() => VintedItemsTable({ aiImageReady: true }))
    tree()
    hooks.flushEffects()
    await flushPromises()
    const generate = components(tree(), Button).find(
      (node) => node.props['aria-label'] === `生成商品场景 ${item.title}`,
    )!
    const listener = vi.fn()
    const unsubscribe = onAiImageHandoff(listener)
    try {
      generate.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
      const sheet = components(tree(), ItemDetailSheet)[0]!
      const fullItem = {
        ...item,
        brand: 'Synthetic brand',
        detail: { description: 'Public product description', token: 'private token' },
      }
      sheet.props.onGenerate(fullItem, ['third.webp', 'first.webp'])
      expect(listener).toHaveBeenCalledExactlyOnceWith({
        presentation: 'dialog',
        images: ['third.webp', 'first.webp'],
        title: item.title,
        source: {
          pluginId: 'studio.vinted-monitor',
          itemId: item.id,
          title: item.title,
          url: item.url,
        },
        initialPrompt:
          '标题：Synthetic product\n品牌：Synthetic brand\n描述：Public product description',
      })
      expect(components(tree(), ItemDetailSheet)).toHaveLength(0)
      expect(openExternalUrl).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it.each([false, true])(
    'opens the original product from detail/gallery preview=%s',
    async (preview) => {
      const tree = () =>
        hooks.render(() =>
          ItemDetailSheet({
            itemId: item.id,
            preview,
            aiImageReady: false,
            onClose: vi.fn(),
            onGenerate: vi.fn(),
            onHistory: vi.fn(),
            onChanged: vi.fn(),
          }),
        )
      tree()
      hooks.flushEffects()
      await flushPromises()
      const detail = elements(tree()).find((node) => node.props.item === item)
      expect(detail).toBeDefined()
      const renderDetail = detail!.type as (props: Record<string, unknown>) => ReactNode
      const detailHooks = new HookHarness(state)
      try {
        const content = detailHooks.render(() => renderDetail(detail!.props))
        openLink(content, item.url)
        if (!preview) {
          const profile = components(content, SellerProfile)[0]!
          openLink(SellerProfile(profile.props), seller.profileUrl)
          expect(openExternalUrl).toHaveBeenNthCalledWith(1, item.url)
          expect(openExternalUrl).toHaveBeenLastCalledWith(seller.profileUrl)
        } else {
          expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(item.url)
        }
      } finally {
        detailHooks.dispose()
      }
    },
  )

  it('opens the seller homepage from the shared seller profile', () => {
    openLink(SellerProfile({ seller, itemId: item.id }), seller.profileUrl)
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(seller.profileUrl)
  })

  it('opens the monitoring source URL through the same adapter', async () => {
    const searchUrl = 'https://www.vinted.fr/catalog?search_text=coat'
    vi.mocked(listMonitors).mockResolvedValue({
      items: [
        {
          ...DEFAULT_MONITOR,
          id: 'monitor-1',
          searchUrl,
          kind: 'catalog',
          host: 'vinted.fr',
          userId: null,
          proxyId: null,
          createdAt: '2026-10-26T10:00:00Z',
          updatedAt: '2026-10-26T10:00:00Z',
          lastRunAt: null,
          lastStatus: null,
        },
      ],
      itemCounts: {},
      total: 1,
      storageDurable: true,
    })
    const tree = () =>
      hooks.render(() =>
        MonitorListView({
          refreshKey: 0,
          modern: true,
          onItems: vi.fn(),
          onConfigureProxies: vi.fn(),
        }),
      )
    tree()
    hooks.flushEffects()
    await flushPromises()
    openLink(tree(), searchUrl)
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(searchUrl)
  })
})
