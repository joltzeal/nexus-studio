import {
  AgentAttentionPageSchema,
  AgentBatchCreateSchema,
  AgentControlsSchema,
  AgentItemControlSchema,
  AgentItemPageSchema,
  AgentJobViewSchema,
  AgentModelRequestPageSchema,
  AgentPreflightSchema,
  AgentRetentionPreviewSchema,
  AgentSettingsSchema,
  AgentUsageSchema,
  AgentWorkspaceEntrySchema,
  AgentWorkspacePageSchema,
  AgentWorkspaceSaveSchema,
  type AgentBatchCreate,
  type AgentAttentionPage,
  type AgentItemPage,
  type AgentItemControl,
  type AgentModelRequestPage,
  type AgentWorkspacePage,
  type AgentWorkspaceSave,
} from '@nexus/plugin-sdk/agent'
import {
  agentId,
  agentNative,
  agentPagination,
  agentReply,
  checkAgentPage,
  requireAgentHost,
} from './native-boundary'

export type AgentJobControl = 'pause' | 'resume' | 'cancel' | 'takeover'

export async function checkAgentPreflight(input: AgentBatchCreate) {
  requireAgentHost()
  return agentReply(
    AgentPreflightSchema,
    await agentNative('sales_agent_preflight', {
      input: AgentBatchCreateSchema.parse(input),
    }),
  )
}

export async function controlAgentJob(id: string, action: AgentJobControl) {
  if (!['pause', 'resume', 'cancel', 'takeover'].includes(action))
    throw new Error('不支持的窗口操作。')
  const job = agentReply(
    AgentJobViewSchema,
    await agentNative('sales_agent_job_control', { id: agentId(id), action }),
  )
  if (job.id !== id) throw new Error('窗口操作结果未确认，请刷新核对。')
  return job
}

export async function controlAgentItem(input: AgentItemControl) {
  requireAgentHost()
  const parsed = AgentItemControlSchema.parse(input)
  const result = agentReply(
    AgentControlsSchema,
    await agentNative('sales_agent_item_control', parsed),
  )
  if (
    !result.items.some(
      (item) => item.productId === parsed.productId && item.action === parsed.action,
    )
  )
    throw new Error('商品操作结果未确认，请刷新核对。')
  return result
}

export async function listAgentItems(
  id: string,
  page = 1,
  pageSize = 20,
  attentionOnly = false,
): Promise<AgentItemPage> {
  const query = { id: agentId(id), ...agentPagination(page, pageSize), attentionOnly }
  const result = agentReply(
    AgentItemPageSchema,
    await agentNative('sales_agent_items', query),
  )
  checkAgentPage(result, query, result.items.length)
  if (
    result.items.some((item) => item.jobId !== id) ||
    new Set(result.items.map((item) => item.productId)).size !== result.items.length
  )
    throw new Error('商品与作业关系不一致，请刷新。')
  const last = Math.max(1, Math.ceil(result.total / pageSize))
  return result.page > last ? listAgentItems(id, last, pageSize, attentionOnly) : result
}

export async function previewAgentArtifact(jobId: string, artifactId: string) {
  const result = await agentNative('sales_agent_artifact_preview', {
    jobId: agentId(jobId),
    artifactId: agentId(artifactId),
  })
  if (
    !result ||
    typeof result !== 'object' ||
    !('dataUrl' in result) ||
    typeof result.dataUrl !== 'string' ||
    result.dataUrl.length > 12 * 1024 * 1024 ||
    !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(result.dataUrl)
  )
    throw new Error('任务图片预览无效，请刷新。')
  return result.dataUrl
}

export async function listAgentWorkspaces(
  kind: 'draft' | 'template' | undefined,
  page = 1,
  pageSize = 20,
): Promise<AgentWorkspacePage> {
  if (kind !== undefined && kind !== 'draft' && kind !== 'template')
    throw new Error('草稿类型无效。')
  const query = { ...(kind ? { kind } : {}), ...agentPagination(page, pageSize) }
  const result = agentReply(
    AgentWorkspacePageSchema,
    await agentNative('sales_agent_workspace_list', query),
  )
  checkAgentPage(result, query, result.items.length)
  if (
    new Set(result.items.map((item) => item.id)).size !== result.items.length ||
    (kind && result.items.some((item) => item.kind !== kind))
  )
    throw new Error('草稿或模板资料不一致，请刷新。')
  const last = Math.max(1, Math.ceil(result.total / pageSize))
  return result.page > last ? listAgentWorkspaces(kind, last, pageSize) : result
}

export async function getAgentWorkspace(id: string) {
  const result = agentReply(
    AgentWorkspaceEntrySchema,
    await agentNative('sales_agent_workspace_get', { id: agentId(id) }),
  )
  if (result.id !== id) throw new Error('草稿或模板关系不一致，请刷新。')
  return result
}

