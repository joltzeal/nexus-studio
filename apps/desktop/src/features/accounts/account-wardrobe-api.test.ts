import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import { listOrderWatchItems } from './api'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

const result = {
  items: [
    {
      id: '42',
      url: 'https://www.vinted.com/items/42',
      title: 'Canvas print',
      imageUrl: null,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 10,
  lastCompleteAt: '2026-11-16T08:00:00.000Z',
  lastError: null,
}

beforeEach(() => vi.resetAllMocks())

describe('saved account wardrobe API', () => {
  it('reads one account and validates the paged snapshot', async () => {
    vi.mocked(callPlugin).mockResolvedValue(result)
    await expect(listOrderWatchItems('account-1', 1)).resolves.toEqual(result)
    expect(callPlugin).toHaveBeenCalledWith(
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.orders.items',
      { accountId: 'account-1', page: 1, pageSize: 10 },
    )
  })

  it.each([
    { ...result, items: [{ ...result.items[0], title: '' }] },
    { ...result, total: -1 },
    { ...result, page: 2 },
    { ...result, items: [{ ...result.items[0], url: 'javascript:alert(1)' }] },
    { ...result, password: 'unexpected' },
  ])('rejects malformed or unexpected data', async (response) => {
    vi.mocked(callPlugin).mockResolvedValue(response)
    await expect(listOrderWatchItems('account-1', 1)).rejects.toThrow(
      '商品快照返回的数据格式无效',
    )
  })
})
