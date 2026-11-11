import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import { listSavedAddresses, removeSavedAddress, saveAddress } from './api'
import type { SavedProfile } from './types'

vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  callPlugin: vi.fn(),
}))

const saved: SavedProfile = {
  id: 'saved-1',
  street: 'Example Avenue',
  houseNumber: '12',
  city: 'Seattle',
  postalCode: '98101',
  countryCode: 'US',
  state: 'WA',
  county: null,
  latitude: 47.6062,
  longitude: -122.3321,
  source: 'map',
  sourceUrl: '',
  approximate: false,
  firstName: 'Alex',
  lastName: 'Example',
  username: 'alex.example',
  savedAt: '2026-11-11T10:00:00.000Z',
}
const page = {
  items: [saved],
  total: 1,
  page: 1,
  pageSize: 20,
  storageDurable: true,
}

beforeEach(() => vi.resetAllMocks())

describe('saved address RPC adapter', () => {
  it('sends search and pagination to the saved collection', async () => {
    vi.mocked(callPlugin).mockResolvedValueOnce(page)
    expect(await listSavedAddresses({ query: 'Seattle', page: 1 })).toEqual(page)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.address-generator',
      'address.generator',
      'address.saved.list',
      { query: 'Seattle', page: 1 },
      undefined,
    )
  })

  it('strips storage metadata when saving and accepts an existing saved identity', async () => {
    const receipt = { item: saved, created: false, storageDurable: true }
    vi.mocked(callPlugin).mockResolvedValueOnce(receipt)
    expect(await saveAddress(saved)).toEqual(receipt)
    const { savedAt, ...profile } = saved
    expect(receipt.item.savedAt).toBe(savedAt)
    expect(callPlugin).toHaveBeenCalledWith(
      'studio.address-generator',
      'address.generator',
      'address.saved.save',
      { profile },
      undefined,
    )
  })

  it.each([
    null,
    { ...page, items: [{ ...saved, latitude: 91 }] },
    { ...page, items: [{ ...saved, savedAt: 'invalid' }] },
    { ...page, items: [{ ...saved, firstName: '' }] },
    { ...page, total: 0 },
    { ...page, page: 0 },
    { ...page, pageSize: 51 },
    { ...page, storageDurable: undefined },
  ])('rejects an invalid saved collection: %j', async (value) => {
    vi.mocked(callPlugin).mockResolvedValueOnce(value)
    await expect(listSavedAddresses()).rejects.toThrow('数据格式无效')
  })

  it('does not treat an invalid write receipt as a successful save', async () => {
    vi.mocked(callPlugin).mockResolvedValueOnce({ item: saved, created: true })
    await expect(saveAddress(saved)).rejects.toThrow('数据格式无效')
  })

  it('validates removal receipts and propagates write failures', async () => {
    vi.mocked(callPlugin).mockResolvedValueOnce({})
    await expect(removeSavedAddress(saved.id)).rejects.toThrow('数据格式无效')
    vi.mocked(callPlugin).mockRejectedValueOnce(new Error('fixture write failure'))
    await expect(saveAddress(saved)).rejects.toThrow('fixture write failure')
  })
})
