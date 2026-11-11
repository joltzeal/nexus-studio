import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import type { Profile } from '@/features/addresses/types'
import { assignAccountAddress, listAccountAddressTargets } from './api'

vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  callPlugin: vi.fn(),
}))

const profile: Profile = {
  id: 'profile-paris',
  street: 'Rue Exemple',
  houseNumber: '12',
  city: 'Paris',
  postalCode: '75001',
  countryCode: 'FR',
  state: null,
  county: null,
  latitude: 48.8566,
  longitude: 2.3522,
  source: 'osm',
  sourceUrl: 'https://www.openstreetmap.org/node/123',
  approximate: false,
  firstName: 'Marie',
  lastName: 'Exemple',
  username: 'marie.exemple',
}
const updatedAt = '2026-11-11T10:00:00.000Z'
const address = { ...profile, linkedAt: updatedAt }
const target = {
  id: 'account-1',
  account: 'synthetic@example.test',
  status: 'active',
  address,
}
const page = {
  items: [target],
  total: 1,
  page: 1,
  pageSize: 20,
  storageDurable: true,
}

beforeEach(() => vi.resetAllMocks())

describe('account address RPC adapter', () => {
  it('uses the credential-free target RPC with the supplied query and page', async () => {
    vi.mocked(callPlugin).mockResolvedValueOnce(page)
    expect(
      await listAccountAddressTargets({ query: 'seller', page: 2, pageSize: 50 }),
    ).toEqual(page)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.address.targets',
      { query: 'seller', page: 2, pageSize: 50 },
    )
  })

  it('sends an empty strict input for the default page and accepts null addresses', async () => {
    const result = { ...page, items: [{ ...target, address: null }] }
    vi.mocked(callPlugin).mockResolvedValueOnce(result)
    expect(await listAccountAddressTargets()).toEqual(result)
    expect(callPlugin).toHaveBeenCalledWith(
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.address.targets',
      {},
    )
  })

  it.each([undefined, null, 'previous-profile'])(
    'assigns the complete profile and preserves the expected ID %j',
    async (expectedProfileId) => {
      const result = { address, updatedAt, storageDurable: true }
      vi.mocked(callPlugin).mockResolvedValueOnce(result)
      // A saved profile may carry metadata, but the RPC accepts only Profile.
      const saved = { ...profile, savedAt: updatedAt }
      expect(await assignAccountAddress('account-1', saved, expectedProfileId)).toEqual(
        result,
      )
      expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
        'studio.vinted-accounts',
        'account.pool',
        'vinted.accounts.address.set',
        {
          accountId: 'account-1',
          profile,
          ...(expectedProfileId === undefined ? {} : { expectedProfileId }),
        },
      )
    },
  )

  it('unlinks using the current profile ID and reports memory-only storage', async () => {
    const result = { address: null, updatedAt, storageDurable: false }
    vi.mocked(callPlugin).mockResolvedValueOnce(result)
    expect(await assignAccountAddress('account-1', null, profile.id)).toEqual(result)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.address.set',
      { accountId: 'account-1', profile: null, expectedProfileId: profile.id },
    )
  })

  it.each([
    null,
    { ...page, items: [{ ...target, password: 'synthetic-secret' }] },
    { ...page, items: [{ ...target, emailOtpUrl: 'https://example.test/mail' }] },
    { ...page, items: [{ ...target, status: 'ready' }] },
    { ...page, items: [{ ...target, address: undefined }] },
    { ...page, items: [{ ...target, address: { ...address, latitude: 91 } }] },
    { ...page, items: [{ ...target, address: { ...address, linkedAt: 'invalid' } }] },
    { ...page, total: -1 },
    { ...page, page: 0 },
    { ...page, pageSize: 51 },
    { ...page, storageDurable: 'true' },
  ])('rejects a malformed or credential-bearing target response: %j', async (value) => {
    vi.mocked(callPlugin).mockResolvedValueOnce(value)
    await expect(listAccountAddressTargets()).rejects.toThrow('数据格式无效')
  })

  it.each([
    null,
    { address: null, updatedAt: 'invalid', storageDurable: true },
    { address: null, updatedAt },
    { address, updatedAt, storageDurable: true },
    { address: null, updatedAt, storageDurable: true, password: 'synthetic-secret' },
  ])('rejects malformed or inconsistent unlink receipts: %j', async (value) => {
    vi.mocked(callPlugin).mockResolvedValueOnce(value)
    await expect(assignAccountAddress('account-1', null, profile.id)).rejects.toThrow(
      '数据格式无效',
    )
  })

  it('propagates write failures without producing a save receipt', async () => {
    vi.mocked(callPlugin).mockRejectedValueOnce(new Error('storage write failed'))
    await expect(assignAccountAddress('account-1', profile, null)).rejects.toThrow(
      'storage write failed',
    )
  })
})
