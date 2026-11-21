import type { ChangeEvent, DependencyList, MouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button, Input } from '@proxyshard/shardx-ui-kit'
import {
  ComponentHooks,
  components,
  flushPromises,
} from '../../../raccoon/plugins/component.test-support'
import { OrderWatch } from './OrderWatch'

const state = vi.hoisted(() => ({
  hooks: null as ComponentHooks | null,
  connectionId: 'workspace-1',
  generation: 'process-1',
  available: true,
  settings: vi.fn(),
  list: vi.fn(),
  history: vi.fn(),
  save: vi.fn(),
  run: vi.fn(),
  enabled: vi.fn(),
  items: vi.fn(),
  bark: vi.fn(),
}))
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
    useEffect: (callback: () => void | (() => void), deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(callback, deps) : react.useEffect(callback, deps),
    useCallback: <T extends (...args: never[]) => unknown>(
      callback: T,
      deps: DependencyList,
    ) => {
      if (!state.hooks) return react.useCallback(callback, deps)
      const [value, setValue] = state.hooks.state(() => ({ callback, deps }))
      const previous = value as { callback: T; deps: DependencyList }
      if (
        deps.length === previous.deps.length &&
        deps.every((item, index) => Object.is(item, previous.deps[index]))
      )
        return previous.callback
      setValue({ callback, deps })
      return callback
    },
  }
})
vi.mock('@proxyshard/shardx-ui-kit', () => ({
  Alert: () => null,
  Button: () => null,
  Input: () => null,
  Modal: () => null,
  Select: () => null,
}))
vi.mock('../../../raccoon/plugins/catalog', () => ({
  usePluginCatalog: (select: (value: unknown) => unknown) =>
    select({
      plugins: [
        {
          id: 'studio.vinted-accounts',
          installation: 'installation-1',
          runtimeGeneration: state.generation,
          version: '1.6.0',
          source: 'local',
          sourceDirectory: '/controlled-plugin',
        },
      ],
    }),
}))
vi.mock('../../../raccoon/plugins/vinted-accounts/api', () => ({
  supportsAccountOptional: () => state.available,
  accountsApi: {
    orderWatchSettings: () => state.settings(),
    orderWatches: () => state.list(),
    orderWatchHistory: (id: string) => state.history(id),
    saveOrderWatchSettings: (input: unknown) => state.save(input),
    runOrderWatch: (id: string) => state.run(id),
    setOrderWatchEnabled: (id: string, enabled: boolean) => state.enabled(id, enabled),
    orderWatchItems: (id: string, page: number) => state.items(id, page),
    testOrderWatchBark: () => state.bark(),
  },
}))
vi.mock('../../../raccoon/runtime', () => ({ isNativeRaccoon: () => true }))
vi.mock('../../../raccoon/store', () => ({
  useWorkspace: () => ({ connectionId: state.connectionId }),
}))

const initialSettings = {
  intervalMinutes: 5,
  bark: { baseUrl: 'https://bark.example.test', deviceKey: '', enabled: false },
}
const watch = (accountId = 'account-1') => ({
  accountId,
  homepageUrl: 'https://www.vinted.com/member/123',
  enabled: true,
  running: false,
  lastCompleteAt: '2026-11-19T00:00:00Z',
  lastItemCount: 0,
  lastError: null,
  nextRunAt: '2026-11-19T01:00:00Z',
  pendingCount: 1,
  soldCount: 2,
})
const history = [
  {
    id: 'candidate-1',
    itemId: '123',
    itemUrl: 'https://www.vinted.com/items/123',
    title: '历史商品',
    status: 'pending',
    lastSeenAt: '2026-11-18T00:00:00Z',
    missingAt: '2026-11-19T00:00:00Z',
    checkedAt: null,
    checkError: null,
    notifiedAt: null,
    notifyError: null,
  },
]
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tree = () => {
  const render = () =>
    state.hooks!.render(() =>
      OrderWatch({
        accounts: [{ id: 'account-1', account: 'seller@example.test' }],
        onClose: vi.fn(),
      }),
    )
  render()
  state.hooks!.flush()
  return render()
}
const button = (label: string) =>
  components(tree(), Button).find((item) => item.props.children === label)!
const click = (label: string) =>
  button(label).props.onClick?.({} as MouseEvent<HTMLButtonElement>)
const interval = () =>
  components(tree(), Input).find((item) => item.props.label === '检查间隔（分钟）')!
