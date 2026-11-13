import {
  AGENT_METHODS,
  AgentBatchCreateSchema,
  AgentBatchDetailSchema,
  AgentBatchPageSchema,
  AgentBatchViewSchema,
  AgentEventPageSchema,
  AgentSettingsSchema,
  SALES_AGENT_CAPABILITY,
  SALES_AGENT_PLUGIN_ID,
  type AgentBatchCreate,
  type AgentBatchDetail,
  type AgentBatchPage,
  type AgentBatchView,
  type AgentEventPage,
  type AgentSettings,
} from '@nexus/plugin-sdk/agent'
import { listBindings } from '@/features/accounts/api'
import type { BindingView } from '@/features/accounts/types'
import { getProduct } from '@/features/products/api'
import type { Product } from '@nexus/plugin-products/contracts'
import { callPlugin, type PluginView } from '@/lib/platform/native-plugins'
import { listBrowserWindows } from '@/lib/platform/windows'
import {
  agentNative as native,
  agentReply as valid,
  agentId as inputId,
  agentPagination as pagination,
  checkAgentPage as checkPage,
  requireAgentHost as requireHost,
} from './native-boundary'

export type AgentControl = 'pause' | 'resume' | 'cancel' | 'reconcile' | 'takeover'
export type ModelKind = 'decision' | 'generation'
export interface AgentModelTest {
  ok: true
  kind: ModelKind
  model: string
  checks: { judgement?: true; vision?: true; english?: true }
}

export interface AgentTarget {
  id: string
  name: string
  provider: string
  state: string
  account: BindingView['account']
  unavailable: string | null
}

export function agentUnavailable(plugin: PluginView | null): string | null {
  if (!plugin || plugin.state === 'available') return 'Ecom Agent 插件尚未安装。'
  if (!plugin.enabled) return 'Ecom Agent 插件未启用，请在插件中心检查。'
  if (plugin.state !== 'running') return 'Ecom Agent 插件尚未运行。'
  if (
    plugin.id !== SALES_AGENT_PLUGIN_ID ||
    !plugin.capabilities.includes(SALES_AGENT_CAPABILITY) ||
    !plugin.granted.includes(SALES_AGENT_CAPABILITY)
  )
    return 'Ecom Agent 插件缺少 sales.agent 授权。'
  if (!AGENT_METHODS.every((method) => plugin.methods.includes(method)))
    return 'Ecom Agent 插件需要更新，当前方法不完整。'
  if (!plugin.storageDurable) return 'Ecom Agent 需要插件持久存储，请检查插件中心。'
  return null
}

export async function createAgentBatch(input: AgentBatchCreate): Promise<AgentBatchView> {
  requireHost()
  const parsed = AgentBatchCreateSchema.parse(input)
  const batch = valid(
    AgentBatchViewSchema,
    await native('sales_agent_batch_create', { input: parsed }),
  )
  if (
    batch.preset !== parsed.preset ||
    batch.concurrency !== parsed.concurrency ||
    batch.total !== parsed.assignments.length ||
    batch.instruction !== parsed.instruction
  )
    throw new Error('批次创建结果未确认，请刷新运行记录核对，不要重复创建。')
  return batch
}

export async function listAgentBatches(page = 1, pageSize = 20): Promise<AgentBatchPage> {
  const query = pagination(page, pageSize)
  const result = valid(
    AgentBatchPageSchema,
    await native('sales_agent_batch_list', query),
  )
  checkPage(result, query, result.items.length)
  if (new Set(result.items.map((batch) => batch.id)).size !== result.items.length)
    throw new Error('Ecom Agent 批次重复，请刷新。')
  const lastPage = Math.max(1, Math.ceil(result.total / query.pageSize))
  if (result.page > lastPage) return listAgentBatches(lastPage, pageSize)
  return result
}

export async function getAgentBatch(
  id: string,
  page = 1,
  pageSize = 20,
): Promise<AgentBatchDetail> {
  const query = { id: inputId(id), ...pagination(page, pageSize) }
  const result = valid(
    AgentBatchDetailSchema,
    await native('sales_agent_batch_get', query),
  )
  checkPage(result, query, result.jobs.length)
  if (
    result.batch.id !== id ||
    result.total !== result.batch.total ||
    new Set(result.jobs.map((job) => job.id)).size !== result.jobs.length ||
    new Set(result.jobs.map((job) => job.windowId)).size !== result.jobs.length
  )
    throw new Error('Ecom Agent 作业与批次不一致，请刷新。')
  const lastPage = Math.max(1, Math.ceil(result.total / query.pageSize))
  if (result.page > lastPage) return getAgentBatch(id, lastPage, pageSize)
  return result
}

export async function controlAgentBatch(
  id: string,
  action: AgentControl,
): Promise<AgentBatchView> {
  if (!['pause', 'resume', 'cancel', 'reconcile', 'takeover'].includes(action))
    throw new Error('不支持的批次操作。')
  const batch = valid(
    AgentBatchViewSchema,
    await native('sales_agent_batch_control', { id: inputId(id), action }),
  )
  if (batch.id !== id) throw new Error('批次操作结果未确认，请刷新核对。')
  return batch
}

