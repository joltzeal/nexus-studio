import { type DependencyList, type EffectCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Popover } from '@/components/ui/popover'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { openExternalUrl } from '@/lib/platform/external-url'
import { listOrderWatchItems } from './api'
import { AccountWardrobePopover } from './account-wardrobe-popover'
import type { OrderWardrobePage } from './order-watch-types'

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
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  listOrderWatchItems: vi.fn(),
}))
vi.mock('@/lib/platform/external-url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/external-url')>()),
  openExternalUrl: vi.fn(),
}))

const page = (overrides: Partial<Parameters<typeof AccountWardrobePopover>[0]> = {}) =>
  state.hooks!.render(() =>
    AccountWardrobePopover({
      account: {
        id: 'seller-1',
        account: 'Seller One',
        homepageUrl: 'https://www.vinted.com/member/1',
      },
      ready: true,
      ...overrides,
    }),
  )

function snapshot(pageNumber = 1): OrderWardrobePage {
  return {
    items: [
      {
        id: String(pageNumber),
        url: `https://www.vinted.com/items/${pageNumber}`,
        title: `Canvas ${pageNumber}`,
        imageUrl: null,
      },
    ],
    total: 11,
    page: pageNumber,
    pageSize: 10,
    lastCompleteAt: '2026-11-16T08:00:00.000Z',
    lastError: null,
  }
}

async function settle() {
  for (let index = 0; index < 3; index += 1) {
    page()
    state.hooks!.flushEffects()
    await flushPromises()
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  state.hooks = new KernelHookHarness(state)
  vi.mocked(listOrderWatchItems).mockResolvedValue(snapshot())
  vi.mocked(openExternalUrl).mockResolvedValue(undefined)
})

afterEach(() => {
  state.hooks?.dispose()
  state.hooks = null
})

describe('window account wardrobe', () => {
  it('loads only on open, pages the saved snapshot, and opens a product in the system browser', async () => {
    expect(listOrderWatchItems).not.toHaveBeenCalled()
    components(page(), Popover)[0]!.props.onOpenChange?.(true)
    await settle()
    expect(listOrderWatchItems).toHaveBeenCalledWith('seller-1', 1)
    expect(text(page())).toContain('Canvas 1')
    vi.mocked(listOrderWatchItems).mockResolvedValue(snapshot(2))
    components(page(), Button)
      .find((node) => text(node.props.children) === '下一页')!
      .props.onClick?.({} as never)
    await settle()
    expect(listOrderWatchItems).toHaveBeenCalledWith('seller-1', 2)
    expect(text(page())).toContain('Canvas 2')
    components(page(), Button)
      .find((node) => node.props['aria-label'] === '打开商品 Canvas 2')!
      .props.onClick?.({} as never)
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.vinted.com/items/2')
  })

  it('discards a late response after close and reloads on reopen', async () => {
    const pending = deferred<OrderWardrobePage>()
    vi.mocked(listOrderWatchItems).mockReturnValueOnce(pending.promise)
    components(page(), Popover)[0]!.props.onOpenChange?.(true)
    components(page(), Popover)[0]!.props.onOpenChange?.(false)
    pending.resolve(snapshot())
    await settle()
    expect(text(page())).not.toContain('Canvas 1')
    components(page(), Popover)[0]!.props.onOpenChange?.(true)
    await settle()
    expect(listOrderWatchItems).toHaveBeenCalledTimes(2)
    expect(text(page())).toContain('Canvas 1')
  })

  it('explains empty and failed scans without launching a remote scan', async () => {
    vi.mocked(listOrderWatchItems).mockResolvedValue({
      ...snapshot(),
      items: [],
      total: 0,
      lastCompleteAt: null,
      lastError: '暂时无法查询',
    })
    components(page(), Popover)[0]!.props.onOpenChange?.(true)
    await settle()
    expect(text(page())).toContain('尚无完整衣柜快照')
    expect(text(page())).toContain('暂时无法查询')
    expect(listOrderWatchItems).toHaveBeenCalledTimes(1)
  })

  it('does not read an account without a homepage, and retries a failed cache read', async () => {
    const missing = {
      account: { id: 'seller-1', account: 'Seller One', homepageUrl: '' },
    }
    components(page(missing), Popover)[0]!.props.onOpenChange?.(true)
    expect(text(page(missing))).toContain('请先为账号填写')
    expect(listOrderWatchItems).not.toHaveBeenCalled()
    components(page(missing), Popover)[0]!.props.onOpenChange?.(false)

    vi.mocked(listOrderWatchItems).mockRejectedValueOnce(new Error('offline'))
    components(page(), Popover)[0]!.props.onOpenChange?.(true)
    await settle()
    expect(text(page())).toContain('读取商品快照失败')
    components(page(), Button)
      .find((node) => text(node.props.children) === '重新读取')!
      .props.onClick?.({} as never)
    await settle()
    expect(text(page())).toContain('Canvas 1')
    expect(listOrderWatchItems).toHaveBeenCalledTimes(2)
  })
})
