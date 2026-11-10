import { expect, it, vi } from 'vitest'
import { browserConnection, browserWindow } from '@/lib/platform/browser-test-support'
import {
  MAX_BATCH_WINDOWS,
  mergeBatchWindows,
  planWindowBatch,
  WindowBatchJob,
  type WindowBatchConfig,
  type WindowBatchPorts,
} from './window-batch'

function config(overrides: Partial<WindowBatchConfig> = {}): WindowBatchConfig {
  return {
    connection: browserConnection(),
    count: 3,
    namePrefix: 'shop',
    proxy: {
      proxyMode: 'plugin',
      proxy: null,
      proxyPlugin: 'studio.proxy-pool',
      proxyEndpoint: 42,
    },
    settings: browserWindow().settings,
    groupId: 'g1',
    kernelVersion: null,
    ...overrides,
  }
}
function fixture() {
  let seq = 0
  const ports = {
    createWindow: vi.fn<WindowBatchPorts['createWindow']>(async (input) =>
      browserWindow({
        id: `w${++seq}`,
        name: input.name,
        settings: input.settings,
        sortOrder: seq,
      }),
    ),
    reconcileOperation: vi
      .fn<WindowBatchPorts['reconcileOperation']>()
      .mockResolvedValue(null),
    bindAccount: vi
      .fn<WindowBatchPorts['bindAccount']>()
      .mockResolvedValue({ bound: true, duplicates: [] }),
  }
  return ports
}
it('plans unique names, persistent operation UUIDs and independent builtin seeds', () => {
  const items = planWindowBatch(
    config(),
    [
      browserWindow({
        name: 'SHOP-01',
        settings: { ...browserWindow().settings, fingerprintSeed: 7 },
      }),
    ],
    () => 7,
  )
  expect(items.map((item) => item.name)).toEqual(['shop-01-2', 'shop-02', 'shop-03'])
  expect(items.map((item) => item.seed)).toEqual([8, 9, 10])
  expect(new Set(items.map((item) => item.operationId)).size).toBe(3)
  expect(items.every((item) => /^[0-9a-f-]{36}$/.test(item.operationId))).toBe(true)
})
it('rejects invalid counts, duplicate accounts and malformed kernel pins before writing', () => {
  for (const count of [0, 1.5, MAX_BATCH_WINDOWS + 1])
    expect(() => planWindowBatch(config({ count }), [])).toThrow()
  expect(() =>
    planWindowBatch(
      config({
        count: 2,
        accounts: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'B' },
        ],
      }),
      [],
    ),
  ).toThrow('账号')
  expect(() => planWindowBatch(config({ kernelVersion: 'latest' }), [])).toThrow('内核')
})
it('delegates external fingerprint and kernel choices to the provider', async () => {
  const ports = fixture()
  const connection = browserConnection({
    id: 'ads',
    providerId: 'adspower',
    capabilities: {
      ...browserConnection().capabilities,
      fingerprintSeed: false,
      kernelSelection: false,
    },
  })
  const job = new WindowBatchJob(config({ connection }), [], ports, () => {
    throw new Error('must not generate seeds')
  })
  expect(job.items.every((item) => item.seed === null)).toBe(true)
  await job.run(() => {})
  expect(
    ports.createWindow.mock.calls.every(
      ([input]) =>
        input.connectionId === 'ads' &&
        input.settings.fingerprintSeed === null &&
        input.kernelVersion === null,
    ),
  ).toBe(true)
})
it('freezes the full builtin kernel reported by the first created window', async () => {
  const ports = fixture()
  const job = new WindowBatchJob(config(), [], ports)
  await job.run(() => {})
  expect(ports.createWindow.mock.calls.map(([input]) => input.kernelVersion)).toEqual([
    null,
    '155.0.8059.39.2',
    '155.0.8059.39.2',
  ])
})
it('reconciles a failed response by operation ID without matching names or seeds', async () => {
  const ports = fixture()
  ports.createWindow.mockRejectedValueOnce(new Error('response lost'))
  ports.reconcileOperation.mockResolvedValueOnce(
    browserWindow({ id: 'recovered', name: 'official renamed' }),
  )
  const job = new WindowBatchJob(config({ count: 1 }), [], ports)
  await job.run(() => {})
  expect(job.items[0]!.window?.id).toBe('recovered')
  expect(ports.reconcileOperation).toHaveBeenCalledWith(job.items[0]!.operationId)
  expect(ports.createWindow).toHaveBeenCalledOnce()
})
it('delegates manual retries to the backend with the exact original UUID and payload', async () => {
  const ports = fixture()
  ports.createWindow
    .mockRejectedValueOnce(new Error('response lost'))
    .mockRejectedValueOnce(new Error('operation_uncertain'))
  const job = new WindowBatchJob(config({ count: 1 }), [], ports)
  await job.run(() => {})
  expect(ports.createWindow).toHaveBeenCalledOnce()
  expect(job.items[0]!.status).toBe('failed')
  await job.run(() => {})
  expect(job.items[0]!.error).toContain('核对')
  await job.run(() => {})
  expect(ports.createWindow).toHaveBeenCalledTimes(3)
  const original = ports.createWindow.mock.calls[0]![0]
  expect(ports.createWindow.mock.calls.every(([input]) => input === original)).toBe(true)
  expect(original.operationId).toBe(job.items[0]!.operationId)
  expect(job.items[0]!.status).toBe('complete')
})
it('can retry a rejection before an operation was persisted without generating a new ID', async () => {
  const ports = fixture()
  ports.createWindow.mockRejectedValueOnce(new Error('not_submitted'))
  ports.reconcileOperation.mockRejectedValue(new Error('operation_missing'))
  const job = new WindowBatchJob(config({ count: 1 }), [], ports)
  await job.run(() => {})
  expect(ports.createWindow).toHaveBeenCalledOnce()
  await job.run(() => {})
  expect(ports.createWindow).toHaveBeenCalledTimes(2)
  expect(ports.createWindow.mock.calls[1]![0]).toBe(ports.createWindow.mock.calls[0]![0])
  expect(job.items[0]!.status).toBe('complete')
})
it('retries a local account binding without recreating the remote environment', async () => {
  const ports = fixture()
  ports.bindAccount.mockRejectedValueOnce(new Error('plugin offline'))
  const job = new WindowBatchJob(
    config({ count: 1, accounts: [{ id: 'a', label: 'seller' }] }),
    [],
    ports,
  )
  await job.run(() => {})
  expect(job.items[0]!.window).not.toBeNull()
  await job.run(() => {})
  expect(ports.createWindow).toHaveBeenCalledOnce()
  expect(ports.bindAccount).toHaveBeenCalledTimes(2)
  expect(job.items[0]!.status).toBe('complete')
})
it('requires explicit duplicate account confirmation on retry', async () => {
  const ports = fixture()
  ports.bindAccount.mockResolvedValueOnce({ bound: false, duplicates: ['other'] })
  const job = new WindowBatchJob(
    config({ count: 1, accounts: [{ id: 'a', label: 'seller' }] }),
    [],
    ports,
  )
  await job.run(() => {})
  expect(job.items[0]!.duplicateWindowIds).toEqual(['other'])
  await job.run(() => {}, new Set(['a']))
  expect(ports.bindAccount).toHaveBeenLastCalledWith('a', 'w1', true)
  expect(ports.createWindow).toHaveBeenCalledOnce()
})
it('guards double execution and stops after the current write', async () => {
  const ports = fixture()
  let resolve!: (value: ReturnType<typeof browserWindow>) => void
  ports.createWindow.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }),
  )
  const job = new WindowBatchJob(config(), [], ports)
  const first = job.run(() => {})
  expect(job.run(() => {})).toBe(first)
  await Promise.resolve()
  job.stopAfterCurrent()
  resolve(browserWindow())
  await first
  expect(ports.createWindow).toHaveBeenCalledOnce()
  expect(job.items.filter((item) => item.status === 'pending')).toHaveLength(2)
})
it('merges results using persistent sorting without moving previously completed rows', () => {
  const rows = planWindowBatch(config({ count: 2 }), []).map((item, index) => ({
    ...item,
    window: browserWindow({ id: String(index), sortOrder: index + 2 }),
  }))
  expect(mergeBatchWindows([browserWindow()], rows).map((row) => row.id)).toEqual([
    '1',
    '0',
    'window-1',
  ])
})
