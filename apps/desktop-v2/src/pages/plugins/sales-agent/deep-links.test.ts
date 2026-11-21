import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type EventCallback } from '@tauri-apps/api/event'
import { startAgentDeepLinks } from '../../../raccoon/plugins/agent-deep-links'
import { navigateDetail } from '../../../raccoon/plugins/detail-navigation'
import { toast } from '../../../shared/model/toast'
import { deferred, flushPromises } from './test-support'
import { ids } from './test-data'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('../../../raccoon/plugins/detail-navigation', async (original) => ({
  ...(await original<typeof import('../../../raccoon/plugins/detail-navigation')>()),
  navigateDetail: vi.fn(),
}))
vi.mock('../../../shared/model/toast', () => ({ toast: { err: vi.fn() } }))

let stop: (() => void) | undefined
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isTauri).mockReturnValue(true)
})
afterEach(() => stop?.())

it('subscribes before reading startup links and only navigates to validated batch records', async () => {
  let receive: EventCallback<string[]> | undefined
  const unlisten = vi.fn()
  vi.mocked(listen).mockImplementation(async (_event, callback) => {
    receive = callback as EventCallback<string[]>
    return unlisten
  })
  vi.mocked(invoke).mockResolvedValue([`nexus://agent/${ids.batch}`])
  stop = startAgentDeepLinks()
  await flushPromises()
  expect(listen).toHaveBeenCalledWith('deep-link://new-url', expect.any(Function))
  expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin:deep-link|get_current')
  expect(navigateDetail).toHaveBeenCalledExactlyOnceWith({
    kind: 'agent',
    id: ids.batch,
    batchId: ids.batch,
  })
  receive?.({
    event: 'deep-link://new-url',
    id: 1,
    payload: [
      `nexus://agent/${ids.batch}?action=publish`,
      'https://example.test',
      `nexus://agent/${ids.job}`,
    ],
  })
  expect(navigateDetail).toHaveBeenCalledTimes(2)
  expect(navigateDetail).toHaveBeenLastCalledWith({
    kind: 'agent',
    id: ids.job,
    batchId: ids.job,
  })
  stop()
  expect(unlisten).toHaveBeenCalledOnce()
})

it('cleans up a late subscription without processing startup links after unmount', async () => {
  const subscription = deferred<() => void>()
  const unlisten = vi.fn()
  vi.mocked(listen).mockReturnValue(subscription.promise)
  stop = startAgentDeepLinks()
  stop()
  subscription.resolve(unlisten)
  await flushPromises()
  expect(unlisten).toHaveBeenCalledOnce()
  expect(invoke).not.toHaveBeenCalled()
  expect(navigateDetail).not.toHaveBeenCalled()
})

it('reports link initialization failures without exposing a raw native error', async () => {
  vi.mocked(listen).mockRejectedValue(new Error('private native diagnostic'))
  stop = startAgentDeepLinks()
  await flushPromises()
  expect(toast.err).toHaveBeenCalledExactlyOnceWith(
    '无法监听 Ecom Agent 任务链接，请从运行记录打开任务。',
  )
  expect(navigateDetail).not.toHaveBeenCalled()
})

it('does not register a native listener in web previews', async () => {
  vi.mocked(isTauri).mockReturnValue(false)
  stop = startAgentDeepLinks()
  await flushPromises()
  expect(listen).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})
