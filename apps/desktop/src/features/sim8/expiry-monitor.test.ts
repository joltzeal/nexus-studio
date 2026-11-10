import { describe, expect, it, vi } from 'vitest'
import { deferred, flushPromises } from '@/features/settings/kernel-test-support'
import type { ExpirySnapshot } from './types'
import { NumberExpiryMonitor } from './expiry-monitor'

const item = {
  tel: '+14155550100',
  expiresAt: '2026-11-03T10:00:00.000Z',
  checkedAt: null,
}
const snapshot = (overrides: Partial<ExpirySnapshot> = {}): ExpirySnapshot => ({
  items: [item],
  pendingTels: [],
  failed: 0,
  storageDurable: true,
  ...overrides,
})

function fixture() {
  const api = {
    list: vi.fn(async () => snapshot()),
    refresh: vi.fn<(tels: string[]) => Promise<ExpirySnapshot>>(async () => snapshot()),
    dismiss: vi.fn<(tel: string, expiresAt: string) => Promise<ExpirySnapshot>>(
      async () => snapshot({ items: [] }),
    ),
  }
  const changed = vi.fn()
  const monitor = new NumberExpiryMonitor(changed, api)
  return { monitor, api, changed }
}

describe('window expiry monitor', () => {
  it('loads cached reminders first and drains bounded check batches without overlapping polls', async () => {
    const { monitor, api } = fixture()
    api.list.mockResolvedValue(snapshot({ pendingTels: [item.tel] }))
    const request = deferred<ExpirySnapshot>()
    api.refresh.mockReturnValue(request.promise)
    monitor.setAvailability('ready')
    await flushPromises()
    expect(monitor.state.snapshot?.items).toEqual([item])
    expect(monitor.state.checking).toBe(true)
    await monitor.refresh()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.refresh).toHaveBeenCalledExactlyOnceWith([item.tel])
    request.resolve(snapshot())
    await flushPromises()
    expect(monitor.state.checking).toBe(false)
  })

  it('keeps a reminder visible until dismissal is persisted and never resurrects it from a stale read', async () => {
    const { monitor, api } = fixture()
    monitor.setAvailability('ready')
    await flushPromises()
    const stale = deferred<ExpirySnapshot>()
    const save = deferred<ExpirySnapshot>()
    api.list.mockReturnValueOnce(stale.promise)
    api.dismiss.mockReturnValueOnce(save.promise)
    const checking = monitor.refresh()
    const dismissing = monitor.dismiss(item)
    expect(monitor.state.snapshot?.items).toEqual([item])
    expect(monitor.state.dismissing).toContain(item.tel)
    save.resolve(snapshot({ items: [] }))
    await dismissing
    stale.resolve(snapshot())
    await checking
    expect(monitor.state.snapshot?.items).toEqual([])
  })

  it('preserves reminders after a failed write and permits retry', async () => {
    const { monitor, api } = fixture()
    monitor.setAvailability('ready')
    await flushPromises()
    api.dismiss.mockRejectedValueOnce(new Error('磁盘写入失败'))
    await monitor.dismiss(item)
    expect(monitor.state.snapshot?.items).toEqual([item])
    expect(monitor.state.error).toContain('磁盘写入失败')
    expect(monitor.state.dismissing).toEqual([])
    await monitor.dismiss(item)
    expect(monitor.state.snapshot?.items).toEqual([])
  })

  it('reads reminders again on subsequent daily polls instead of hiding dismissed numbers forever', async () => {
    const { monitor } = fixture()
    monitor.setAvailability('ready')
    await flushPromises()
    await monitor.dismiss(item)
    expect(monitor.state.snapshot?.items).toEqual([])
    await monitor.refresh()
    expect(monitor.state.snapshot?.items).toEqual([item])
  })

  it('ignores late results after disabling/restarting a plugin and does not invoke unsupported methods', async () => {
    const { monitor, api } = fixture()
    monitor.setAvailability('upgrade')
    await monitor.refresh()
    expect(api.list).not.toHaveBeenCalled()
    const old = deferred<ExpirySnapshot>()
    api.list.mockReturnValueOnce(old.promise)
    monitor.setAvailability('ready')
    monitor.setAvailability('hidden')
    old.resolve(snapshot())
    await flushPromises()
    expect(monitor.state.snapshot).toBeNull()
    expect(monitor.state.availability).toBe('hidden')
    monitor.setAvailability('ready')
    await flushPromises()
    expect(monitor.state.snapshot?.items).toEqual([item])
    monitor.stop()
  })

  it('retains cached reminders when the plugin call fails', async () => {
    const { monitor, api } = fixture()
    monitor.setAvailability('ready')
    await flushPromises()
    api.list.mockRejectedValueOnce(new Error('插件暂不可用'))
    await monitor.refresh()
    expect(monitor.state.snapshot?.items).toEqual([item])
    expect(monitor.state.error).toContain('插件暂不可用')
  })
})