const changeInterval = (value: string) =>
  interval().props.onChange?.({ target: { value } } as ChangeEvent<HTMLInputElement>)

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  state.hooks = new ComponentHooks()
  state.connectionId = 'workspace-1'
  state.generation = 'process-1'
  state.available = true
  state.settings.mockReset().mockResolvedValue(initialSettings)
  state.list.mockReset().mockResolvedValue({ items: [watch()] })
  state.history.mockReset().mockResolvedValue(history)
  state.save.mockReset().mockImplementation(async (input) => input)
  state.run.mockReset().mockResolvedValue({ queued: true })
  state.enabled.mockReset().mockResolvedValue({ enabled: false })
  state.items.mockReset().mockResolvedValue({
    items: [
      {
        id: '123',
        title: '衣柜商品',
        url: 'https://www.vinted.com/items/123',
        imageUrl: null,
      },
    ],
    total: 11,
    page: 1,
    pageSize: 10,
    lastCompleteAt: watch().lastCompleteAt,
    lastError: null,
  })
  state.bark.mockReset().mockResolvedValue({ sent: true })
})
afterEach(() => {
  state.hooks?.dispose()
  state.hooks = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('v2 account product monitoring', () => {
  it('polls every five seconds without overlapping pending reads', async () => {
    tree()
    await flushPromises()
    expect(state.list).toHaveBeenCalledTimes(1)
    const pending = deferred<{ items: ReturnType<typeof watch>[] }>()
    state.list.mockReturnValueOnce(pending.promise)
    vi.advanceTimersByTime(4999)
    expect(state.list).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(state.list).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(15000)
    expect(state.list).toHaveBeenCalledTimes(2)
    pending.resolve({ items: [watch()] })
    await flushPromises()
    vi.advanceTimersByTime(5000)
    expect(state.list).toHaveBeenCalledTimes(3)
    state.hooks!.dispose()
    vi.advanceTimersByTime(20000)
    expect(state.list).toHaveBeenCalledTimes(3)
  })

  it('refreshes the selected history and keeps closed history closed', async () => {
    tree()
    await flushPromises()
    click('核查记录')
    await flushPromises()
    expect(state.history).toHaveBeenCalledExactlyOnceWith('account-1')
    expect(JSON.stringify(tree())).toContain('历史商品')
    const pending = deferred<typeof history>()
    state.history.mockReturnValueOnce(pending.promise)
    vi.advanceTimersByTime(5000)
    expect(state.history).toHaveBeenCalledTimes(2)
    click('关闭记录')
    pending.resolve(history)
    await flushPromises()
    expect(JSON.stringify(tree())).not.toContain('历史商品')
    vi.advanceTimersByTime(5000)
    expect(state.history).toHaveBeenCalledTimes(2)
  })

  it('keeps a closed wardrobe snapshot closed after a pending page returns', async () => {
    tree()
    await flushPromises()
    click('查看商品')
    await flushPromises()
    expect(JSON.stringify(tree())).toContain('衣柜商品')
    const pending = deferred<unknown>()
    state.items.mockReturnValueOnce(pending.promise)
    click('下一页')
    click('关闭')
    pending.resolve({
      items: [],
      total: 11,
      page: 2,
      pageSize: 10,
      lastCompleteAt: null,
      lastError: null,
    })
    await flushPromises()
    expect(JSON.stringify(tree())).not.toContain('监控商品')
  })

  it.each(['workspace', 'plugin', 'unavailable'])(
    'invalidates delayed reads on %s changes',
    async (change) => {
      tree()
      await flushPromises()
      const pending = deferred<{ items: ReturnType<typeof watch>[] }>()
      state.list.mockReturnValueOnce(pending.promise)
      vi.advanceTimersByTime(5000)
      state.list.mockResolvedValue({ items: [watch('current-monitor')] })
      if (change === 'workspace') state.connectionId = 'workspace-2'
      if (change === 'plugin') state.generation = 'process-2'
      if (change === 'unavailable') state.available = false
      tree()
      await flushPromises()
      const calls = state.list.mock.calls.length
      pending.resolve({ items: [watch('stale-monitor')] })
      await flushPromises()
      expect(JSON.stringify(tree())).not.toContain('stale-monitor')
      if (change === 'unavailable') {
        vi.advanceTimersByTime(20000)
        expect(state.list).toHaveBeenCalledTimes(calls)
      } else expect(JSON.stringify(tree())).toContain('current-monitor')
    },
  )

  it('serializes saves and keeps a newer settings draft after the response', async () => {
    tree()
    await flushPromises()
    const pending = deferred<typeof initialSettings>()
    state.save.mockReturnValueOnce(pending.promise)
    changeInterval('9')
    click('保存设置')
    expect(state.save).toHaveBeenCalledExactlyOnceWith({
      ...initialSettings,
      intervalMinutes: 9,
    })
    click('刷新监控状态')
    vi.advanceTimersByTime(10000)
    expect(state.list).toHaveBeenCalledTimes(1)
    changeInterval('12')
    pending.resolve({ ...initialSettings, intervalMinutes: 9 })
    await flushPromises()
    expect(interval().props.value).toBe('12')
  })

  it('shows scan evidence, history links and timestamps and disables paused runs', async () => {
    state.list.mockResolvedValue({ items: [{ ...watch(), enabled: false }] })
    tree()
    await flushPromises()
    expect(button('立即检查').props.disabled).toBe(true)
    const summary = JSON.stringify(tree())
    expect(summary).toContain('最近完整扫描')
    expect(summary).toContain('0 件')
    expect(summary).toContain('下次检查')
    expect(summary).toContain('https://www.vinted.com/member/123')
    click('核查记录')
    await flushPromises()
    const detail = JSON.stringify(tree())
    expect(detail).toContain('最后可见')
    expect(detail).toContain('首次消失')
    expect(detail).toContain('https://www.vinted.com/items/123')
  })
})
