import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginUiViewSchema } from '@nexus/plugin-sdk/ui'
import type { PluginView } from './types'
import { runtimePlugin } from './ui-runtime.test-support'
import { frontOf, useToastStore } from '../../shared/model/toast'
import { pluginUiRuntime, startPluginUiRuntime } from './ui-runtime'
import { pluginProfileStatus } from './ui-profile-store'

const mocks = vi.hoisted(() => ({
  play: vi.fn<(channel: string, code: string) => Promise<boolean>>(),
  arm: vi.fn<() => Promise<boolean>>(),
  close: vi.fn(),
  write: vi.fn<(text: string) => Promise<void>>(),
  invoke: vi.fn<(command: string, args: unknown) => Promise<unknown>>(),
  catalog: { plugins: [] as PluginView[], error: null as string | null },
  catalogListeners: new Set<() => void>(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../shared/lib/clipboard', () => ({ clip: { write: mocks.write } }))
vi.mock('./verification-sound', () => ({
  VerificationSound: class {
    play = mocks.play
    arm = mocks.arm
    close = mocks.close
  },
}))
vi.mock('./catalog', () => ({
  usePluginCatalog: {
    getState: () => mocks.catalog,
    subscribe: (listener: () => void) => {
      mocks.catalogListeners.add(listener)
      return () => mocks.catalogListeners.delete(listener)
    },
  },
}))

const target = {
  pluginId: 'example.plugin',
  viewId: 'profile',
  profileId: '00000000-0000-4000-8000-000000000001',
  connectionId: 'connection',
  identity: 'install:process',
}
const notice = (id: string, speech = false) => ({
  id,
  title: '验证码已收到',
  message: '请复制验证码',
  tone: 'success',
  copyText: '001234',
  ...(speech ? { speech: { channel: 'sms', code: '001234' } } : {}),
})
const view = (notices: ReturnType<typeof notice>[]) =>
  PluginUiViewSchema.parse({
    protocolVersion: 1,
    revision: '1',
    title: 'Example',
    sections: [],
    notices,
  })
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
const clearToasts = () => {
  const store = useToastStore.getState()
  for (const item of store.items) {
    store.dismiss(item.id)
    store.remove(item.id)
  }
}
let stop: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  clearToasts()
  mocks.catalog.plugins = [runtimePlugin]
  mocks.catalog.error = null
  mocks.play.mockResolvedValue(true)
  mocks.arm.mockResolvedValue(true)
  mocks.write.mockResolvedValue(undefined)
  mocks.invoke.mockResolvedValue({ state: 'pending' })
  stop = startPluginUiRuntime()
})
afterEach(() => {
  stop?.()
  stop = undefined
  clearToasts()
  vi.useRealTimers()
})

describe('native plugin UI notifications', () => {
  it('retains the code and copy action when sound fails, with fixed safe warning feedback', async () => {
    mocks.play.mockResolvedValue(false)
    const next = view([notice('code', true)])
    pluginUiRuntime.observe(target, next)
    pluginUiRuntime.observe(target, next)
    await flush()
    const items = useToastStore.getState().items
    const code = items.find((item) => item.persistent)!
    expect(items).toHaveLength(2)
    expect(items.find((item) => item.kind === 'warn')?.title).toBe(
      '验证码语音播放失败，可复制通知中的验证码',
    )
    expect(code.leaving).not.toBe(true)
    expect(mocks.play).toHaveBeenCalledExactlyOnceWith('sms', '001234')
    expect(code.action?.run()).toBe(false)
    await flush()
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('001234')
    expect(
      useToastStore.getState().items.find((item) => item.id === code.id)?.action?.label,
    ).toBe('已复制')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(
      useToastStore.getState().items.find((item) => item.id === code.id)?.leaving,
    ).not.toBe(true)
  })

  it('keeps more than three distinct persistent results until each is dismissed', async () => {
    pluginUiRuntime.observe(
      target,
      view(Array.from({ length: 6 }, (_, index) => notice(`code-${index}`))),
    )
    let live = useToastStore.getState().items.filter((item) => !item.leaving)
    expect(live).toHaveLength(6)
    expect(new Set(live.map((item) => item.dedupeKey)).size).toBe(6)
    expect(frontOf(live)).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(60_000)
    live = useToastStore.getState().items.filter((item) => !item.leaving)
    expect(live).toHaveLength(6)
    const latest = frontOf(live).at(-1)!
    useToastStore.getState().dismiss(latest.id)
    live = useToastStore.getState().items.filter((item) => !item.leaving)
    expect(live).toHaveLength(5)
    expect(frontOf(live)).toHaveLength(3)
    expect(frontOf(live).some((item) => item.id === latest.id)).toBe(false)
  })

  it('suppresses late sound failure feedback after runtime cleanup', async () => {
    let resolve: (played: boolean) => void = () => {}
    mocks.play.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    pluginUiRuntime.observe(target, view([notice('code', true)]))
    stop?.()
    stop = undefined
    resolve(false)
    await flush()
    expect(
      useToastStore.getState().items.filter((item) => item.kind === 'warn'),
    ).toHaveLength(0)
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('converts unexpected audio rejection into the same safe warning', async () => {
    mocks.play.mockRejectedValue(new Error('private device information'))
    pluginUiRuntime.observe(target, view([notice('code', true)]))
    await flush()
    const warning = useToastStore.getState().items.find((item) => item.kind === 'warn')
    expect(warning?.title).toBe('验证码语音播放失败，可复制通知中的验证码')
    expect(warning?.detail).toBeUndefined()
  })
})

it('uses the scoped native profile batch command and clears tones after catalog failure', async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    expect(command).toBe('plugin_ui_profiles')
    const input = (args as { input: { profileIds: string[] } }).input
    return {
      items: input.profileIds.map((profileId) => ({
        profileId,
        tone: 'success',
        label: '正常',
      })),
    }
  })
  const first = pluginProfileStatus.watch(target, target.profileId)
  const secondId = '00000000-0000-4000-8000-000000000002'
  const second = pluginProfileStatus.watch(target, secondId)
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('plugin_ui_profiles', {
    input: {
      pluginId: target.pluginId,
      viewId: target.viewId,
      connectionId: target.connectionId,
      identity: target.identity,
      profileIds: [target.profileId, secondId],
    },
  })
  expect(pluginProfileStatus.snapshot(target, target.profileId)?.tone).toBe('success')
  mocks.catalog.error = 'unavailable'
  for (const listener of mocks.catalogListeners) listener()
  expect(pluginProfileStatus.snapshot(target, target.profileId)).toBeNull()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(mocks.invoke).toHaveBeenCalledOnce()
  first()
  second()
})

it('uses independent native task mediation and cancels with the original process identity', async () => {
  const waiting = PluginUiViewSchema.parse({
    protocolVersion: 1,
    revision: '1',
    title: 'Example',
    sections: [],
    tasks: [
      {
        id: 'waiting',
        label: '等待结果',
        deadlineAt: Date.now() + 30_000,
        timeoutNotice: {
          id: 'timeout',
          title: '等待结束',
          message: '已到截止时间',
          tone: 'warning',
        },
      },
    ],
  })
  pluginUiRuntime.observe(target, waiting)
  await flush()
  expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'plugin_ui_task_command', {
    input: {
      ...target,
      taskId: 'waiting',
      operation: 'poll',
    },
  })
  mocks.catalog.plugins = [{ ...runtimePlugin, runtimeGeneration: 'replacement' }]
  for (const listener of mocks.catalogListeners) listener()
  expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'plugin_ui_task_command', {
    input: {
      ...target,
      taskId: 'waiting',
      operation: 'cancel',
    },
  })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
  expect(useToastStore.getState().items).toHaveLength(0)
})

