import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listBindings } from '@/features/accounts/api'
import { getProduct } from '@/features/products/api'
import { invokeBrowser } from '@/lib/platform/browser-api'
import { callPlugin, pluginHostAvailable } from '@/lib/platform/native-plugins'
import { listBrowserWindows } from '@/lib/platform/windows'
import {
  createAgentBatch,
  controlAgentBatch,
  getAgentBatch,
  getAgentEvents,
  getAgentSettings,
  listAgentBatches,
  listAgentTargets,
  readPickedProducts,
  saveAgentSettings,
  testAgentModel,
} from './api'
import {
  batch,
  ids,
  job,
  nativeWindow,
  now,
  product,
  settings,
  target,
} from './test-data'

vi.mock('@/lib/platform/native-plugins', () => ({
  callPlugin: vi.fn(),
  pluginHostAvailable: vi.fn(),
}))
vi.mock('@/lib/platform/browser-api', () => ({ invokeBrowser: vi.fn() }))
vi.mock('@/lib/platform/windows', () => ({ listBrowserWindows: vi.fn() }))
vi.mock('@/features/accounts/api', () => ({ listBindings: vi.fn() }))
vi.mock('@/features/products/api', () => ({ getProduct: vi.fn() }))

const input = {
  operationId: ids.operation,
  preset: 'post_listing' as const,
  instruction: '',
  concurrency: 3,
  assignments: [
    { windowId: ids.window, productIds: [ids.product], overrides: [], messages: [] },
  ],
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(pluginHostAvailable).mockReturnValue(true)
})

