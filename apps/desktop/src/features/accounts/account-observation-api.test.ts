import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import { listAccounts } from './api'
import {
  accountObservation,
  observedAccount,
  observationTime,
} from './account-observation-test-support'

vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  callPlugin: vi.fn(),
}))

function page(items: unknown[]) {
  return {
    items,
    total: items.length,
    bindings: [
      {
        accountId: 'ad203e79-9430-4867-b858-b15f7bba4ea5',
        windowId: 'cbeb842a-88cb-4274-a7cb-503ae8a2d586',
        boundAt: observationTime,
      },
    ],
    page: 1,
    pageSize: 16,
    revision: 'a'.repeat(64),
    storageDurable: true,
  }
}

beforeEach(() => vi.resetAllMocks())

describe('account observation list validation', () => {
  it('preserves observations, exact money text, credentials and existing relationships', async () => {
    const item = observedAccount()
    vi.mocked(callPlugin).mockResolvedValueOnce(page([item]))

    const result = await listAccounts()

    expect(result.items[0]).toEqual(item)
    expect(result.items[0]?.password).toBe(' synthetic password ')
    expect(result.items[0]?.observation?.balance?.available).toBe('123456789012.3400')
    expect(result.items[0]?.observation?.balance?.availableEvidence).toEqual({
      source: 'official',
      observedAt: '2026-11-12T05:00:00.000Z',
    })
    expect(result.bindings).toHaveLength(1)
  })

  it('keeps existing records without observations valid without inventing observation state', async () => {
    const item = observedAccount()
    delete item.observation
    vi.mocked(callPlugin).mockResolvedValueOnce(page([item]))

    const result = await listAccounts()

    expect(result.items[0]).toEqual(item)
    expect(result.items[0]).not.toHaveProperty('observation')
  })

  it.each([
    { name: 'null state', observation: null },
    { name: 'missing last observation', observation: { tags: ['已验证'] } },
    { name: 'unknown state field', observation: { ...accountObservation(), note: 'x' } },
    {
      name: 'unknown balance field',
      observation: {
        ...accountObservation(),
        balance: { ...accountObservation().balance, total: '1.00' },
      },
    },
    {
      name: 'unknown evidence field',
      observation: {
        ...accountObservation(),
        balance: {
          ...accountObservation().balance,
          availableEvidence: {
            source: 'official',
            observedAt: observationTime,
            confirmed: true,
          },
        },
      },
    },
    {
      name: 'unknown last observation field',
      observation: {
        ...accountObservation(),
        lastObservation: { ...accountObservation().lastObservation, tags: ['x'] },
      },
    },
    {
      name: 'model strong status evidence',
      observation: {
        ...accountObservation(),
        statusEvidence: {
          status: 'blocked',
          source: 'model',
          observedAt: observationTime,
        },
      },
    },
    {
      name: 'numeric money',
      observation: {
        ...accountObservation(),
        balance: { ...accountObservation().balance, available: 0 },
      },
    },
    {
      name: 'exponent money',
      observation: {
        ...accountObservation(),
        balance: { ...accountObservation().balance, pending: '1e3' },
      },
    },
    { name: 'rating outside range', observation: { ...accountObservation(), rating: 6 } },
    {
      name: 'invalid timestamp',
      observation: {
        ...accountObservation(),
        lastObservation: { ...accountObservation().lastObservation, observedAt: 'now' },
      },
    },
    {
      name: 'too many tags',
      observation: { ...accountObservation(), tags: Array<string>(9).fill('标签') },
    },
    {
      name: 'control characters',
      observation: { ...accountObservation(), summary: 'summary\n' },
    },
  ])(
    'rejects $name instead of accepting or dropping malformed state',
    async ({ observation }) => {
      vi.mocked(callPlugin).mockResolvedValueOnce(
        page([{ ...observedAccount(), observation }]),
      )

      await expect(listAccounts()).rejects.toThrow(/数据格式无效/)
    },
  )

  it('rejects the entire read when a later page contains invalid observation state', async () => {
    const firstItems = Array.from({ length: 16 }, (_, index) => ({
      ...observedAccount(),
      id: `account-${index}`,
    }))
    vi.mocked(callPlugin)
      .mockResolvedValueOnce({ ...page(firstItems), total: 17, bindings: [] })
      .mockResolvedValueOnce({
        ...page([{ ...observedAccount(), observation: { summary: 'incomplete' } }]),
        total: 17,
        page: 2,
      })

    await expect(listAccounts()).rejects.toThrow(/数据格式无效/)
  })
})
