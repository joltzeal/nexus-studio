import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { sendAgentNotification } from './notifications.js'

function input() {
  return {
    notificationId: randomUUID(),
    batchId: randomUUID(),
    kind: 'completed' as const,
    settings: { enabled: true, deviceKey: 'fixture-device-key' },
    title: 'Batch finished',
    body: '2 published, 1 needs review.',
  }
}

describe('sales Agent Bark notifications', () => {
  it('sends one bounded summary with a task link through the injected network client', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{"code":200}', { headers: { 'content-type': 'application/json' } }),
      )
    const notification = input()
    expect(await sendAgentNotification(notification, { fetchImpl })).toEqual({
      delivered: true,
      notificationId: notification.notificationId,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.day.app/push')
    expect(JSON.parse(String(options?.body))).toMatchObject({
      device_key: 'fixture-device-key',
      title: notification.title,
      body: notification.body,
      url: `nexus://agent/${notification.batchId}`,
    })
    expect(options?.redirect).toBe('error')
  })

  it('does not contact Bark when disabled or when the requested event is disabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      sendAgentNotification({ ...input(), settings: { enabled: false } }, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      sendAgentNotification(
        {
          ...input(),
          settings: { enabled: true, deviceKey: 'fixture', onCompleted: false },
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires an acknowledged delivery and does not return credential-bearing failures', async () => {
    for (const response of [
      new Response('{"code":500,"message":"fixture-device-key"}'),
      new Response('{"code":200}', { status: 502 }),
      new Response('x'.repeat(16 * 1024 + 1)),
    ]) {
      await expect(
        sendAgentNotification(input(), {
          fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
        }),
      ).rejects.toMatchObject({
        code: 'NOTIFICATION_FAILED',
        message: '批次通知发送失败，请检查 Bark 配置或网络。',
      })
    }
  })

  it('honors cancellation without sending and bounds a stalled response', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      sendAgentNotification(input(), { fetchImpl, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetchImpl).not.toHaveBeenCalled()
    vi.useFakeTimers()
    try {
      const waiting = sendAgentNotification(input(), {
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockImplementation(() => new Promise<Response>(() => {})),
      })
      const assertion = expect(waiting).rejects.toMatchObject({
        code: 'NOTIFICATION_FAILED',
      })
      await vi.advanceTimersByTimeAsync(15_001)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