describe('sales Agent native and plugin boundaries', () => {
  it('guards every native or plugin action when no desktop host exists', async () => {
    vi.mocked(pluginHostAvailable).mockReturnValue(false)
    for (const operation of [
      () => createAgentBatch(input),
      () => listAgentBatches(),
      () => getAgentBatch(ids.batch),
      () => getAgentEvents(ids.batch),
      () => controlAgentBatch(ids.batch, 'pause'),
      () => getAgentSettings(),
      () => saveAgentSettings(settings),
      () => testAgentModel('generation'),
      () => listAgentTargets(),
      () => readPickedProducts([ids.product]),
    ])
      await expect(operation()).rejects.toThrow('桌面应用')
    expect(invokeBrowser).not.toHaveBeenCalled()
    expect(callPlugin).not.toHaveBeenCalled()
    expect(listBrowserWindows).not.toHaveBeenCalled()
  })

  it('uses short native submission and rejects duplicate assignments before IPC', async () => {
    vi.mocked(invokeBrowser).mockResolvedValue(batch)
    expect(await createAgentBatch(input)).toEqual(batch)
    expect(invokeBrowser).toHaveBeenCalledExactlyOnceWith('sales_agent_batch_create', {
      input,
    })
    await expect(
      createAgentBatch({
        ...input,
        assignments: [...input.assignments, ...input.assignments],
      }),
    ).rejects.toThrow()
    expect(invokeBrowser).toHaveBeenCalledTimes(1)
  })

  it('requires matching batch identity and input in mutation replies', async () => {
    vi.mocked(invokeBrowser).mockResolvedValue({ ...batch, preset: 'message' })
    await expect(createAgentBatch(input)).rejects.toThrow('不要重复创建')
    vi.mocked(invokeBrowser).mockResolvedValue({ ...batch, id: ids.job })
    await expect(controlAgentBatch(ids.batch, 'reconcile')).rejects.toThrow('未确认')
    expect(invokeBrowser).toHaveBeenLastCalledWith('sales_agent_batch_control', {
      id: ids.batch,
      action: 'reconcile',
    })
  })

  it('validates list pages, unique IDs and detail identity', async () => {
    vi.mocked(invokeBrowser).mockResolvedValue({
      items: [batch],
      total: 21,
      page: 2,
      pageSize: 20,
    })
    await expect(listAgentBatches(2)).resolves.toMatchObject({ page: 2 })
    expect(invokeBrowser).toHaveBeenLastCalledWith('sales_agent_batch_list', {
      page: 2,
      pageSize: 20,
    })
    vi.mocked(invokeBrowser).mockResolvedValue({
      items: [batch, batch],
      total: 2,
      page: 1,
      pageSize: 20,
    })
    await expect(listAgentBatches()).rejects.toThrow('重复')
    vi.mocked(invokeBrowser).mockResolvedValue({
      batch: { ...batch, id: ids.job },
      jobs: [job],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await expect(getAgentBatch(ids.batch)).rejects.toThrow('不一致')
    vi.mocked(invokeBrowser).mockResolvedValue({
      batch,
      jobs: [job],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await expect(getAgentBatch(ids.batch, 1, 20)).resolves.toMatchObject({ batch })
  })

  it('reloads a valid last page when native totals shrink without page clamping', async () => {
    vi.mocked(invokeBrowser)
      .mockResolvedValueOnce({ items: [], total: 1, page: 2, pageSize: 20 })
      .mockResolvedValueOnce({ items: [batch], total: 1, page: 1, pageSize: 20 })
    await expect(listAgentBatches(2)).resolves.toMatchObject({ items: [batch], page: 1 })
    expect(invokeBrowser).toHaveBeenLastCalledWith('sales_agent_batch_list', {
      page: 1,
      pageSize: 20,
    })
  })

  it('validates monotone event cursors and never accepts another batch or a stuck cursor', async () => {
    const event = {
      sequence: 5,
      batchId: ids.batch,
      jobId: ids.job,
      kind: 'submitted',
      message: 'Checking outcome',
      createdAt: now,
    }
    vi.mocked(invokeBrowser).mockResolvedValue({
      items: [event],
      cursor: 5,
      hasMore: false,
    })
    expect((await getAgentEvents(ids.batch, 4)).cursor).toBe(5)
    expect(invokeBrowser).toHaveBeenLastCalledWith('sales_agent_events', {
      id: ids.batch,
      cursor: 4,
      limit: 100,
    })
    vi.mocked(invokeBrowser).mockResolvedValue({
      items: [{ ...event, batchId: ids.job }],
      cursor: 5,
      hasMore: false,
    })
    await expect(getAgentEvents(ids.batch, 4)).rejects.toThrow('不一致')
    vi.mocked(invokeBrowser).mockResolvedValue({ items: [], cursor: 4, hasMore: true })
    await expect(getAgentEvents(ids.batch, 4)).rejects.toThrow('推进')
    vi.mocked(invokeBrowser).mockResolvedValue({
      items: [event, event],
      cursor: 5,
      hasMore: false,
    })
    await expect(getAgentEvents(ids.batch, 4)).rejects.toThrow()
    vi.mocked(invokeBrowser).mockResolvedValue({
      items: [event],
      cursor: 10,
      hasMore: false,
    })
    await expect(getAgentEvents(ids.batch, 4)).rejects.toThrow('推进')
  })

  it('reads and saves settings only through the authorized Agent plugin contract', async () => {
    vi.mocked(callPlugin).mockResolvedValue({ settings: null })
    expect(await getAgentSettings()).toBeNull()
    vi.mocked(callPlugin).mockResolvedValue({ settings })
    expect(await saveAgentSettings(settings)).toEqual(settings)
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.sales-agent',
      'sales.agent',
      'salesAgent.settings.save',
      { settings },
      120_000,
    )
    vi.mocked(callPlugin).mockResolvedValue({
      settings: { ...settings, maxCopyRewrites: 0 },
    })
    await expect(saveAgentSettings(settings)).rejects.toThrow('未确认')
    vi.mocked(callPlugin).mockResolvedValue({
      ok: true,
      kind: 'generation',
      model: 'fixture-vision',
      checks: { vision: true, english: true },
      latencyMs: 12,
    })
    await expect(testAgentModel('generation')).resolves.toEqual({
      ok: true,
      kind: 'generation',
      model: 'fixture-vision',
      checks: { vision: true, english: true },
    })
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.sales-agent',
      'sales.agent',
      'salesAgent.models.test',
      { kind: 'generation' },
      120_000,
    )
    vi.mocked(callPlugin).mockResolvedValue({ ok: false, model: 'fixture-vision' })
    await expect(testAgentModel('generation')).rejects.toThrow('不能确认')
  })

  it('rejects invalid settings without echoing the submitted key or contacting the plugin', async () => {
    const invalid = {
      ...settings,
      decision: { ...settings.decision, baseUrl: 'http://remote.example.invalid' },
    }
    await expect(saveAgentSettings(invalid)).rejects.toThrow('请检查')
    expect(callPlugin).not.toHaveBeenCalled()
  })
})

describe('real target and product readers', () => {
  beforeEach(() => {
    vi.mocked(listBrowserWindows).mockResolvedValue([nativeWindow])
    vi.mocked(listBindings).mockResolvedValue({
      items: [
        {
          windowId: ids.window,
          accountId: ids.account,
          boundAt: now,
          account: target.account,
        },
      ],
    })
  })

  it('joins native Nexus UUIDs to credential-free bindings, and visibly blocks a banned account', async () => {
    expect(await listAgentTargets()).toEqual([target])
    vi.mocked(listBindings).mockResolvedValue({
      items: [
        {
          windowId: ids.window,
          accountId: ids.account,
          boundAt: now,
          account: { ...target.account!, status: 'blocked' },
        },
      ],
    })
    expect((await listAgentTargets())[0]?.unavailable).toContain('blocked')
  })

  it('preserves missing and unknown distinctions and refuses malformed or failed bindings', async () => {
    vi.mocked(listBrowserWindows).mockResolvedValue([
      { ...nativeWindow, state: 'unknown' },
    ])
    expect((await listAgentTargets())[0]?.unavailable).toContain('状态未知')
    vi.mocked(listBindings).mockResolvedValue({
      items: [
        {
          windowId: ids.window,
          accountId: ids.account,
          boundAt: now,
          account: null,
        },
      ],
    })
    expect((await listAgentTargets())[0]?.unavailable).toContain('资料不可见')
    vi.mocked(listBindings).mockRejectedValue(new Error('Binding read failed'))
    await expect(listAgentTargets()).rejects.toThrow('Binding read failed')
  })

  it('obtains actual product details with bounded parallelism and preserves image identity', async () => {
    let active = 0
    let maximum = 0
    vi.mocked(getProduct).mockImplementation(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active -= 1
      return product
    })
    const products = await readPickedProducts(
      Array.from({ length: 9 }, (_, index) => String(index)),
    )
    expect(maximum).toBe(4)
    expect(products).toHaveLength(9)
    expect(products[0]?.images[0]?.id).toBe(ids.image)
  })
})
