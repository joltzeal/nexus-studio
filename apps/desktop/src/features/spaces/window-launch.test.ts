import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from '@/lib/platform/windows'
import { browserWindow } from '@/lib/platform/browser-test-support'
import { launchAndConfirm, LaunchUnconfirmedError } from './window-launch'

afterEach(() => vi.useRealTimers())

function windowWithState(state: BrowserWindow['state']): BrowserWindow {
  return browserWindow({ id: 'a', state })
}

describe('window launch confirmation', () => {
  it('reports launch success only after the host confirms a running profile', async () => {
    await expect(
      launchAndConfirm(
        'a',
        async () => undefined,
        async () => [windowWithState('running')],
      ),
    ).resolves.toEqual([windowWithState('running')])
    await expect(
      launchAndConfirm(
        'a',
        async () => undefined,
        async () => [windowWithState('stopped')],
      ),
    ).rejects.toBeInstanceOf(LaunchUnconfirmedError)
  })

  it('does not mask a native fail-closed rejection with a profile refresh', async () => {
    let refreshed = false
    await expect(
      launchAndConfirm(
        'a',
        async () => {
          throw new Error('必需代理解析失败，启动已阻断')
        },
        async () => {
          refreshed = true
          return []
        },
      ),
    ).rejects.toThrow('启动已阻断')
    expect(refreshed).toBe(false)
  })

  it('bounds a stalled native launch and describes its outcome as unconfirmed', async () => {
    vi.useFakeTimers()
    const launch = launchAndConfirm(
      'a',
      () => new Promise(() => undefined),
      async () => [],
    )
    const result = expect(launch).rejects.toBeInstanceOf(LaunchUnconfirmedError)
    await vi.advanceTimersByTimeAsync(120_000)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not report launch failure when only the subsequent status read fails', async () => {
    await expect(
      launchAndConfirm(
        'a',
        async () => undefined,
        async () => {
          throw new Error('状态接口暂不可用')
        },
      ),
    ).rejects.toMatchObject({
      name: 'LaunchUnconfirmedError',
      message: expect.stringContaining('状态接口暂不可用'),
    })
  })
})