export async function getAgentEvents(id: string, cursor = 0): Promise<AgentEventPage> {
  const query = {
    id: inputId(id),
    cursor: AgentEventPageSchema.shape.cursor.parse(cursor),
    limit: 100,
  }
  const result = valid(AgentEventPageSchema, await native('sales_agent_events', query))
  let previous = cursor
  for (const event of result.items) {
    if (event.batchId !== id || event.sequence <= previous)
      throw new Error('事件批次或游标顺序不一致，请重新载入。')
    previous = event.sequence
  }
  if (
    result.cursor !== previous ||
    !Number.isSafeInteger(result.cursor) ||
    (result.hasMore && result.cursor <= cursor) ||
    (result.items.length === 0 && result.hasMore)
  )
    throw new Error('事件游标未向前推进，请刷新。')
  return result
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function settingsReply(value: unknown): AgentSettings | null {
  if (!record(value) || !('settings' in value))
    throw new Error('模型配置返回的数据格式无效。')
  return valid(AgentSettingsSchema.nullable(), value.settings)
}

async function agentCall(method: string, payload: unknown): Promise<unknown> {
  requireHost()
  return callPlugin(
    SALES_AGENT_PLUGIN_ID,
    SALES_AGENT_CAPABILITY,
    method,
    payload,
    120_000,
  )
}

export async function getAgentSettings(): Promise<AgentSettings | null> {
  return settingsReply(await agentCall('salesAgent.settings.get', {}))
}

export async function saveAgentSettings(settings: AgentSettings): Promise<AgentSettings> {
  requireHost()
  const input = AgentSettingsSchema.safeParse(settings)
  if (!input.success) throw new Error('请检查模型地址、密钥、模型名和执行限制。')
  const saved = settingsReply(
    await agentCall('salesAgent.settings.save', { settings: input.data }),
  )
  if (saved === null || JSON.stringify(saved) !== JSON.stringify(input.data))
    throw new Error('模型配置保存结果未确认，请重新读取后核对。')
  return saved
}

export async function testAgentModel(kind: ModelKind): Promise<AgentModelTest> {
  if (kind !== 'decision' && kind !== 'generation') throw new Error('模型类型无效。')
  const result = await agentCall('salesAgent.models.test', { kind })
  if (
    !record(result) ||
    result.ok !== true ||
    result.kind !== kind ||
    typeof result.model !== 'string' ||
    !result.model.trim() ||
    result.model.length > 200 ||
    !record(result.checks) ||
    (kind === 'decision'
      ? result.checks.judgement !== true
      : result.checks.vision !== true || result.checks.english !== true)
  )
    throw new Error('模型测试结果无效，不能确认连接成功。')
  return {
    ok: true,
    kind,
    model: result.model,
    checks: kind === 'decision' ? { judgement: true } : { vision: true, english: true },
  }
}

/** Read the credential-free account bindings, never the full account/password list. */
export async function listAgentTargets(): Promise<AgentTarget[]> {
  requireHost()
  const [windows, bindings] = await Promise.all([listBrowserWindows(), listBindings()])
  const byWindow = new Map<string, BindingView>()
  if (!record(bindings) || !Array.isArray(bindings.items))
    throw new Error('账号绑定列表无效，请刷新。')
  for (const item of bindings.items) {
    if (
      !record(item) ||
      typeof item.windowId !== 'string' ||
      typeof item.accountId !== 'string' ||
      byWindow.has(item.windowId) ||
      (item.account !== null &&
        (!record(item.account) ||
          item.account.id !== item.accountId ||
          typeof item.account.account !== 'string' ||
          typeof item.account.note !== 'string' ||
          !['email', 'google', 'apple', 'facebook'].includes(
            String(item.account.loginMethod),
          ) ||
          !['active', 'pending', 'limited', 'blocked'].includes(
            String(item.account.status),
          )))
    )
      throw new Error('账号绑定资料不一致，未将读取失败视为未关联。')
    byWindow.set(item.windowId, item as unknown as BindingView)
  }
  if (new Set(windows.map((window) => window.id)).size !== windows.length)
    throw new Error('原生窗口列表重复，请刷新。')
  return windows.map((window) => {
    const binding = byWindow.get(window.id)
    const account = binding?.account ?? null
    const unavailable =
      account?.status === 'blocked'
        ? '账号已封禁（blocked），禁止创建任务。'
        : !binding
          ? '未关联 Vinted 账号，请先在窗口管理关联。'
          : !account
            ? '账号资料不可见，请核对绑定；不会自动解除关系。'
            : window.settings.platform !== 'Vinted'
              ? '当前仅支持 Vinted 窗口。'
              : window.state === 'unknown' || window.state === 'missing'
                ? '窗口状态未知或环境不可见，请先在窗口管理核对。'
                : window.state === 'starting' || window.state === 'stopping'
                  ? '窗口正在启停，请等待状态确认。'
                  : null
    return {
      id: window.id,
      name: window.name,
      provider: window.providerId,
      state: window.state,
      account,
      unavailable,
    }
  })
}

export function agentError(cause: unknown): string {
  // Backend messages may include endpoint details. Keep credentials out of UI notices.
  if (cause instanceof Error && !('issues' in cause)) {
    return cause.message
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/([?&](?:api_?key|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
      .replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/gi, '[redacted]@')
      .slice(0, 600)
  }
  return 'Ecom Agent 请求失败，请检查配置或刷新后重试。'
}

export async function readPickedProducts(ids: readonly string[]): Promise<Product[]> {
  requireHost()
  const products: Product[] = []
  // Bound cross-plugin reads instead of opening 100 concurrent detail calls.
  for (let offset = 0; offset < ids.length; offset += 4)
    products.push(...(await Promise.all(ids.slice(offset, offset + 4).map(getProduct))))
  return products
}

export {
  checkAgentPreflight,
  cleanAgentRetention,
  controlAgentItem,
  controlAgentJob,
  deleteAgentWorkspace,
  getAgentUsage,
  getAgentWorkspace,
  listAgentAttention,
  listAgentItems,
  listAgentModelRequests,
  listAgentRelated,
  listAgentWorkspaces,
  previewAgentArtifact,
  previewAgentRetention,
  saveAgentWorkspace,
  type AgentJobControl,
} from './completion-api'
