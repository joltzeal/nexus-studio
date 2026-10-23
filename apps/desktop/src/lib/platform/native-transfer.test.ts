import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  cancelWindowSync,
  exportWindows,
  importWindows,
  importWindowSync,
  inspectTransfer,
  offerWindowSync,
  pickTransferPath,
  receiveWindowSync,
  windowSyncStatus,
  windowTransferRecovery,
} from './native-transfer'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

const report = { windowCount: 1, ids: ['a'], warnings: ['保留原内核版本'] }
const inspection = {
  windows: [{ id: 'a', name: 'A', version: '155.0.1.2', platform: 'Vinted' }],
  sourcePlatform: 'darwin',
  sourceArch: 'arm64',
  plugins: [{ id: 'studio.proxy-pool', version: '1.0.0' }],
  warnings: ['操作系统指纹可能不同'],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isTauri).mockReturnValue(true)
})

describe('native window transfer contracts', () => {
  it('reads only public recovery status through the desktop command', async () => {
    const status = {
      pending: 2,
      warnings: [
        '上次窗口迁移的插件资料尚待恢复，请安装或更新所需插件后刷新重试。',
        'studio.proxy-pool',
      ],
    }
    vi.mocked(invoke).mockResolvedValue({ ...status, journalPath: '/internal/path' })
    await expect(windowTransferRecovery()).resolves.toEqual(status)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('profile_transfer_recovery_status', {})
  })

  it('accepts a recovery status with nothing pending', async () => {
    vi.mocked(invoke).mockResolvedValue({ pending: 0, warnings: [] })
    await expect(windowTransferRecovery()).resolves.toEqual({ pending: 0, warnings: [] })
  })

  it.each([
    null,
    { pending: -1, warnings: [] },
    { pending: 0.5, warnings: [] },
    { pending: '1', warnings: [] },
    { pending: 1, warnings: 'studio.proxy-pool' },
    { pending: 1, warnings: [null] },
  ])('rejects an invalid recovery status %#', async (dto) => {
    vi.mocked(invoke).mockResolvedValue(dto)
    await expect(windowTransferRecovery()).rejects.toThrow('返回')
  })

  it('keeps recovery command failures actionable instead of returning an empty status', async () => {
    vi.mocked(invoke).mockRejectedValue('无法读取迁移恢复记录，请刷新重试。')
    await expect(windowTransferRecovery()).rejects.toThrow('无法读取迁移恢复记录')
  })

  it('uses the native picker and preserves user cancellation', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('/tmp/a.nexuswindow').mockResolvedValue(null)
    await expect(pickTransferPath(true)).resolves.toBe('/tmp/a.nexuswindow')
    await expect(pickTransferPath(false)).resolves.toBeNull()
    expect(invoke).toHaveBeenNthCalledWith(1, 'profile_transfer_pick', { save: true })
    expect(invoke).toHaveBeenNthCalledWith(2, 'profile_transfer_pick', { save: false })
  })

  it('exports exact selected ids, password and native path without altering them', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...report, path: '/tmp/a.nexuswindow' })
    await expect(
      exportWindows(['a'], ' password ', '/tmp/a.nexuswindow'),
    ).resolves.toEqual({ ...report, path: '/tmp/a.nexuswindow' })
    expect(invoke).toHaveBeenCalledExactlyOnceWith('profile_transfer_export', {
      ids: ['a'],
      password: ' password ',
      path: '/tmp/a.nexuswindow',
    })
  })

  it('decrypts a preview before an explicit copy or replace import', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inspection).mockResolvedValue(report)
    await expect(inspectTransfer('/tmp/a.nexuswindow', 'password')).resolves.toEqual(
      inspection,
    )
    await expect(
      importWindows('/tmp/a.nexuswindow', 'password', 'copy'),
    ).resolves.toEqual(report)
    await importWindows('/tmp/a.nexuswindow', 'password', 'replace')
    expect(invoke).toHaveBeenNthCalledWith(1, 'profile_transfer_inspect', {
      path: '/tmp/a.nexuswindow',
      password: 'password',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'profile_transfer_import', {
      path: '/tmp/a.nexuswindow',
      password: 'password',
      mode: 'copy',
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'profile_transfer_import', {
      path: '/tmp/a.nexuswindow',
      password: 'password',
      mode: 'replace',
    })
  })

  it('accepts the nullable optional path on a regular import report', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...report, path: null })
    await expect(
      importWindows('/tmp/a.nexuswindow', 'password', 'copy'),
    ).resolves.toEqual({
      ...report,
      path: null,
    })
    await expect(importWindowSync('job', 'copy')).resolves.toEqual({
      ...report,
      path: null,
    })
  })

  it.each([null, undefined])(
    'still requires a real export path when it is %s',
    async (path) => {
      vi.mocked(invoke).mockResolvedValue({ ...report, path })
      await expect(
        exportWindows(['a'], 'password', '/tmp/a.nexuswindow'),
      ).rejects.toThrow('返回')
    },
  )

  it('drops internal fields from sync status and preserves only public progress', async () => {
    vi.mocked(invoke).mockResolvedValue({
      state: 'completed',
      bytes: 100,
      total: 100,
      path: '/internal/received-snapshot',
    })
    await expect(windowSyncStatus('job')).resolves.toEqual({
      state: 'completed',
      bytes: 100,
      total: 100,
    })
  })

  it('uses an export password verbatim when inspecting its snapshot', async () => {
    vi.mocked(invoke).mockResolvedValue(inspection)
    await inspectTransfer('/tmp/a.nexuswindow', '        ')
    expect(invoke).toHaveBeenCalledExactlyOnceWith('profile_transfer_inspect', {
      path: '/tmp/a.nexuswindow',
      password: '        ',
    })
  })

  it('forwards pairing, status, cancellation and the separate received import', async () => {
    const offer = {
      offerId: 'offer',
      invitation: 'one-time-invitation',
      addresses: ['192.0.2.1'],
      expiresAt: 1792749600000,
    }
    const status = { state: 'transferring', bytes: 25, total: 100 }
    vi.mocked(invoke)
      .mockResolvedValueOnce(offer)
      .mockResolvedValueOnce({ jobId: 'job' })
      .mockResolvedValueOnce({ jobId: 'job-2' })
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(report)

    await expect(offerWindowSync(['a'])).resolves.toEqual(offer)
    await expect(receiveWindowSync('invitation', '')).resolves.toEqual({ jobId: 'job' })
    await receiveWindowSync('invitation', '192.0.2.1')
    await expect(windowSyncStatus('job')).resolves.toEqual(status)
    await cancelWindowSync('job')
    await expect(importWindowSync('job', 'replace')).resolves.toEqual(report)
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['profile_sync_offer', { ids: ['a'] }],
      ['profile_sync_receive', { invitation: 'invitation', host: null }],
      ['profile_sync_receive', { invitation: 'invitation', host: '192.0.2.1' }],
      ['profile_sync_status', { id: 'job' }],
      ['profile_sync_cancel', { id: 'job' }],
      ['profile_sync_import', { id: 'job', mode: 'replace' }],
    ])
  })

  it('never invokes desktop transfer commands in a browser preview', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const operations = [
      () => pickTransferPath(false),
      () => exportWindows(['a'], 'password', '/tmp/a'),
      () => inspectTransfer('/tmp/a', 'password'),
      () => importWindows('/tmp/a', 'password', 'copy'),
      () => offerWindowSync(['a']),
      () => windowSyncStatus('a'),
      () => cancelWindowSync('a'),
      () => receiveWindowSync('invitation', null),
      () => importWindowSync('a', 'copy'),
      () => windowTransferRecovery(),
    ]
    for (const run of operations) {
      await expect(run()).rejects.toThrow('桌面')
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects empty selections and weak export passwords before invoking', async () => {
    await expect(exportWindows([], 'password', '/tmp/a')).rejects.toThrow('选择')
    await expect(exportWindows(['a'], 'short', '/tmp/a')).rejects.toThrow('8')
    await expect(offerWindowSync([])).rejects.toThrow('选择')
    await expect(exportWindows(['a', 'a'], 'password', '/tmp/a')).rejects.toThrow('选择')
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    { ...inspection, windows: [{ id: 'a', name: 'A', platform: 'Vinted' }] },
    { ...inspection, windows: [...inspection.windows, ...inspection.windows] },
    { ...inspection, plugins: [{ id: 'studio.proxy-pool' }] },
    { ...inspection, sourcePlatform: null },
    { ...inspection, warnings: 'warning' },
  ])('rejects an incomplete decrypted preview %#', async (dto) => {
    vi.mocked(invoke).mockResolvedValue(dto)
    await expect(inspectTransfer('/tmp/a', 'password')).rejects.toThrow('返回')
  })

  it.each([
    null,
    { ...report, windowCount: 2 },
    { ...report, ids: ['a', 'a'], windowCount: 2 },
    { ...report, warnings: null },
    { ...report, windowCount: -1 },
  ])('rejects a malformed import report %# instead of claiming success', async (dto) => {
    vi.mocked(invoke).mockResolvedValue(dto)
    await expect(importWindows('/tmp/a', 'password', 'copy')).rejects.toThrow('返回')
  })

  it.each([
    { state: 'ready', bytes: 0, total: 0 },
    { state: 'completed', bytes: 1, total: 2 },
    { state: 'waiting', bytes: -1, total: 0 },
    { state: 'transferring', bytes: 2, total: 1 },
    { state: 'transferring', bytes: Number.NaN, total: 1 },
  ])('rejects an invalid sync status %#', async (dto) => {
    vi.mocked(invoke).mockResolvedValue(dto)
    await expect(windowSyncStatus('job')).rejects.toThrow('返回')
  })

  it('preserves an actionable backend rejection including serialized messages', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({
      code: 'window_running',
      message: '请先关闭目标窗口，再重试覆盖。',
    })
    await expect(importWindowSync('job', 'replace')).rejects.toThrow('请先关闭目标窗口')
    vi.mocked(invoke).mockRejectedValueOnce(
      JSON.stringify({ message: '接收设备缺少 studio.proxy-pool，请先安装。' }),
    )
    await expect(inspectTransfer('/tmp/a', 'password')).rejects.toThrow('请先安装')
  })
})
