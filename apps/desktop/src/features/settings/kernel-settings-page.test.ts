import type {
  ChangeEvent,
  ComponentProps,
  DependencyList,
  EffectCallback,
  FormEvent,
  MouseEvent,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  checkLatestKernel,
  downloadKernel,
  getKernelStatus,
  KernelOperationError,
  nativeKernelsAvailable,
} from '@/lib/platform/native-kernels'
import { KernelSettingsPage } from './kernel-settings-page'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  kernelStatus,
  text,
} from './kernel-test-support'

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
vi.mock('@/lib/platform/native-kernels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-kernels')>()),
  checkLatestKernel: vi.fn(),
  downloadKernel: vi.fn(),
  getKernelStatus: vi.fn(),
  nativeKernelsAvailable: vi.fn(),
}))

let hooks: KernelHookHarness
const render = () => hooks.render(KernelSettingsPage)
const click = (button: ComponentProps<typeof Button>) =>
  button.onClick?.({} as MouseEvent<HTMLButtonElement>)
const button = (label: string) =>
  components(render(), Button).find((node) => text(node.props.children) === label)!.props
const input = () => components(render(), Input)[0]!.props
function typeVersion(value: string) {
  input().onChange?.({ target: { value } } as ChangeEvent<HTMLInputElement>)
}
function submit() {
  const form = elements(render()).find((node) => node.type === 'form')!
  ;(form.props.onSubmit as (event: FormEvent) => void)({
    preventDefault: () => {},
  } as FormEvent)
}
async function mount() {
  render()
  hooks.flushEffects()
  await flushPromises()
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  vi.mocked(nativeKernelsAvailable).mockReturnValue(true)
  vi.mocked(getKernelStatus).mockResolvedValue(kernelStatus())
  vi.mocked(checkLatestKernel).mockResolvedValue({
    version: '156.0.1.2.3',
    platform: 'darwin-arm64',
    checkedAt: '2026-10-26T00:00:00Z',
  })
  vi.mocked(downloadKernel).mockResolvedValue('155.0.8059.39')
})
afterEach(() => hooks.dispose())

describe('kernel settings download targets', () => {
  it.each([
    '',
    'latest',
    '155.0.8059',
    '155.0.8059.39.2.1',
    '/local/browser',
    '1'.repeat(49),
  ])('rejects malformed input %j without a download request', async (value) => {
    await mount()
    typeVersion(value)
    submit()
    expect(downloadKernel).not.toHaveBeenCalled()
    expect(input()['aria-invalid']).toBe(true)
    expect(text(render())).toContain('完整包版本')
  })

  it('trims an exact target and refreshes inventory after success', async () => {
    await mount()
    typeVersion(' 155.0.8059.39.2 ')
    submit()
    await flushPromises()
    expect(downloadKernel).toHaveBeenCalledExactlyOnceWith('155.0.8059.39.2')
    expect(input().value).toBe('155.0.8059.39.2')
    expect(getKernelStatus).toHaveBeenCalledWith(true)
    expect(text(render())).toContain(
      '内核包 155.0.8059.39.2 已下载（Chrome 155.0.8059.39）',
    )
  })

  it('keeps latest as a fresh default even after a target was typed', async () => {
    await mount()
    typeVersion('155.0.8059.39.2')
    click(button('下载最新内核'))
    await flushPromises()
    expect(downloadKernel).toHaveBeenCalledExactlyOnceWith()
  })

  it('shares the pending guard across both buttons and retries the failed target', async () => {
    const pending = deferred<string>()
    vi.mocked(downloadKernel).mockReturnValueOnce(pending.promise)
    await mount()
    typeVersion('155.0.8059.39.2')
    submit()
    expect(button('下载最新内核').disabled).toBe(true)
    expect(button('下载指定版本').disabled).toBe(true)
    // A second handler invocation cannot bypass the in-flight command guard.
    click(button('下载最新内核'))
    submit()
    expect(downloadKernel).toHaveBeenCalledTimes(1)
    pending.reject(
      new KernelOperationError({
        code: 'NETWORK',
        message: '下载连接中断。',
        retryable: true,
      }),
    )
    await flushPromises()
    expect(input().value).toBe('155.0.8059.39.2')
    expect(text(render())).toContain('下载连接中断。')
    typeVersion('156.0.1.2.3')
    click(button('重试下载'))
    await flushPromises()
    expect(downloadKernel).toHaveBeenNthCalledWith(2, '155.0.8059.39.2')
    expect(input().value).toBe('155.0.8059.39.2')
    expect(text(render())).not.toContain('下载连接中断。')
  })

  it.each([null, '155.0.8059.39.2'])(
    'retries a persisted failed job for target %j after remount',
    async (requestedVersion) => {
      const status = kernelStatus()
      status.download = {
        ...status.download,
        phase: 'failed',
        requestedVersion,
        version: '155.0.8059.39',
        error: { code: 'NETWORK', message: '网络暂时不可用。', retryable: true },
      }
      vi.mocked(getKernelStatus).mockResolvedValue(status)
      await mount()
      click(button('重试下载'))
      await flushPromises()
      if (requestedVersion === null) {
        expect(downloadKernel).toHaveBeenCalledExactlyOnceWith()
      } else {
        expect(downloadKernel).toHaveBeenCalledExactlyOnceWith(requestedVersion)
        expect(input().value).toBe(requestedVersion)
      }
    },
  )

  it('does not infer an unknown legacy target from the Chrome display version', async () => {
    const status = kernelStatus()
    delete status.download.requestedVersion
    status.download.phase = 'failed'
    status.download.version = '155.0.8059.39'
    status.download.error = { code: 'NETWORK', message: '连接中断', retryable: true }
    vi.mocked(getKernelStatus).mockResolvedValue(status)
    await mount()
    expect(
      components(render(), Button).some(
        (node) => text(node.props.children) === '重试下载',
      ),
    ).toBe(false)
    expect(downloadKernel).not.toHaveBeenCalled()
  })

  it('blocks both downloads for an active background job or missing activation', async () => {
    const status = kernelStatus()
    status.download.phase = 'downloading'
    status.download.requestedVersion = '155.0.8059.39.2'
    vi.mocked(getKernelStatus).mockResolvedValue(status)
    await mount()
    expect(button('下载最新内核').disabled).toBe(true)
    expect(button('下载指定版本').disabled).toBe(true)
    click(button('下载最新内核'))
    typeVersion('156.0.1.2.3')
    submit()
    expect(downloadKernel).not.toHaveBeenCalled()
    hooks.dispose()
    hooks = new KernelHookHarness(state)
    vi.mocked(getKernelStatus).mockResolvedValue({
      ...kernelStatus(),
      activationConfigured: false,
    })
    await mount()
    expect(button('下载最新内核').disabled).toBe(true)
    expect(button('下载指定版本').disabled).toBe(true)
  })

  it('does not fetch or offer native actions in browser preview', async () => {
    vi.mocked(nativeKernelsAvailable).mockReturnValue(false)
    await mount()
    expect(getKernelStatus).not.toHaveBeenCalled()
    expect(checkLatestKernel).not.toHaveBeenCalled()
    expect(components(render(), Input)).toHaveLength(0)
    expect(text(render())).toContain('桌面应用专属')
  })
})
