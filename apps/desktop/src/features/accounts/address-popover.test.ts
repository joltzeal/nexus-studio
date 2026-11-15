import { type DependencyList, type EffectCallback, type MouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog'
import { Popover } from '@/components/ui/popover'
import { toast } from '@/components/ui/toast'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness as HookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { copyText } from '@/lib/clipboard'
import { AccountAddressPopover } from './address-popover'
import { assignAccountAddress } from './api'
import type { AccountAddressSetResult } from './types'

const state = vi.hoisted(() => ({ hooks: null as HookHarness | null }))
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
  assignAccountAddress: vi.fn(),
}))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const address = {
  id: 'profile-albany',
  street: 'Example Street',
  houseNumber: '12',
  city: 'Albany',
  postalCode: '12207',
  countryCode: 'US',
  state: 'New York',
  county: 'Albany County',
  latitude: 42.65,
  longitude: -73.75,
  source: 'osm' as const,
  sourceUrl: 'https://www.openstreetmap.org/node/123',
  approximate: false,
  firstName: 'Marie',
  lastName: 'Exemple',
  username: 'marie.exemple',
  linkedAt: '2026-11-11T10:00:00.000Z',
}
const receipt: AccountAddressSetResult = {
  address: null,
  updatedAt: '2026-11-12T10:00:00.000Z',
  storageDurable: true,
}
let hooks: HookHarness
let props: Parameters<typeof AccountAddressPopover>[0]
const tree = () => hooks.render(() => AccountAddressPopover(props))
const button = (label: string) =>
  components(tree(), Button).find(
    (node) => node.props['aria-label'] === label || text(node.props.children) === label,
  )!
const click = (label: string) =>
  button(label).props.onClick?.({} as MouseEvent<HTMLButtonElement>)
const confirmation = () => components(tree(), AlertDialog).find((node) => node.props.open)
const confirm = () =>
  components(tree(), AlertDialogAction)[0]!.props.onClick?.({
    preventDefault: vi.fn(),
  } as unknown as MouseEvent<HTMLButtonElement>)

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new HookHarness(state)
  props = {
    account: { id: 'account-1', account: 'synthetic@example.test', address },
    ready: true,
    onUnlinked: vi.fn(),
    onPendingChange: vi.fn(),
  }
  vi.mocked(copyText).mockResolvedValue(true)
})
afterEach(() => hooks.dispose())