export async function saveAgentWorkspace(input: AgentWorkspaceSave) {
  requireAgentHost()
  const parsed = AgentWorkspaceSaveSchema.parse(input)
  const result = agentReply(
    AgentWorkspaceEntrySchema,
    await agentNative('sales_agent_workspace_save', { input: parsed }),
  )
  if (
    result.id !== parsed.id ||
    result.kind !== parsed.kind ||
    result.name !== parsed.name ||
    result.revision !== parsed.expectedRevision + 1 ||
    JSON.stringify(result.data) !== JSON.stringify(parsed.data)
  )
    throw new Error('草稿保存结果未确认，请先重新读取核对。')
  return result
}

export async function deleteAgentWorkspace(id: string, expectedRevision: number) {
  const result = await agentNative('sales_agent_workspace_delete', {
    id: agentId(id),
    expectedRevision: AgentWorkspaceEntrySchema.shape.revision.parse(expectedRevision),
  })
  if (
    !result ||
    typeof result !== 'object' ||
    !('deleted' in result) ||
    result.deleted !== true ||
    !('id' in result) ||
    result.id !== id
  )
    throw new Error('删除结果未确认，请先刷新核对。')
}

export async function getAgentUsage(id: string) {
  const result = agentReply(
    AgentUsageSchema,
    await agentNative('sales_agent_usage', { id: agentId(id) }),
  )
  if (result.batchId !== id) throw new Error('用量与批次不一致，请刷新。')
  return result
}

export async function listAgentModelRequests(
  id: string,
  page = 1,
  pageSize = 20,
): Promise<AgentModelRequestPage> {
  const query = { id: agentId(id), ...agentPagination(page, pageSize) }
  const result = agentReply(
    AgentModelRequestPageSchema,
    await agentNative('sales_agent_model_requests', query),
  )
  checkAgentPage(result, query, result.items.length)
  if (result.batchId !== id) throw new Error('模型请求与批次不一致，请刷新。')
  if (new Set(result.items.map((item) => item.requestId)).size !== result.items.length)
    throw new Error('模型请求记录重复，请刷新。')
  const last = Math.max(1, Math.ceil(result.total / pageSize))
  return result.page > last ? listAgentModelRequests(id, last, pageSize) : result
}

export async function listAgentAttention(
  page = 1,
  pageSize = 20,
): Promise<AgentAttentionPage> {
  const query = agentPagination(page, pageSize)
  const result = agentReply(
    AgentAttentionPageSchema,
    await agentNative('sales_agent_attention', query),
  )
  checkAgentPage(result, query, result.items.length)
  if (new Set(result.items.map((item) => item.jobId)).size !== result.items.length)
    throw new Error('待处理作业重复，请刷新。')
  const last = Math.max(1, Math.ceil(result.total / pageSize))
  return result.page > last ? listAgentAttention(last, pageSize) : result
}

export async function listAgentRelated(
  kind: 'product' | 'window' | 'account',
  id: string,
  page = 1,
  pageSize = 20,
): Promise<AgentAttentionPage> {
  if (!['product', 'window', 'account'].includes(kind))
    throw new Error('关联记录类型无效。')
  const query = { kind, id: agentId(id), ...agentPagination(page, pageSize) }
  const result = agentReply(
    AgentAttentionPageSchema,
    await agentNative('sales_agent_related', query),
  )
  checkAgentPage(result, query, result.items.length)
  if (
    new Set(result.items.map((item) => item.jobId)).size !== result.items.length ||
    result.items.some(
      (item) =>
        (kind === 'window' && item.windowId !== id) ||
        (kind === 'account' && item.accountId !== id),
    )
  )
    throw new Error('关联运行记录不一致，请刷新。')
  const last = Math.max(1, Math.ceil(result.total / pageSize))
  return result.page > last ? listAgentRelated(kind, id, last, pageSize) : result
}

export async function previewAgentRetention(days: number) {
  const parsed = AgentSettingsSchema.shape.retention.parse({ days })
  return agentReply(
    AgentRetentionPreviewSchema,
    await agentNative('sales_agent_retention_preview', { days: parsed.days }),
  )
}

export async function cleanAgentRetention(token: string) {
  const result = await agentNative('sales_agent_retention_clean', {
    token: AgentRetentionPreviewSchema.shape.token.parse(token),
  })
  if (
    !result ||
    typeof result !== 'object' ||
    !('deletedBatches' in result) ||
    !('freedBytes' in result) ||
    typeof result.deletedBatches !== 'number' ||
    typeof result.freedBytes !== 'number' ||
    !Number.isSafeInteger(result.deletedBatches) ||
    result.deletedBatches < 0 ||
    !Number.isSafeInteger(result.freedBytes) ||
    result.freedBytes < 0
  )
    throw new Error('清理结果未确认，请重新预览，不能重复清理原计划。')
  return { deletedBatches: result.deletedBatches, freedBytes: result.freedBytes }
}
