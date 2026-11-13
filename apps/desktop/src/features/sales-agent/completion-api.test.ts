import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeBrowser } from '@/lib/platform/browser-api'
import { pluginHostAvailable } from '@/lib/platform/native-plugins'
import {
  checkAgentPreflight,
  controlAgentItem,
  controlAgentJob,
  deleteAgentWorkspace,
  getAgentUsage,
  listAgentAttention,
  listAgentItems,
  listAgentModelRequests,
  previewAgentArtifact,
  saveAgentWorkspace,
} from './api'
import { ids, job, now } from './test-data'

vi.mock('@/lib/platform/native-plugins', () => ({
  pluginHostAvailable: vi.fn(),
  callPlugin: vi.fn(),
}))
vi.mock('@/lib/platform/browser-api', () => ({ invokeBrowser: vi.fn() }))

const input = {
  operationId: ids.operation,
  preset: 'inspect_accounts' as const,
  instruction: '',
  concurrency: 3,
  assignments: [{ windowId: ids.window, productIds: [], overrides: [], messages: [] }],
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(pluginHostAvailable).mockReturnValue(true)
})

describe('completion native boundaries', () => {
  it('sends the one preflight payload and validates its report', async () => {
    const report = { ready: true, checkedAt: now, checks: [] }
    vi.mocked(invokeBrowser).mockResolvedValue(report)
    await expect(checkAgentPreflight(input)).resolves.toEqual(report)
    expect(invokeBrowser).toHaveBeenCalledExactlyOnceWith('sales_agent_preflight', {
      input,
    })
  })

  it('uses direct job/control receipts and rejects unrelated jobs', async () => {
    vi.mocked(invokeBrowser).mockResolvedValue({ ...job, takeover: 'stopping' })
    await expect(controlAgentJob(ids.job, 'takeover')).resolves.toMatchObject({
      id: ids.job,
      takeover: 'stopping',
    })
    expect(invokeBrowser).toHaveBeenLastCalledWith('sales_agent_job_control', {
      id: ids.job,
      action: 'takeover',
    })
    vi.mocked(invokeBrowser).mockResolvedValue({ ...job, id: ids.otherWindow })
    await expect(controlAgentJob(ids.job, 'pause')).rejects.toThrow('未确认')
    const receipt = {
      revision: 2,
      items: [{ productId: ids.product, action: 'approve', revision: 2 }],
    }
    vi.mocked(invokeBrowser).mockResolvedValue(receipt)
    await expect(
      controlAgentItem({ jobId: ids.job, productId: ids.product, action: 'approve' }),
    ).resolves.toEqual(receipt)
  })

  it('rejects malformed item edits before IPC and checks paginated job ownership', async () => {
    await expect(
      controlAgentItem({ jobId: ids.job, productId: ids.product, action: 'revise' }),
    ).rejects.toThrow()
    expect(invokeBrowser).not.toHaveBeenCalled()
    vi.mocked(invokeBrowser).mockResolvedValue({
      items: [
        {
          jobId: ids.otherWindow,
          productId: ids.product,
          windowId: ids.window,
          windowName: 'Fixture',
          accountId: ids.account,
          state: 'pending',
          reason: '',
          originalTitle: '',
          originalDescription: '',
          title: '',
          description: '',
          submitted: false,
          controlRevision: 0,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await expect(listAgentItems(ids.job)).rejects.toThrow('不一致')
  })

  it('accepts only bounded local image previews', async () => {
    vi.mocked(invokeBrowser).mockResolvedValue({
      dataUrl: 'https://example.invalid/x.png',
    })
    await expect(previewAgentArtifact(ids.job, ids.image)).rejects.toThrow('图片')
    vi.mocked(invokeBrowser).mockResolvedValue({ dataUrl: 'data:image/png;base64,YQ==' })
    await expect(previewAgentArtifact(ids.job, ids.image)).resolves.toBe(
      'data:image/png;base64,YQ==',
    )
  })

  it('validates optimistic workspace revisions and exact delete acknowledgement', async () => {
    const data = {
      preset: 'post_listing' as const,
      instruction: '',
      concurrency: 3,
      productIds: [],
      windowIds: [],
      assignments: [],
      unassignedOverrides: [],
    }
    const save = {
      id: ids.operation,
      kind: 'draft' as const,
      name: 'Fixture',
      expectedRevision: 4,
      data,
    }
    const entry = {
      id: ids.operation,
      kind: 'draft',
      name: 'Fixture',
      revision: 5,
      data,
      createdAt: now,
      updatedAt: now,
    }
    vi.mocked(invokeBrowser).mockResolvedValue(entry)
    await expect(saveAgentWorkspace(save)).resolves.toEqual(entry)
    expect(invokeBrowser).toHaveBeenLastCalledWith('sales_agent_workspace_save', {
      input: save,
    })
    vi.mocked(invokeBrowser).mockResolvedValue({ ...entry, revision: 6 })
    await expect(saveAgentWorkspace(save)).rejects.toThrow('未确认')
    vi.mocked(invokeBrowser).mockResolvedValue({ deleted: true, id: ids.operation })
    await expect(deleteAgentWorkspace(ids.operation, 5)).resolves.toBeUndefined()
    expect(invokeBrowser).toHaveBeenLastCalledWith('sales_agent_workspace_delete', {
      id: ids.operation,
      expectedRevision: 5,
    })
  })

  it('rejects usage from another batch and requires a host for attention reads', async () => {
    vi.mocked(invokeBrowser).mockResolvedValue({
      batchId: ids.otherWindow,
      requests: 1,
      succeeded: 1,
      failed: 0,
      elapsedMs: 100,
      inputTokens: 0,
      outputTokens: 0,
      unknownUsage: 1,
      estimatedCostUsd: null,
      maxRequests: 100,
      maxCostUsd: null,
      notification: 'disabled',
    })
    await expect(getAgentUsage(ids.batch)).rejects.toThrow('不一致')
    vi.mocked(pluginHostAvailable).mockReturnValue(false)
    await expect(listAgentAttention()).rejects.toThrow('桌面应用')
  })

  it('reads one bounded request-history page and preserves unknown usage and real zero values', async () => {
    const item = {
      requestId: ids.operation,
      jobId: ids.job,
      kind: 'generation',
      state: 'unknown',
      startedAt: now,
      elapsedMs: 5000,
      inputTokens: null,
      outputTokens: 0,
      estimatedCostUsd: null,
      status: null,
    }
    const page = {
      batchId: ids.batch,
      items: [item],
      total: 21,
      page: 2,
      pageSize: 20,
    }
    vi.mocked(invokeBrowser).mockResolvedValue(page)
    await expect(listAgentModelRequests(ids.batch, 2, 20)).resolves.toEqual(page)
    expect(invokeBrowser).toHaveBeenCalledExactlyOnceWith('sales_agent_model_requests', {
      id: ids.batch,
      page: 2,
      pageSize: 20,
    })
  })

  it('rejects request history for another batch and repeated request identities', async () => {
    const item = {
      requestId: ids.operation,
      jobId: ids.job,
      kind: 'decision',
      state: 'succeeded',
      startedAt: now,
      elapsedMs: 100,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      status: 200,
    }
    vi.mocked(invokeBrowser).mockResolvedValue({
      batchId: ids.otherWindow,
      items: [item],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await expect(listAgentModelRequests(ids.batch)).rejects.toThrow('不一致')
    vi.mocked(invokeBrowser).mockResolvedValue({
      batchId: ids.batch,
      items: [item, item],
      total: 2,
      page: 1,
      pageSize: 20,
    })
    await expect(listAgentModelRequests(ids.batch)).rejects.toThrow('重复')
  })
})
