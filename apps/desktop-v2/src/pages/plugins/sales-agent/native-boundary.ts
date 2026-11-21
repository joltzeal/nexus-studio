import { AgentBatchPageSchema, AgentBatchViewSchema } from '@nexus/plugin-sdk/agent'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { PluginCallError } from '../../../raccoon/plugins/call'

export function requireAgentHost() {
  if (!isTauri()) throw new Error('Ecom Agent 需要桌面应用，网页不能执行。')
}

export function agentConnectionId(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error('请先选择有效的 Workspace。')
  return value
}

export function agentReply<T>(
  schema: {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false }
  },
  value: unknown,
): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error('Ecom Agent 返回的数据格式无效，请更新后刷新。')
  return result.data
}

export function agentId(id: string): string {
  return AgentBatchViewSchema.shape.id.parse(id)
}

export function agentPagination(page: number, pageSize: number) {
  return {
    page: AgentBatchPageSchema.shape.page.parse(page),
    pageSize: AgentBatchPageSchema.shape.pageSize.parse(pageSize),
  }
}

export function checkAgentPage(
  result: { total: number; page: number; pageSize: number },
  requested: { page: number; pageSize: number },
  count: number,
) {
  const last = Math.max(1, Math.ceil(result.total / requested.pageSize))
  if (
    (result.page !== requested.page && result.page !== Math.min(requested.page, last)) ||
    result.pageSize !== requested.pageSize ||
    count > result.pageSize ||
    count > result.total
  )
    throw new Error('Ecom Agent 分页资料不一致，请刷新。')
}

export async function agentNative(command: string, args: Record<string, unknown>) {
  requireAgentHost()
  try {
    return await invoke<unknown>(command, args)
  } catch (cause) {
    if (
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      'message' in cause &&
      'retryable' in cause &&
      typeof cause.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code) &&
      typeof cause.message === 'string' &&
      typeof cause.retryable === 'boolean'
    )
      throw new PluginCallError(cause.code, cause.message, cause.retryable)
    throw new Error('Ecom Agent 原生操作失败，请刷新后核对。')
  }
}
