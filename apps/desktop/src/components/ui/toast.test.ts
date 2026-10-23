import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_TOASTS,
  clearToasts,
  dismissToast,
  pushToast,
  toast,
  toastSnapshot,
} from './toast'

afterEach(() => {
  clearToasts()
  vi.useRealTimers()
})

describe('toast store', () => {
  it('keeps the newest toast last and exposes the message', () => {
    toast.success('已复制')
    toast.error('复制失败')
    expect(toastSnapshot().map((item) => [item.tone, item.message])).toEqual([
      ['success', '已复制'],
      ['error', '复制失败'],
    ])
  })

  it('ignores blank messages', () => {
    toast.success('   ')
    expect(toastSnapshot()).toHaveLength(0)
  })

  it('replaces a repeated message instead of stacking it', () => {
    toast.success('已复制')
    toast.success('已复制')
    expect(toastSnapshot()).toHaveLength(1)
  })

  it(`keeps at most ${MAX_TOASTS} toasts and drops the oldest`, () => {
    for (let index = 1; index <= MAX_TOASTS + 2; index += 1) {
      pushToast('info', `第 ${index} 条`)
    }
    expect(toastSnapshot().map((item) => item.message)).toEqual(
      Array.from({ length: MAX_TOASTS }, (_, index) => `第 ${index + 3} 条`),
    )
  })

  it('dismisses by id', () => {
    const id = toast.info('稍后关闭')
    dismissToast(id)
    expect(toastSnapshot()).toHaveLength(0)
  })

  it('auto-dismisses success sooner than an error', () => {
    vi.useFakeTimers()
    toast.success('成功')
    toast.error('失败')
    vi.advanceTimersByTime(2700)
    expect(toastSnapshot().map((item) => item.tone)).toEqual(['error'])
    vi.advanceTimersByTime(3000)
    expect(toastSnapshot()).toHaveLength(0)
  })

  it('keeps an update notice visible for its requested duration', () => {
    vi.useFakeTimers()
    toast.info('发现新版本', { duration: 12_000 })
    vi.advanceTimersByTime(11_999)
    expect(toastSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toastSnapshot()).toHaveLength(0)
  })

  it('keeps a downloaded update action until dismissed without invoking it automatically', () => {
    vi.useFakeTimers()
    let installs = 0
    const id = toast.info('新版已下载', {
      duration: 0,
      action: {
        label: '立即更新',
        onClick: () => {
          installs += 1
        },
      },
    })
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(installs).toBe(0)
    expect(toastSnapshot()).toHaveLength(1)
    expect(toastSnapshot()[0]?.action?.label).toBe('立即更新')
    toastSnapshot()[0]?.action?.onClick()
    expect(installs).toBe(1)
    dismissToast(id)
    expect(toastSnapshot()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer of a duplicate toast replaced by a persistent action', () => {
    vi.useFakeTimers()
    toast.info('新版已下载')
    toast.info('新版已下载', {
      duration: 0,
      action: { label: '立即更新', onClick: () => {} },
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(toastSnapshot()).toHaveLength(1)
  })

  it('preserves a persistent action through a burst while bounding transient toasts', () => {
    vi.useFakeTimers()
    let installs = 0
    const notice = toast.info('新版已下载', {
      duration: 0,
      action: {
        label: '立即更新',
        onClick: () => {
          installs += 1
        },
      },
    })
    for (let index = 0; index < MAX_TOASTS + 2; index += 1) {
      toast.success(`普通提示 ${index}`)
    }

    expect(toastSnapshot().map((item) => item.message)).toEqual([
      '新版已下载',
      '普通提示 3',
      '普通提示 4',
    ])
    expect(vi.getTimerCount()).toBe(2)
    expect(installs).toBe(0)
    vi.advanceTimersByTime(6000)
    expect(toastSnapshot().map((item) => item.id)).toEqual([notice])
    toastSnapshot()[0]?.action?.onClick()
    expect(installs).toBe(1)
  })

  it('does not evict persistent notices or leave a timer when all slots are occupied', () => {
    vi.useFakeTimers()
    for (let index = 0; index < MAX_TOASTS; index += 1) {
      toast.info(`常驻提示 ${index}`, { duration: 0 })
    }
    const before = toastSnapshot().map((item) => item.id)
    toast.success('普通提示')
    expect(toastSnapshot().map((item) => item.id)).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)

    toast.info('新的常驻提示', { duration: 0 })
    expect(toastSnapshot()).toHaveLength(MAX_TOASTS)
    expect(toastSnapshot()[MAX_TOASTS - 1]?.message).toBe('新的常驻提示')
    clearToasts()
    toast.success('清空后可显示')
    expect(toastSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(6000)
    expect(toastSnapshot()).toHaveLength(0)
  })
})
