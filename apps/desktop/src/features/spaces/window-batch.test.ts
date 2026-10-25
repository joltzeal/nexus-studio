import { describe, expect, it, vi } from 'vitest'
import type { NativeProfile, WindowSettings } from '@/lib/platform/native-profiles'
import {
  MAX_BATCH_WINDOWS,
  mergeBatchProfiles,
  planWindowBatch,
  WindowBatchJob,
  type WindowBatchConfig,
  type WindowBatchPorts,
} from './window-batch'

const settings: WindowSettings = {
  platform: 'Vinted',
  note: 'shared note',
  geoip: true,
  timezone: '',
  locale: 'en-US',
  viewport: '1440x900',
  fingerprintSeed: null,
  startUrl: 'https://www.vinted.com',
}

function config(overrides: Partial<WindowBatchConfig> = {}): WindowBatchConfig {
  return {
    count: 3,
    namePrefix: 'shop',
    proxy: { proxy: null, proxyPlugin: 'studio.proxy-pool', proxyEndpoint: 42 },
    settings: { ...settings },
    groupId: 'group-one',
    ...overrides,
  }
}

function profile(
  name: string,
  values: WindowSettings,
  overrides: Partial<NativeProfile> = {},
): NativeProfile {
  return {
    id: `profile-${name}`,
    name,
    version: '155.0.8059.39',
    proxy: null,
    proxyPlugin: 'studio.proxy-pool',
    proxyEndpoint: 42,
    settings: values,
    groupId: 'group-one',
    running: false,
    createdAt: 10,
    lastOpenedAt: null,
    ...overrides,
  }
}

