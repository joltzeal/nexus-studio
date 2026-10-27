import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_TOASTS,
  Toaster,
  clearToasts,
  dismissToast,
  pushToast,
  toast,
  toastSnapshot,
} from './toast'

// Keep the actual toast rendering; only bypass the DOM portal in Node tests.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: ReactNode) => children,
}))

function persistent(message: string, onClick = () => {}) {
  return pushToast('success', message, {
    duration: 0,
    action: { label: '复制验证码', onClick },
  })
}

function renderToasts() {
  vi.stubGlobal('document', { body: {} })
  return renderToStaticMarkup(createElement(Toaster))
}

afterEach(() => {
  clearToasts()
  vi.useRealTimers()
  vi.unstubAllGlobals()
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
    expect(toastSnapshot().map((item) => item.id)).toEqual(before)
    dismissToast(before[0]!)
    expect(toastSnapshot()[MAX_TOASTS - 1]?.message).toBe('新的常驻提示')
    clearToasts()
    toast.success('清空后可显示')
    expect(toastSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(6000)
    expect(toastSnapshot()).toHaveLength(0)
  })
})

describe('persistent toast queue', () => {
  it('preserves every unread action and promotes overflow in arrival order', () => {
    vi.useFakeTimers()
    const copied: string[] = []
    const messages = ['账号一', '账号二', '账号三', '账号四', '账号五']
    const ids = messages.map((message) =>
      persistent(message, () => {
        copied.push(message)
      }),
    )

    expect(toastSnapshot().map((item) => item.message)).toEqual([
      '账号一',
      '账号二',
      '账号三',
    ])
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(vi.getTimerCount()).toBe(0)
    expect(copied).toEqual([])

    dismissToast(ids[0]!)
    expect(toastSnapshot().map((item) => item.message)).toEqual([
      '账号二',
      '账号三',
      '账号四',
    ])
    toastSnapshot()[2]?.action?.onClick()
    expect(copied).toEqual(['账号四'])

    dismissToast(ids[1]!)
    expect(toastSnapshot().map((item) => item.message)).toEqual([
      '账号三',
      '账号四',
      '账号五',
    ])
    toastSnapshot()[2]?.action?.onClick()
    expect(copied).toEqual(['账号四', '账号五'])
    for (const id of ids.slice(2)) dismissToast(id)
    expect(toastSnapshot()).toEqual([])
  })

  it('drops transient overflow without displacing visible or queued actions', () => {
    vi.useFakeTimers()
    const ids = ['一', '二', '三', '四'].map((message) => persistent(message))
    toast.error('临时错误')
    toast.success('临时成功')
    expect(toastSnapshot().map((item) => item.message)).toEqual(['一', '二', '三'])
    expect(vi.getTimerCount()).toBe(0)

    dismissToast(ids[1]!)
    expect(toastSnapshot().map((item) => item.message)).toEqual(['一', '三', '四'])
  })

  it('dismisses a queued id without removing visible notices or reviving it later', () => {
    const ids = ['一', '二', '三', '四', '五'].map((message) => persistent(message))
    dismissToast(ids[3]!)
    expect(toastSnapshot().map((item) => item.message)).toEqual(['一', '二', '三'])
    expect(renderToasts()).toContain('1 条提示待查看')

    dismissToast(ids[3]!)
    dismissToast(ids[0]!)
    expect(toastSnapshot().map((item) => item.message)).toEqual(['二', '三', '五'])
    expect(renderToasts()).not.toContain('条提示待查看')
  })

  it('replaces a queued duplicate with the latest action and id', () => {
    vi.useFakeTimers()
    let copied = ''
    const visible = ['一', '二', '三'].map((message) => persistent(message))
    const stale = persistent('四', () => {
      copied = '旧结果'
    })
    const replacement = persistent(' 四 ', () => {
      copied = '新结果'
    })

    expect(toastSnapshot().map((item) => item.id)).toEqual(visible)
    expect(renderToasts()).toContain('1 条提示待查看')
    dismissToast(stale)
    for (const id of visible) dismissToast(id)
    expect(toastSnapshot().map((item) => item.id)).toEqual([replacement])
    expect(copied).toBe('')
    toastSnapshot()[0]?.action?.onClick()
    expect(copied).toBe('新结果')
    dismissToast(replacement)
    expect(toastSnapshot()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces a visible duplicate once while preserving older queued actions', () => {
    const ids = ['一', '二', '三', '四'].map((message) => persistent(message))
    const replacement = persistent(' 一 ')

    expect(toastSnapshot().map((item) => item.message)).toEqual(['二', '三', '四'])
    expect(renderToasts()).toContain('1 条提示待查看')
    dismissToast(ids[0]!)
    dismissToast(ids[1]!)
    expect(toastSnapshot().map((item) => item.id)).toEqual([ids[2], ids[3], replacement])
    expect(renderToasts()).not.toContain('条提示待查看')
  })

  it('removes a queued duplicate replaced by a transient instead of retaining stale content', () => {
    vi.useFakeTimers()
    const ids = ['一', '二', '三', '四'].map((message) => persistent(message))
    expect(renderToasts()).toContain('1 条提示待查看')

    toast.success(' 四 ')
    expect(toastSnapshot().map((item) => item.message)).toEqual(['一', '二', '三'])
    expect(renderToasts()).not.toContain('条提示待查看')
    expect(vi.getTimerCount()).toBe(0)
    for (const id of ids) dismissToast(id)
    expect(toastSnapshot()).toEqual([])
  })

  it('renders at most three cards and updates the pending count as notices are dismissed', () => {
    const ids = ['账号一', '账号二', '账号三', '账号四', '账号五'].map((message) =>
      persistent(message),
    )
    const html = renderToasts()
    expect(html.match(/class="toast toast-/g)).toHaveLength(MAX_TOASTS)
    expect(html).toContain('2 条提示待查看')
    expect(html).toContain('账号一')
    expect(html).not.toContain('账号四')
    expect(html).not.toContain('账号五')

    dismissToast(ids[0]!)
    const promoted = renderToasts()
    expect(promoted).toContain('1 条提示待查看')
    expect(promoted).toContain('账号四')
    dismissToast(ids[4]!)
    expect(renderToasts()).not.toContain('条提示待查看')
  })

  it('clears pending notices and all timers without later promotion or resurrection', () => {
    vi.useFakeTimers()
    toast.info('会被替换的临时消息', { duration: 500 })
    const ids = ['一', '二', '三', '四'].map((message) => persistent(message))
    expect(renderToasts()).toContain('1 条提示待查看')

    clearToasts()
    expect(toastSnapshot()).toEqual([])
    expect(renderToasts()).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    for (const id of ids) dismissToast(id)

    toast.success('新的临时消息')
    expect(vi.getTimerCount()).toBe(1)
    clearToasts()
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(toastSnapshot()).toEqual([])
    expect(renderToasts()).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restarts a replaced transient timer and ignores the old id', () => {
    vi.useFakeTimers()
    const old = toast.info('重复提示', { duration: 1000 })
    vi.advanceTimersByTime(500)
    const replacement = toast.info('重复提示', { duration: 2000 })
    dismissToast(old)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1500)
    expect(toastSnapshot().map((item) => item.id)).toEqual([replacement])
    vi.advanceTimersByTime(500)
    expect(toastSnapshot()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
