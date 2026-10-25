import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListResult, ProxyRow } from './types'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

const { callPlugin } = await import('@/lib/platform/native-plugins')
const { listPickerProxies } = await import('./api')

function page(offset: number, total: number, items: ProxyRow[]): ListResult {
  return { offset, total, items, limit: 500 }
}

describe('proxy picker inventory loading', () => {
  beforeEach(() => vi.mocked(callPlugin).mockReset())

  it('fetches later pages so usernames and a default beyond the first page are available', async () => {
    const first = Array.from({ length: 500 }, (_, index) => ({
      id: String(index + 1),
      username: `sample-session-${index + 1}`,
    })) as ProxyRow[]
    const last = { id: '501', username: 'sample-session-default' } as ProxyRow
    vi.mocked(callPlugin)
      .mockResolvedValueOnce(page(0, 501, first))
      .mockResolvedValueOnce(page(500, 501, [last]))
    const result = await listPickerProxies()
    expect(result).toHaveLength(501)
    expect(result[result.length - 1]).toBe(last)
    expect(callPlugin).toHaveBeenNthCalledWith(
      2,
      'studio.proxy-pool',
      'proxy.provider',
      'proxy.list',
      expect.objectContaining({ offset: 500, limit: 500, keyword: '' }),
      undefined,
    )
  })

  it('treats a successfully read empty inventory as empty', async () => {
    vi.mocked(callPlugin).mockResolvedValue(page(0, 0, []))
    await expect(listPickerProxies()).resolves.toEqual([])
    expect(callPlugin).toHaveBeenCalledTimes(1)
  })

  it('propagates an inventory failure instead of returning an empty or partial list', async () => {
    vi.mocked(callPlugin)
      .mockResolvedValueOnce(page(0, 2, [{ id: '1' } as ProxyRow]))
      .mockRejectedValueOnce(new Error('Plugin unavailable'))
    await expect(listPickerProxies()).rejects.toThrow('Plugin unavailable')
  })

  it('rejects an incomplete page instead of looping or reporting success', async () => {
    vi.mocked(callPlugin).mockResolvedValue(page(0, 1, []))
    await expect(listPickerProxies()).rejects.toThrow('代理池列表未完整读取')
    expect(callPlugin).toHaveBeenCalledTimes(1)
  })

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid total of %s without requesting another page',
    async (total) => {
      vi.mocked(callPlugin).mockResolvedValue(page(0, total, []))
      await expect(listPickerProxies()).rejects.toThrow('代理池列表未完整读取')
      expect(callPlugin).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    null,
    { offset: 0, total: 0, items: null },
    page(1, 1, [{ id: '1' } as ProxyRow]),
    page(0, 0, [{ id: '1' } as ProxyRow]),
  ])('rejects malformed page metadata: %j', async (result) => {
    vi.mocked(callPlugin).mockResolvedValue(result)
    await expect(listPickerProxies()).rejects.toThrow('代理池列表未完整读取')
    expect(callPlugin).toHaveBeenCalledTimes(1)
  })
})