function fixture(overrides: Partial<WindowBatchPorts> = {}) {
  const saved: NativeProfile[] = []
  const createProfile = vi.fn<WindowBatchPorts['createProfile']>(
    async (name, proxy, proxyPlugin, proxyEndpoint, values, groupId) => {
      const result = profile(name, values, { proxy, proxyPlugin, proxyEndpoint, groupId })
      saved.push(result)
      return result
    },
  )
  const bindAccount = vi.fn<WindowBatchPorts['bindAccount']>().mockResolvedValue({
    bound: true,
    duplicates: [],
  })
  const listProfiles = vi.fn(async () => saved)
  const ports: WindowBatchPorts = {
    createProfile,
    bindAccount,
    listProfiles,
    ...overrides,
  }
  return { saved, ports, createProfile, bindAccount, listProfiles }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const accounts = [
  { id: 'account-a', label: 'seller-a@example.com' },
  { id: 'account-b', label: 'seller-b@example.com' },
  { id: 'account-c', label: 'seller-c@example.com' },
]

describe('batch window planning', () => {
  it('keeps a newly retried row above earlier successes created in the same second', () => {
    const [first, second, third] = [1, 2, 3].map((i) => profile(`shop-${i}`, settings))
    const rows = planWindowBatch(config(), []).map((item, index) => ({
      ...item,
      profile: [first!, second!, third!][index]!,
    }))
    const merged = mergeBatchProfiles([third!, second!], rows)
    expect(merged.map((item) => item.id)).toEqual([first!.id, third!.id, second!.id])
    expect(mergeBatchProfiles(merged, rows)).toEqual(merged)
  })
  it('assigns unique seeds and names even when random values collide with existing windows', () => {
    const existing = [profile('SHOP-01', { ...settings, fingerprintSeed: 7 })]
    const items = planWindowBatch(config(), existing, () => 7)
    expect(items.map((item) => item.seed)).toEqual([8, 9, 10])
    expect(items.map((item) => item.name)).toEqual(['shop-01-2', 'shop-02', 'shop-03'])
    expect(
      items.every((item) => item.profile === null && item.status === 'pending'),
    ).toBe(true)
  })

  it('uses account names, truncates by Unicode characters and preserves one-to-one mapping', () => {
    const longLabel = '画'.repeat(45)
    const items = planWindowBatch(
      config({
        namePrefix: '',
        accounts: [
          { ...accounts[0]!, label: longLabel },
          { ...accounts[1]!, label: longLabel },
          accounts[2]!,
        ],
      }),
      [],
      () => 2_147_483_647,
    )
    expect(items.map((item) => item.account?.id)).toEqual(
      accounts.map((account) => account.id),
    )
    expect(items.map((item) => item.seed)).toEqual([2_147_483_647, 1, 2])
    expect(Array.from(items[0]!.name)).toHaveLength(40)
    expect(Array.from(items[1]!.name)).toHaveLength(40)
    expect(items[1]!.name).toMatch(/-2$/)
    expect(items[2]!.name).toBe(accounts[2]!.label)
  })

  it.each([0, -1, 1.5, Number.NaN, MAX_BATCH_WINDOWS + 1])(
    'rejects invalid counts (%s)',
    (count) => {
      expect(() => planWindowBatch(config({ count }), [])).toThrow('每批可创建')
    },
  )

  it('rejects account mismatches, duplicated account IDs and invalid seed sources before writing', () => {
    expect(() => planWindowBatch(config({ accounts: [accounts[0]!] }), [])).toThrow(
      '数量不一致',
    )
    expect(() =>
      planWindowBatch(config({ accounts: Array(3).fill(accounts[0]) }), []),
    ).toThrow('重复账号')
    expect(() => planWindowBatch(config(), [], () => 0)).toThrow('随机种子')
    expect(() => planWindowBatch(config({ namePrefix: 'x'.repeat(37) }), [])).toThrow(
      '36',
    )
  })
})

describe('batch native creation', () => {
  it('serializes creation, prevents overlapping runs and passes the shared settings unchanged', async () => {
    const first = deferred<NativeProfile>()
    const deps = fixture()
    deps.createProfile.mockImplementationOnce(() => first.promise)
    const input = config()
    const job = new WindowBatchJob(input, [], deps.ports, () => 100)
    input.proxy.proxyEndpoint = 88
    input.settings.locale = 'de-DE'
    const change = vi.fn()
    const running = job.run(change)
    expect(job.run(change)).toBe(running)
    await Promise.resolve()
    expect(deps.createProfile).toHaveBeenCalledTimes(1)
    first.resolve(profile('shop-01', { ...settings, fingerprintSeed: 100 }))
    await running
    expect(deps.createProfile).toHaveBeenCalledTimes(3)
    expect(job.items.every((item) => item.status === 'complete')).toBe(true)
    expect(deps.createProfile.mock.calls.map((call) => call[4].fingerprintSeed)).toEqual([
      100, 101, 102,
    ])
    for (const call of deps.createProfile.mock.calls) {
      expect(call.slice(1, 4)).toEqual([null, 'studio.proxy-pool', 42])
      expect(call[4]).toEqual({ ...settings, fingerprintSeed: expect.any(Number) })
      expect(call[5]).toBe('group-one')
    }
    await job.run(change)
    expect(deps.createProfile).toHaveBeenCalledTimes(3)
  })

  it('retains successes and retries only the failed creation with the original seed', async () => {
    const deps = fixture()
    deps.createProfile.mockRejectedValueOnce(new Error('磁盘写入失败'))
    const job = new WindowBatchJob(config({ accounts }), [], deps.ports, () => 20)
    await job.run(() => {})
    expect(job.items.map((item) => item.status)).toEqual([
      'failed',
      'complete',
      'complete',
    ])
    expect(deps.bindAccount.mock.calls.map((call) => call[0])).toEqual([
      'account-b',
      'account-c',
    ])
    const originalSeed = job.items[0]!.seed
    await job.run(() => {})
    expect(deps.createProfile).toHaveBeenCalledTimes(4)
    expect(deps.createProfile.mock.calls[3]![4].fingerprintSeed).toBe(originalSeed)
    expect(deps.bindAccount).toHaveBeenLastCalledWith(
      'account-a',
      'profile-shop-01',
      false,
    )
    expect(job.items.every((item) => item.status === 'complete')).toBe(true)
  })

  it('retries only account binding after the profile was created', async () => {
    const deps = fixture()
    deps.bindAccount.mockRejectedValueOnce(new Error('插件进程不可用'))
    const job = new WindowBatchJob(config({ accounts }), [], deps.ports)
    await job.run(() => {})
    expect(job.items[0]).toMatchObject({
      profile: { id: 'profile-shop-01' },
      status: 'failed',
      error: '窗口已创建，账号关联失败：插件进程不可用',
    })
    await job.run(() => {})
    expect(deps.createProfile).toHaveBeenCalledTimes(3)
    expect(deps.bindAccount).toHaveBeenCalledTimes(4)
    expect(deps.bindAccount).toHaveBeenLastCalledWith(
      'account-a',
      'profile-shop-01',
      false,
    )
  })

  it('recovers a committed window when its create response fails', async () => {
    const deps = fixture()
    deps.createProfile.mockImplementationOnce(
      async (name, _proxy, _plugin, _endpoint, values) => {
        deps.saved.push(profile(name, values))
        throw new Error('创建响应中断')
      },
    )
    const job = new WindowBatchJob(config({ count: 1 }), [], deps.ports)
    await job.run(() => {})
    expect(job.items[0]).toMatchObject({
      status: 'complete',
      profile: { id: 'profile-shop-01' },
    })
    await job.run(() => {})
    expect(deps.createProfile).toHaveBeenCalledTimes(1)
  })

  it('blocks another creation while the original result cannot be reconciled', async () => {
    const deps = fixture()
    deps.createProfile.mockRejectedValue(new Error('创建响应中断'))
    deps.listProfiles.mockRejectedValue(new Error('列表不可用'))
    const job = new WindowBatchJob(config({ count: 1 }), [], deps.ports, () => 55)
    await job.run(() => {})
    expect(job.items[0]!.error).toContain('创建结果尚未确认')
    await job.run(() => {})
    expect(deps.createProfile).toHaveBeenCalledTimes(1)
    deps.listProfiles.mockResolvedValue([
      profile('shop-01', { ...settings, fingerprintSeed: 55 }),
    ])
    await job.run(() => {})
    expect(deps.createProfile).toHaveBeenCalledTimes(1)
    expect(job.items[0]!.status).toBe('complete')
  })

  it('requires explicit duplicate-account confirmation and reuses the created window', async () => {
    const deps = fixture()
    deps.bindAccount.mockImplementation(async (_accountId, _windowId, confirmed) => ({
      bound: confirmed,
      duplicates: ['other-window'],
    }))
    const job = new WindowBatchJob(
      config({ count: 1, accounts: [accounts[0]!] }),
      [],
      deps.ports,
    )
    await job.run(() => {})
    expect(job.items[0]).toMatchObject({
      status: 'failed',
      duplicateWindowIds: ['other-window'],
    })
    await job.run(() => {}, new Set(['unrelated-account']))
    expect(job.items[0]!.status).toBe('failed')
    await job.run(() => {}, new Set(['account-a']))
    expect(job.items[0]!.status).toBe('complete')
    expect(deps.createProfile).toHaveBeenCalledTimes(1)
    expect(deps.bindAccount).toHaveBeenLastCalledWith(
      'account-a',
      'profile-shop-01',
      true,
    )
  })

  it('stops after the current create and binding, and resumes pending rows without duplicates', async () => {
    const first = deferred<NativeProfile>()
    const deps = fixture()
    deps.createProfile.mockImplementationOnce(() => first.promise)
    const job = new WindowBatchJob(config({ accounts }), [], deps.ports)
    const seeds = job.items.map((item) => item.seed)
    const running = job.run(() => {})
    await Promise.resolve()
    job.stopAfterCurrent()
    first.resolve(profile('shop-01', { ...settings, fingerprintSeed: seeds[0]! }))
    await running
    expect(job.items.map((item) => item.status)).toEqual([
      'complete',
      'pending',
      'pending',
    ])
    expect(deps.createProfile).toHaveBeenCalledTimes(1)
    expect(deps.bindAccount).toHaveBeenCalledTimes(1)
    await job.run(() => {})
    expect(deps.createProfile).toHaveBeenCalledTimes(3)
    expect(job.items.map((item) => item.seed)).toEqual(seeds)
    expect(job.items.every((item) => item.status === 'complete')).toBe(true)
  })

  it('keeps manual proxy settings on all attempts instead of falling back to direct', async () => {
    const deps = fixture()
    deps.createProfile.mockRejectedValueOnce(new Error('proxy configuration failure'))
    const job = new WindowBatchJob(
      config({
        count: 2,
        proxy: {
          proxy: 'socks5://127.0.0.1:7890',
          proxyPlugin: null,
          proxyEndpoint: null,
        },
      }),
      [],
      deps.ports,
    )
    await job.run(() => {})
    await job.run(() => {})
    expect(deps.createProfile.mock.calls.map((call) => call.slice(1, 4))).toEqual(
      Array(3).fill(['socks5://127.0.0.1:7890', null, null]),
    )
  })
})
