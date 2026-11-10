import { describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import { expiryApi, parseExpirySnapshot } from './expiry-api'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

const snapshot = {
  items: [
    { tel: '+14155550100', expiresAt: '2026-11-03T10:00:00.000Z', checkedAt: null },
  ],
  pendingTels: ['+14155550100'],
  failed: 0,
  storageDurable: true,
}

describe('expiry RPC boundary', () => {
  it('uses the SIM8 plugin capability with enough time for two bounded batches', async () => {
    vi.mocked(callPlugin).mockResolvedValue(snapshot)
    expect(await expiryApi.refresh(snapshot.pendingTels)).toEqual(snapshot)
    expect(callPlugin).toHaveBeenCalledWith(
      'studio.sim8',
      'verification.provider',
      'sim8.expiry.refresh',
      { tels: snapshot.pendingTels },
      60_000,
    )
  })

  it.each([
    null,
    {},
    { ...snapshot, items: [{ tel: '1', expiresAt: 'unknown', checkedAt: null }] },
    { ...snapshot, failed: -1 },
    { ...snapshot, pendingTels: Array(9).fill('1') },
    { ...snapshot, storageDurable: 'yes' },
  ])('rejects malformed plugin data instead of inventing a reminder: %j', (value) => {
    expect(() => parseExpirySnapshot(value)).toThrow('响应无效')
  })
})
