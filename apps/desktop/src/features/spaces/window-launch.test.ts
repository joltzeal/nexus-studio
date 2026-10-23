import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeProfile } from '@/lib/platform/native-profiles'
import { launchAndConfirm, LaunchUnconfirmedError } from './window-launch'

afterEach(() => vi.useRealTimers())

function runningProfile(running: boolean): NativeProfile {
  return {
    id: 'a',
    name: 'A',
    version: '155.0.1.2',
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
    groupId: null,
    running,
    createdAt: 0,
    lastOpenedAt: null,
    settings: {
      platform: 'Vinted',
      note: '',
      geoip: true,
      timezone: '',
      locale: '',
      viewport: 'default',
      fingerprintSeed: 42,
      startUrl: '',
    },
  }
}

describe('window launch confirmation', () => {
  it('reports launch success only after the host confirms a running profile', async () => {
    await expect(
      launchAndConfirm(
        'a',
        async () => undefined,
        async () => [runningProfile(true)],
      ),
    ).resolves.toEqual([runningProfile(true)])
    await expect(
      launchAndConfirm(
        'a',
        async () => undefined,
        async () => [runningProfile(false)],
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
