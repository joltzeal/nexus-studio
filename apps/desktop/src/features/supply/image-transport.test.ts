import { afterEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import * as api from './api'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

const id = '3f682408-3dc9-4e4a-8fc3-bcb0018d5723'
const url = 'https://product.aliyizhan.com/person/image.jpg'
afterEach(() => vi.mocked(callPlugin).mockReset())

describe('image RPC reassembly', () => {
  it.each(['插件未声明该方法', 'INVALID_REQUEST: 插件不支持该方法'])(
    'explains that the installed plugin must be updated: %s',
    async (failure) => {
      vi.mocked(callPlugin).mockRejectedValue(failure)
      await expect(
        api.loadSupplyImage(url, new AbortController().signal),
      ).rejects.toThrow('请更新共享货源插件后重试图片加载')
    },
  )

  it('reassembles bytes as a typed blob without making a WebView network request', async () => {
    const browserFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('CDN blocked by WebView'))
    const closed: unknown[] = []
    vi.mocked(callPlugin).mockImplementation(
      async (_plugin, _capability, method, payload) => {
        if (method === 'supply.image.open')
          return { id, size: 6, chunkSize: 4, mime: 'image/jpeg' }
        if (method === 'supply.image.read') {
          const { offset } = payload as { offset: number }
          return offset === 0
            ? { offset: 0, data: '/9j/AA==' }
            : { offset: 4, data: '/9k=' }
        }
        if (method === 'supply.image.close') {
          closed.push(payload)
          return { closed: true }
        }
        throw new Error('unexpected RPC method')
      },
    )
    const blob = await api.loadSupplyImage(url, new AbortController().signal)
    expect(blob.type).toBe('image/jpeg')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([255, 216, 255, 0, 255, 217]),
    )
    expect(browserFetch).not.toHaveBeenCalled()
    expect(closed).toEqual([{ id }])
  })

  it.each([
    { offset: 1, data: '/9j/AA==' },
    { offset: 0, data: '' },
    { offset: 0, data: '!!!!' },
    { offset: 0, data: '/9j/' },
  ])(
    'rejects malformed or missing chunk bytes and still releases the transfer: %j',
    async (chunk) => {
      const closed: unknown[] = []
      vi.mocked(callPlugin).mockImplementation(
        async (_plugin, _capability, method, payload) => {
          if (method === 'supply.image.open')
            return { id, size: 6, chunkSize: 4, mime: 'image/jpeg' }
          if (method === 'supply.image.read') return chunk
          closed.push(payload)
          return { closed: true }
        },
      )
      await expect(
        api.loadSupplyImage(url, new AbortController().signal),
      ).rejects.toThrow('图片传输')
      expect(closed).toEqual([{ id }])
    },
  )

  it('releases a late open result after the image leaves the viewport', async () => {
    const controller = new AbortController()
    const methods: string[] = []
    vi.mocked(callPlugin).mockImplementation(async (_plugin, _capability, method) => {
      methods.push(method)
      if (method === 'supply.image.open') {
        controller.abort()
        return { id, size: 6, chunkSize: 4, mime: 'image/jpeg' }
      }
      return { closed: true }
    })
    await expect(api.loadSupplyImage(url, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(methods).toEqual(['supply.image.open', 'supply.image.close'])
  })

  it('distinguishes a rejected URL from an old plugin without exposing the URL', async () => {
    vi.mocked(callPlugin).mockRejectedValue('INVALID_REQUEST: 不支持的货源图片地址')
    await expect(api.loadSupplyImage(url, new AbortController().signal)).rejects.toThrow(
      '图片地址或跳转不在支持的来源范围内',
    )
  })

  it.each([
    { id, size: 9 * 1024 * 1024, chunkSize: 262144, mime: 'image/jpeg' },
    { id, size: 6, chunkSize: 0, mime: 'image/jpeg' },
    { id, size: 6, chunkSize: 262145, mime: 'image/jpeg' },
    { id, size: 6, chunkSize: 4, mime: 'image/svg+xml' },
  ])('rejects invalid metadata before reading image data: %j', async (meta) => {
    const methods: string[] = []
    vi.mocked(callPlugin).mockImplementation(async (_plugin, _capability, method) => {
      methods.push(method)
      return method === 'supply.image.open' ? meta : { closed: true }
    })
    await expect(api.loadSupplyImage(url, new AbortController().signal)).rejects.toThrow(
      '图片传输',
    )
    expect(methods).toEqual(['supply.image.open', 'supply.image.close'])
  })
})
