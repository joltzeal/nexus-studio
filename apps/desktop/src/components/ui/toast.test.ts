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
})
