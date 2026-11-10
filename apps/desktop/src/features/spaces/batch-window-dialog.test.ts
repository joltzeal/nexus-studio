import {
  browserConnection,
  browserWindow,
  browserCreateInput,
} from '@/lib/platform/browser-test-support'
import { listBrowserConnections } from '@/lib/platform/browser-connections'
import type { ComponentProps, DependencyList, EffectCallback, MouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { bindAccount, listAccounts } from '@/features/accounts/api'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import {
  createBrowserWindow,
  reconcileBrowserOperation,
  listBrowserWindows,
  type WindowSettings,
} from '@/lib/platform/windows'
import { BatchWindowDialog } from './batch-window-dialog'
import { WindowEditor } from './window-editor'

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
vi.mock('@/lib/platform/windows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/windows')>()),
  createBrowserWindow: vi.fn(),
  reconcileBrowserOperation: vi.fn(),
  listBrowserWindows: vi.fn(),
}))
vi.mock('@/lib/platform/browser-connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/browser-connections')>()),
  listBrowserConnections: vi.fn(),
}))
vi.mock('@/lib/platform/native-groups', () => ({ listGroups: async () => [] }))
vi.mock('@/lib/platform/native-license', () => ({
  getLicenseStatus: async () => ({ configured: true }),
}))
vi.mock('@/features/accounts/api', () => ({
  listAccounts: vi.fn(),
  bindAccount: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const settings: WindowSettings = {
  platform: 'Vinted',
  note: 'batch',
  geoip: true,
  timezone: '',
  locale: '',
  viewport: 'default',
  fingerprintSeed: null,
  startUrl: '',
}
let hooks: KernelHookHarness
const onSettled = vi.fn()
const onClose = vi.fn()
let props: ComponentProps<typeof BatchWindowDialog>
const render = () => hooks.render(() => BatchWindowDialog(props))
const editor = () => components(render(), WindowEditor)[0]!.props

beforeEach(() => {
  vi.resetAllMocks()
  props = { onSettled, onClose }
  hooks = new KernelHookHarness(state)
  vi.mocked(listBrowserWindows).mockResolvedValue([])
  vi.mocked(listBrowserConnections).mockResolvedValue([browserConnection()])
  vi.mocked(reconcileBrowserOperation).mockResolvedValue(null)
  vi.mocked(createBrowserWindow).mockImplementation(async (input) =>
    browserWindow({
      id: input.name,
      name: input.name,
      connectionId: input.connectionId,
      settings: input.settings,
      kernelVersion: input.kernelVersion ?? '155.0.8059.39.2',
    }),
  )
})
afterEach(() => hooks.dispose())

describe('batch dialog kernel forwarding', () => {
  it.each(['http', 'https', 'socks5'])(
    'preserves the authenticated manual %s URL in each external batch intent',
    async (protocol) => {
      const external = browserConnection({
        id: 'bit',
        providerId: 'bitbrowser',
        capabilities: { ...browserConnection().capabilities, fingerprintSeed: false },
      })
      props.connection = external
      vi.mocked(listBrowserConnections).mockResolvedValue([external])
      render()
      hooks.flushEffects()
      await flushPromises()
      editor().batch?.onCountChange?.(1)
      const proxy = `${protocol}://fixture%40user:fixture%3Apass@proxy.test:1080`
      await editor().onSave({
        name: 'manual-batch',
        proxyMode: 'manual',
        proxy,
        proxyPlugin: null,
        proxyEndpoint: null,
        settings: { ...settings, fingerprintSeed: null, geoip: false },
        kernelVersion: null,
        groupId: null,
      })
      expect(createBrowserWindow).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          connectionId: external.id,
          proxyMode: 'manual',
          proxy,
        }),
      )
    },
  )

  it('never falls back to another provider when a fixed connection is no longer available', async () => {
    props.connection = browserConnection({ id: 'ads', providerId: 'adspower' })
    render()
    hooks.flushEffects()
    await flushPromises()
    expect(components(render(), WindowEditor)).toHaveLength(0)
    expect(text(render())).toContain('没有可用的创建接入')
    expect(createBrowserWindow).not.toHaveBeenCalled()
  })

  it('does not create after closing while the preflight request is pending', async () => {
    render()
    hooks.flushEffects()
    await flushPromises()
    editor().batch?.onCountChange?.(1)
    const pending = deferred<Awaited<ReturnType<typeof listBrowserConnections>>>()
    vi.mocked(listBrowserConnections).mockReturnValueOnce(pending.promise)
    const save = editor().onSave(browserCreateInput())
    hooks.dispose()
    pending.resolve([browserConnection()])
    await save
    expect(createBrowserWindow).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('creates and binds an account through the selected external connection', async () => {
    props.accounts = [{ id: 'account-1', label: 'shop@example.test' }]
    vi.mocked(listAccounts).mockResolvedValue({
      items: [
        {
          id: 'account-1',
          account: 'shop@example.test',
          loginMethod: 'email',
          password: '',
          phone: '',
          emailOtpUrl: '',
          smsOtpUrl: '',
          homepageUrl: '',
          note: '',
          status: 'active',
          createdAt: '2026-11-10T00:00:00Z',
          updatedAt: '2026-11-10T00:00:00Z',
        },
      ],
      bindings: [],
      total: 1,
      storageDurable: true,
    })
    vi.mocked(bindAccount).mockResolvedValue({ bound: true, duplicates: [] })
    const external = browserConnection({
      id: 'ads',
      providerId: 'adspower',
      capabilities: {
        ...browserConnection().capabilities,
        update: false,
        proxyPlugin: false,
        fingerprintSeed: false,
        kernelSelection: false,
        transfer: false,
      },
    })
    vi.mocked(listBrowserConnections).mockResolvedValue([browserConnection(), external])
    render()
    hooks.flushEffects()
    await flushPromises()
    components(editor().batch?.fields, Select)[0]!.props.onValueChange?.('ads')
    expect(editor().connection).toEqual(external)
    vi.mocked(createBrowserWindow).mockImplementationOnce(async (input) =>
      browserWindow({
        id: input.name,
        name: input.name,
        providerId: 'adspower',
        connectionId: input.connectionId,
        proxyMode: input.proxyMode,
        settings: input.settings,
        kernelVersion: null,
      }),
    )
    await editor().onSave({
      name: '',
      proxyMode: 'direct',
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      settings: { ...settings, geoip: false },
      groupId: null,
      kernelVersion: null,
    })
    expect(createBrowserWindow).toHaveBeenCalledExactlyOnceWith({
      connectionId: 'ads',
      operationId: expect.any(String),
      name: 'shop@example.test',
      proxyMode: 'direct',
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      settings: { ...settings, geoip: false, fingerprintSeed: null },
      groupId: null,
      kernelVersion: null,
    })
    expect(bindAccount).toHaveBeenCalledExactlyOnceWith(
      'account-1',
      'shop@example.test',
      false,
    )
    expect(
      vi.mocked(listBrowserWindows).mock.calls.every((args) => args.length === 0),
    ).toBe(true)
  })

  it('keeps the selected package and seed when retrying from the result screen', async () => {
    render()
    hooks.flushEffects()
    await flushPromises()
    editor().batch?.onCountChange?.(2)
    vi.mocked(createBrowserWindow).mockRejectedValueOnce(new Error('download failed'))
    await editor().onSave({
      name: 'fixed',
      proxyMode: 'direct',
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      settings,
      groupId: 'group-one',
      kernelVersion: '155.0.8059.39.1',
    })
    expect(
      vi.mocked(createBrowserWindow).mock.calls.map(([input]) => input.kernelVersion),
    ).toEqual(['155.0.8059.39.1', '155.0.8059.39.1'])
    expect(components(render(), WindowEditor)).toHaveLength(0)
    const retry = components(render(), Button).find(
      (node) => text(node.props.children) === '重试未完成项',
    )!
    retry.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
    await flushPromises()
    expect(vi.mocked(createBrowserWindow).mock.calls[2]![0].kernelVersion).toBe(
      '155.0.8059.39.1',
    )
    expect(
      vi.mocked(createBrowserWindow).mock.calls[2]![0].settings.fingerprintSeed,
    ).toBe(vi.mocked(createBrowserWindow).mock.calls[0]![0].settings.fingerprintSeed)
    expect(onSettled).toHaveBeenCalledTimes(2)
    expect(text(render())).toContain('已完成 2/2')
  })

  it('freezes the full package after resolving latest for the first creation', async () => {
    render()
    hooks.flushEffects()
    await flushPromises()
    editor().batch?.onCountChange?.(2)
    const source = browserCreateInput({ name: 'latest', settings })
    const input = {
      name: source.name,
      proxyMode: source.proxyMode,
      proxy: source.proxy,
      proxyPlugin: source.proxyPlugin,
      proxyEndpoint: source.proxyEndpoint,
      settings: source.settings,
      groupId: source.groupId,
      kernelVersion: source.kernelVersion,
    }
    await editor().onSave(input)
    expect(vi.mocked(createBrowserWindow).mock.calls[0]![0].kernelVersion).toBeNull()
    expect(vi.mocked(createBrowserWindow).mock.calls[1]![0].kernelVersion).toBe(
      '155.0.8059.39.2',
    )
    expect(text(render())).toContain('已完成 2/2')
    expect(settings.fingerprintSeed).toBeNull()
  })
})