describe('account address popover', () => {
  it('shows the independent snapshot and copies every postal part with recipient and username', async () => {
    expect(text(tree())).toContain('Albany')
    expect(text(tree())).toContain('New York')
    expect(text(tree())).toContain('Albany County')
    expect(text(tree())).toContain('marie.exemple')
    expect(assignAccountAddress).not.toHaveBeenCalled()
    click('复制完整地址')
    await flushPromises()
    expect(copyText).toHaveBeenCalledExactlyOnceWith(
      'Marie Exemple\nmarie.exemple\n12 Example Street\nAlbany, New York 12207\nAlbany County\nUS',
    )
    expect(toast.success).toHaveBeenCalledWith('完整地址已复制')
  })

  it.each([null, undefined])(
    'shows an empty cell without an unlink action for %j',
    (value) => {
      props.account =
        value === undefined
          ? { id: 'account-1', account: 'synthetic@example.test' }
          : { ...props.account, address: value }
      expect(text(tree())).toBe('—')
      expect(components(tree(), Popover)).toHaveLength(0)
      expect(assignAccountAddress).not.toHaveBeenCalled()
    },
  )

  it('confirms the affected account and address and cancels without a write', () => {
    click('解绑地址')
    expect(assignAccountAddress).not.toHaveBeenCalled()
    expect(props.onPendingChange).not.toHaveBeenCalled()
    expect(confirmation()).toBeDefined()
    const description = text(components(tree(), AlertDialogDescription)[0]!)
    expect(description).toContain('synthetic@example.test')
    expect(description).toContain('Albany')
    expect(description).toContain('12207')
    confirmation()!.props.onOpenChange?.(false)
    expect(confirmation()).toBeUndefined()
    expect(assignAccountAddress).not.toHaveBeenCalled()
    expect(props.onUnlinked).not.toHaveBeenCalled()
  })

  it('unlinks with the confirmed profile ID once and refreshes only after a successful write', async () => {
    const write = deferred<AccountAddressSetResult>()
    const refreshed = deferred<void>()
    vi.mocked(assignAccountAddress).mockReturnValueOnce(write.promise)
    vi.mocked(props.onUnlinked).mockReturnValueOnce(refreshed.promise)
    const unlink = button('解绑地址').props.onClick!
    unlink({} as MouseEvent<HTMLButtonElement>)
    unlink({} as MouseEvent<HTMLButtonElement>)
    expect(assignAccountAddress).not.toHaveBeenCalled()
    const action = components(tree(), AlertDialogAction)[0]!.props.onClick!
    action({ preventDefault: vi.fn() } as unknown as MouseEvent<HTMLButtonElement>)
    action({ preventDefault: vi.fn() } as unknown as MouseEvent<HTMLButtonElement>)
    expect(assignAccountAddress).toHaveBeenCalledExactlyOnceWith(
      'account-1',
      null,
      'profile-albany',
    )
    expect(button('解绑地址').props.disabled).toBe(true)
    expect(components(tree(), AlertDialogCancel)[0]!.props.disabled).toBe(true)
    confirmation()!.props.onOpenChange?.(false)
    expect(confirmation()).toBeDefined()
    expect(props.onUnlinked).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    write.resolve(receipt)
    await flushPromises()
    expect(props.onUnlinked).toHaveBeenCalledExactlyOnceWith(receipt)
    expect(button('解绑地址').props.disabled).toBe(true)
    refreshed.resolve()
    await flushPromises()
    expect(props.onPendingChange).toHaveBeenNthCalledWith(1, true)
    expect(props.onPendingChange).toHaveBeenLastCalledWith(false)
    expect(toast.success).toHaveBeenCalledWith('地址已解绑')
    expect(confirmation()).toBeUndefined()
  })

  it.each(['存储写入失败', '账号地址已变化，请刷新后重试', '账号不存在或已被删除'])(
    'preserves the displayed snapshot and permits retry after %s',
    async (failure) => {
      vi.mocked(assignAccountAddress).mockRejectedValueOnce(new Error(failure))
      click('解绑地址')
      confirm()
      await flushPromises()
      expect(text(tree())).toContain('解绑地址失败')
      expect(confirmation()).toBeDefined()
      expect(text(tree())).toContain('12 Example Street')
      expect(button('解绑地址').props.disabled).toBe(false)
      expect(props.onUnlinked).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
      vi.mocked(assignAccountAddress).mockResolvedValueOnce(receipt)
      confirm()
      await flushPromises()
      expect(props.onUnlinked).toHaveBeenCalledWith(receipt)
      expect(text(tree())).not.toContain(failure)
      expect(confirmation()).toBeUndefined()
    },
  )

  it('keeps the snapshot readable and copyable when writes are unavailable', async () => {
    props.ready = false
    expect(button('解绑地址').props.disabled).toBe(true)
    click('解绑地址')
    expect(assignAccountAddress).not.toHaveBeenCalled()
    click('复制完整地址')
    await flushPromises()
    expect(copyText).toHaveBeenCalledTimes(1)
  })

  it('reports clipboard refusal without a success message', async () => {
    vi.mocked(copyText).mockResolvedValueOnce(false)
    click('复制完整地址')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('复制失败，请检查剪贴板权限后重试。')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('marks an in-memory unlink as limited to this run', async () => {
    vi.mocked(assignAccountAddress).mockResolvedValueOnce({
      ...receipt,
      storageDurable: false,
    })
    click('解绑地址')
    confirm()
    await flushPromises()
    expect(toast.success).toHaveBeenCalledWith('地址已解绑（仅本次运行）')
  })

  it('does not unlink a replacement address or submit after writes become unavailable', () => {
    click('解绑地址')
    props.ready = false
    confirm()
    expect(assignAccountAddress).not.toHaveBeenCalled()
    props.ready = true
    props.account = { ...props.account, address: { ...address, id: 'replacement' } }
    confirm()
    expect(assignAccountAddress).not.toHaveBeenCalled()
    expect(confirmation()).toBeDefined()
    expect(text(tree())).toContain('已变化')
  })
})
