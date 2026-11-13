import { AgentBatchPageSchema, AgentBatchViewSchema } from '@nexus/plugin-sdk/agent'
import { invokeBrowser } from '@/lib/platform/browser-api'
import { pluginHostAvailable } from '@/lib/platform/native-plugins'

export function requireAgentHost() {
  if (!pluginHostAvailable()) throw new Error('ecom agent 需要桌面应用，网页不能执行。')
}

export function agentReply<T>(
  schema: {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false }
  },
  value: unknown,
): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error('ecom agent 返回的数据格式无效，请更新后刷新。')
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
    throw new Error('ecom agent 分页资料不一致，请刷新。')
}

export async function agentNative(command: string, args: Record<string, unknown>) {
  requireAgentHost()
  return invokeBrowser(command, args)
}