it('cancels a shared task through the runtime before a delayed native result can time out', async () => {
  let resolve: (value: unknown) => void = () => {}
  mocks.invoke.mockImplementation((_, args) => {
    const input = (args as { input: { operation: string } }).input
    return input.operation === 'cancel'
      ? Promise.resolve(null)
      : new Promise((done) => {
          resolve = done
        })
  })
  const waiting = PluginUiViewSchema.parse({
    protocolVersion: 1,
    revision: '1',
    title: 'Example',
    sections: [],
    tasks: [
      {
        id: 'waiting',
        label: '等待结果',
        deadlineAt: Date.now() + 5000,
        timeoutNotice: {
          id: 'timeout',
          title: '等待结束',
          message: '已到截止时间',
          tone: 'warning',
        },
      },
    ],
  })
  pluginUiRuntime.observe(target, waiting)
  pluginUiRuntime.cancel(
    { ...target, profileId: '00000000-0000-4000-8000-000000000002' },
    ['waiting'],
  )
  expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'plugin_ui_task_command', {
    input: {
      ...target,
      taskId: 'waiting',
      operation: 'cancel',
    },
  })
  await vi.advanceTimersByTimeAsync(10_000)
  resolve({ state: 'done', notices: [notice('late-code', true)] })
  await flush()
  expect(useToastStore.getState().items).toHaveLength(0)
  expect(mocks.play).not.toHaveBeenCalled()
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
})
