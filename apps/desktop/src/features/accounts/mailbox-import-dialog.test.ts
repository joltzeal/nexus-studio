import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listMailboxTargets } from '@/features/email/api'
import { readMailboxes } from './mailbox-import-source'

vi.mock('@/features/email/api', async (original) => ({
  ...(await original<typeof import('@/features/email/api')>()),
  listMailboxTargets: vi.fn(),
}))

beforeEach(() => vi.resetAllMocks())

describe('email import source', () => {
  it('loads every page with stable counts instead of importing only the first 50', async () => {
    vi.mocked(listMailboxTargets).mockImplementation(async ({ page } = {}) => ({
      items: Array.from({ length: page === 1 ? 50 : 1 }, (_, index) => ({
        id: `mail-${page}-${index}`,
        email: `seller-${page}-${index}@example.test`,
        enabled: true,
        status: 'active',
      })),
      total: 51,
      page: page ?? 1,
      pageSize: 50,
      storageDurable: true,
    }))
    expect(await readMailboxes()).toHaveLength(51)
    expect(listMailboxTargets).toHaveBeenCalledTimes(2)
  })

  it('rejects a changing source before showing a duplicate preview', async () => {
    vi.mocked(listMailboxTargets).mockImplementation(async ({ page } = {}) => ({
      items: Array.from({ length: 50 }, (_, index) => ({
        id: `mail-${page}-${index}`,
        email: `seller-${page}-${index}@example.test`,
        enabled: true,
        status: 'active',
      })),
      total: page === 1 ? 51 : 52,
      page: page ?? 1,
      pageSize: 50,
      storageDurable: true,
    }))
    await expect(readMailboxes()).rejects.toThrow(/已变化/)
  })
})
