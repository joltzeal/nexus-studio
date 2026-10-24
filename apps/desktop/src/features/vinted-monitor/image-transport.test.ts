import { afterEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import { loadVintedImage } from './api'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))
const call = vi.mocked(callPlugin)
const transferId = '11111111-1111-4111-8111-111111111111'
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function install(data = 'AQID') {
  call.mockImplementation(async (_plugin, _capability, method) => {
    if (method === 'vinted.image.open')
      return { id: transferId, size: 3, chunkSize: 262144, mime: 'image/jpeg' }
    if (method === 'vinted.image.read') return { offset: 0, data }
    if (method === 'vinted.image.close') return { closed: true }
    throw new Error(`Unexpected method ${method}`)
  })
}

describe('Vinted image transport', () => {
  it('passes item identity to the plugin and transfers bytes without WebView network calls', async () => {
    install()
    const fetch = vi.fn().mockRejectedValue(new Error('WebView must not fetch'))
    vi.stubGlobal('fetch', fetch)
    const blob = await loadVintedImage(
      'vinted.fr:123',
      'https://images1.vinted.net/test.jpg',
      new AbortController().signal,
    )
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3])
    expect(blob.type).toBe('image/jpeg')
    expect(call).toHaveBeenCalledWith(
      'studio.vinted-monitor',
      'monitor.collector',
      'vinted.image.open',
      { itemId: 'vinted.fr:123', url: 'https://images1.vinted.net/test.jpg' },
      40000,
    )
    expect(call).toHaveBeenLastCalledWith(
      'studio.vinted-monitor',
      'monitor.collector',
      'vinted.image.close',
      { id: transferId },
      undefined,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects truncated or corrupt chunks and releases the server snapshot', async () => {
    install('AQI=')
    await expect(
      loadVintedImage('item', 'url', new AbortController().signal),
    ).rejects.toThrow('传输数据无效')
    expect(call.mock.calls[call.mock.calls.length - 1]?.[2]).toBe('vinted.image.close')
  })

  it('aborting after open releases the allocated transfer and does not read any chunk', async () => {
    const controller = new AbortController()
    call.mockImplementation(async (_plugin, _capability, method) => {
      if (method === 'vinted.image.open') {
        controller.abort()
        return { id: transferId, size: 3, chunkSize: 262144, mime: 'image/jpeg' }
      }
      return { closed: true }
    })
    await expect(loadVintedImage('item', 'url', controller.signal)).rejects.toMatchObject(
      { name: 'AbortError' },
    )
    expect(call.mock.calls.map((args) => args[2])).toEqual([
      'vinted.image.open',
      'vinted.image.close',
    ])
  })

  it('rejects oversized allocations before requesting bytes', async () => {
    call.mockResolvedValueOnce({
      id: transferId,
      size: 8388609,
      chunkSize: 262144,
      mime: 'image/jpeg',
    })
    call.mockResolvedValueOnce({ closed: true })
    await expect(
      loadVintedImage('item', 'url', new AbortController().signal),
    ).rejects.toThrow('传输数据无效')
    expect(call.mock.calls.map((args) => args[2])).toEqual([
      'vinted.image.open',
      'vinted.image.close',
    ])
  })

  it('requests an update for old plugins and never falls back to a direct download', async () => {
    call.mockRejectedValue(new Error('插件未声明该方法'))
    await expect(
      loadVintedImage('item', 'url', new AbortController().signal),
    ).rejects.toThrow('请先更新 Vinted 监控插件')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
