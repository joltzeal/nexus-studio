import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  createBrowserWindow,
  deleteBrowserWindow,
  listBrowserWindows,
  listBrowserOperations,
  reconcileBrowserOperation,
  resolveBrowserOperation,
  startBrowserWindow,
  stopBrowserWindow,
  updateBrowserWindow,
  updateBrowserWindowNote,
} from './windows'
import { browserCreateInput, browserWindow } from './browser-test-support'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }))
beforeEach(() => vi.resetAllMocks())

describe('browser window API', () => {
  it('resolves an explicit association using its persisted operation UUID', async () => {
    expect(resolveBrowserOperation).toBeTypeOf('function')
    const input = {
      id: browserCreateInput().operationId,
      action: 'associate' as const,
      providerProfileId: 'official-1',
      confirmed: true as const,
    }
    vi.mocked(invoke).mockResolvedValueOnce(browserWindow())
    await expect(resolveBrowserOperation(input)).resolves.toEqual(browserWindow())
    expect(invoke).toHaveBeenCalledExactlyOnceWith('browser_operation_resolve', {
      input,
    })
  })

  it('accepts a completed abandonment null result and preserves structured rejections', async () => {
    expect(resolveBrowserOperation).toBeTypeOf('function')
    const input = {
      id: browserCreateInput().operationId,
      action: 'abandon' as const,
      confirmed: true as const,
    }
    vi.mocked(invoke).mockResolvedValueOnce(null)
    await expect(resolveBrowserOperation(input)).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledExactlyOnceWith('browser_operation_resolve', {
      input,
    })
    vi.mocked(invoke).mockRejectedValueOnce({
      code: 'operation_uncertain',
      message: '当前状态无法确认',
      retryable: false,
    })
    await expect(resolveBrowserOperation(input)).rejects.toMatchObject({
      code: 'operation_uncertain',
      message: '当前状态无法确认',
      retryable: false,
    })
  })

  it('rejects unconfirmed resolution inputs and malformed success values', async () => {
    expect(resolveBrowserOperation).toBeTypeOf('function')
    const id = browserCreateInput().operationId
    const input = { id, action: 'abandon' as const, confirmed: true as const }
    for (const invalid of [
      { ...input, id: 'not-a-uuid' },
      { ...input, providerProfileId: 'official-1' },
      {
        id,
        action: 'associate' as const,
        confirmed: true as const,
        providerProfileId: '',
      },
    ]) {
      await expect(resolveBrowserOperation(invalid)).rejects.toThrow()
    }
    expect(invoke).not.toHaveBeenCalled()
    vi.mocked(invoke).mockResolvedValueOnce({ resolved: true })
    await expect(resolveBrowserOperation(input)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('lists all connections by default and sorts equal timestamps by persistent order', async () => {
    const records = [
      browserWindow({ id: 'old', createdAt: 5, sortOrder: 9 }),
      browserWindow({ id: 'first', createdAt: 10, sortOrder: 1 }),
      browserWindow({ id: 'second', createdAt: 10, sortOrder: 2 }),
      browserWindow({ id: 'third', createdAt: 10, sortOrder: 2 }),
    ]
    vi.mocked(invoke).mockResolvedValue(records)
    expect((await listBrowserWindows()).map((row) => row.id)).toEqual([
      'third',
      'second',
      'first',
      'old',
    ])
    expect(invoke).toHaveBeenLastCalledWith('browser_window_list', {})
    await listBrowserWindows('ads-1')
    expect(invoke).toHaveBeenLastCalledWith('browser_window_list', {
      connectionId: 'ads-1',
    })
    expect(records[0]!.id).toBe('old')
  })

  it('sends strict create/update inputs without compatibility arguments', async () => {
    vi.mocked(invoke).mockResolvedValue(browserWindow())
    const input = browserCreateInput()
    await createBrowserWindow(input)
    expect(invoke).toHaveBeenLastCalledWith('browser_window_create', { input })
    const { connectionId, operationId, kernelVersion, ...fields } = input
    expect(connectionId).toBe('builtin')
    expect(operationId).toBe('15b41684-b179-46c9-a1b8-e1b66812dc33')
    expect(kernelVersion).toBeNull()
    await updateBrowserWindow({ id: 'window-1', ...fields })
    expect(invoke).toHaveBeenLastCalledWith('browser_window_update', {
      input: { id: 'window-1', ...fields },
    })
  })

  it('rejects invalid inputs and malformed desktop results', async () => {
    await expect(
      createBrowserWindow(browserCreateInput({ operationId: 'name-seed' })),
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
    vi.mocked(invoke).mockResolvedValue([{ ...browserWindow(), running: false }])
    await expect(listBrowserWindows()).rejects.toThrow('格式')
  })

  it('keeps structured desktop errors and their retry policy', async () => {
    vi.mocked(invoke).mockRejectedValue({
      code: 'operation_uncertain',
      message: '结果待核对',
      retryable: false,
    })
    await expect(startBrowserWindow('window-1')).rejects.toMatchObject({
      code: 'operation_uncertain',
      message: '结果待核对',
      retryable: false,
    })
  })

  it('uses separate start/stop commands and explicit deletion semantics', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    await startBrowserWindow('window-1')
    await stopBrowserWindow('window-1')
    await deleteBrowserWindow('window-1', false)
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['browser_window_start', { id: 'window-1' }],
      ['browser_window_stop', { id: 'window-1' }],
      ['browser_window_delete', { id: 'window-1', deleteEnvironment: false }],
    ])
  })

  it('patches notes only and confirms persistence before reporting success', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('note')
    await expect(updateBrowserWindowNote('window-1', ' note ')).resolves.toBe('note')
    expect(invoke).toHaveBeenLastCalledWith('browser_window_update_note', {
      id: 'window-1',
      note: 'note',
    })
    vi.mocked(invoke).mockResolvedValueOnce('stale')
    await expect(updateBrowserWindowNote('window-1', 'note')).rejects.toThrow()
    await expect(updateBrowserWindowNote('window-1', '窗'.repeat(121))).rejects.toThrow()
  })

  it('reconciles only a persisted operation UUID and accepts a completed delete null result', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([])
    await listBrowserOperations()
    expect(invoke).toHaveBeenLastCalledWith('browser_operation_list', {})
    const operationId = browserCreateInput().operationId
    vi.mocked(invoke).mockResolvedValueOnce(null)
    await expect(reconcileBrowserOperation(operationId)).resolves.toBeNull()
    expect(invoke).toHaveBeenLastCalledWith('browser_operation_reconcile', {
      operationId,
    })
    vi.mocked(invoke).mockRejectedValueOnce({
      code: 'operation_uncertain',
      message: '结果待核对',
      retryable: false,
    })
    await expect(reconcileBrowserOperation(operationId)).rejects.toMatchObject({
      code: 'operation_uncertain',
      message: '结果待核对',
      retryable: false,
    })
  })
})
