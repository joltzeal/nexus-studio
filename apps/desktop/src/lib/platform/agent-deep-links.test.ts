import { describe, expect, it, vi } from 'vitest'
import { connectAgentDeepLinks } from './agent-deep-links'

const id = '11111111-1111-4111-8111-111111111111'

describe('Agent deep-link connection', () => {
  it('subscribes before reading startup links and only forwards validated navigation', async () => {
    const order: string[] = []
    let receive: (urls: string[]) => void = () => {}
    const opened = vi.fn()
    const unlisten = vi.fn()
    const stop = await connectAgentDeepLinks({
      onOpenUrl: async (listener) => {
        order.push('listen')
        receive = listener
        return unlisten
      },
      getCurrent: async () => {
        order.push('current')
        return [`nexus://agent/${id}`]
      },
      navigate: opened,
    })
    expect(order).toEqual(['listen', 'current'])
    expect(opened).toHaveBeenCalledWith({ kind: 'agent', id, batchId: id })
    receive(['nexus://agent/bad', `nexus://agent/${id}?action=send`])
    expect(opened).toHaveBeenCalledTimes(1)
    stop()
    receive([`nexus://agent/${id}`])
    expect(unlisten).toHaveBeenCalledOnce()
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('cleans up the listener when reading current links fails', async () => {
    const unlisten = vi.fn()
    await expect(
      connectAgentDeepLinks({
        onOpenUrl: async () => unlisten,
        getCurrent: async () => {
          throw new Error('unavailable')
        },
        navigate: vi.fn(),
      }),
    ).rejects.toThrow('unavailable')
    expect(unlisten).toHaveBeenCalledOnce()
  })
})
