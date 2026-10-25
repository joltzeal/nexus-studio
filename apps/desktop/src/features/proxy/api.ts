import { callPlugin } from '@/lib/platform/native-plugins'
import {
  EMPTY_QUERY,
  PROXY_CAPABILITY,
  PROXY_PLUGIN_ID,
  type BatchResult,
  type CheckResult,
  type ListResult,
  type ProxyConfig,
  type ProxyGroup,
  type ProxyListQuery,
  type ProxyRow,
  type Scheme,
  type SubscriptionDetail,
  type SubscriptionSummary,
} from './types'

function call<T>(method: string, payload: unknown = {}, deadlineMs?: number): Promise<T> {
  return callPlugin<T>(PROXY_PLUGIN_ID, PROXY_CAPABILITY, method, payload, deadlineMs)
}

export interface ProxyInput {
  name: string
  schemes: Scheme[]
  host: string
  port: number
  username: string
  /** Only sent when the user typed a new password. */
  password?: string
  enabled: boolean
  udp: boolean
  groupId: number | null
}

export function listProxies(query: ProxyListQuery): Promise<ListResult> {
  return call<ListResult>('proxy.list', { ...query })
}

/** The window picker searches the entire inventory, including an off-page default. */
export async function listPickerProxies(): Promise<ProxyRow[]> {
  const rows: ProxyRow[] = []
  let offset = 0
  while (true) {
    const page = await listProxies({ ...EMPTY_QUERY, limit: 500, offset })
    if (
      !page ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      page.offset !== offset ||
      !Array.isArray(page.items) ||
      page.items.length > 500 ||
      offset + page.items.length > page.total ||
      (page.items.length === 0 && offset < page.total)
    ) {
      throw new Error('代理池列表未完整读取，请刷新重试。')
    }
    rows.push(...page.items)
    offset += page.items.length
    if (offset >= page.total) return rows
  }
}

export function listGroups(): Promise<{ items: ProxyGroup[] }> {
  return call<{ items: ProxyGroup[] }>('proxy.groups.list')
}

export function createGroup(name: string): Promise<ProxyGroup> {
  return call<ProxyGroup>('proxy.groups.create', { name })
}

export function createProxy(input: ProxyInput): Promise<ProxyRow> {
  return call<ProxyRow>('proxy.create', input)
}

export function updateProxy(id: string, input: ProxyInput): Promise<ProxyRow> {
  return call<ProxyRow>('proxy.update', { id: Number(id), ...input })
}

export function deleteProxies(ids: string[]): Promise<{ deleted: number }> {
  return call<{ deleted: number }>('proxy.delete', { ids: ids.map(Number) })
}

export function importProxies(
  proxyUrls: string,
  groupId: number | null,
): Promise<BatchResult> {
  return call<BatchResult>('proxy.import', { proxyUrls, groupId })
}

export function generateDecodo(input: {
  host: string
  username: string
  password: string
  startPort: number
  endPort: number
  schemes: Scheme[]
  udp: boolean
  groupId: number | null
}): Promise<BatchResult> {
  return call<BatchResult>('proxy.strategy.decodo', input)
}

/** A single check can wait on two outbound requests; give it room. */
export function checkProxy(
  id: string,
  scheme: Scheme | null,
  singleSchemeFallback: boolean,
): Promise<CheckResult> {
  return call<CheckResult>(
    'proxy.check',
    { id: Number(id), scheme, singleSchemeFallback },
    60_000,
  )
}

/**
 * Checks a proxy that is not in the pool yet — the address a user just typed.
 * Same measurement as `checkProxy`, nothing is stored.
 */
export function probeProxy(url: string): Promise<CheckResult> {
  return call<CheckResult>('proxy.probe', { url }, 60_000)
}

export function exportUrls(
  ids: string[],
  preferredScheme: Scheme | null,
): Promise<{ urls: string[]; count: number; requiresSecret: boolean }> {
  return call('proxy.exportUrls', { ids: ids.map(Number), preferredScheme })
}

export function getConfig(): Promise<ProxyConfig> {
  return call<ProxyConfig>('proxy.config.get')
}

export function setConfig(input: {
  defaultEndpointId: string | null
  riskEnabled: boolean
  riskCacheSeconds: number
  riskApiKey?: string
}): Promise<ProxyConfig> {
  return call<ProxyConfig>('proxy.config.set', {
    defaultEndpointId:
      input.defaultEndpointId === null ? null : Number(input.defaultEndpointId),
    riskEnabled: input.riskEnabled,
    riskCacheSeconds: input.riskCacheSeconds,
    ...(input.riskApiKey === undefined ? {} : { riskApiKey: input.riskApiKey }),
  })
}

export function listSubscriptions(): Promise<{ items: SubscriptionSummary[] }> {
  return call<{ items: SubscriptionSummary[] }>('proxy.subscriptions.list')
}

export function getSubscription(id: string): Promise<SubscriptionDetail> {
  return call<SubscriptionDetail>('proxy.subscriptions.get', { id: Number(id) })
}

export interface SubscriptionInput {
  name: string
  enabled: boolean
  sourceMode: 'selected' | 'groups'
  proxyIds: number[]
  groupIds: number[]
  groupName: string
  includeDirect: boolean
  preferredScheme: Scheme | null
}

export function createSubscription(
  input: SubscriptionInput,
): Promise<SubscriptionSummary> {
  return call<SubscriptionSummary>('proxy.subscriptions.create', input)
}

export function deleteSubscription(id: string): Promise<{ deleted: number }> {
  return call<{ deleted: number }>('proxy.subscriptions.delete', { id: Number(id) })
}

export function previewSubscription(id: string): Promise<{
  yaml: string
  nodeCount: number
  excludedCount: number
  redacted: boolean
}> {
  return call('proxy.subscriptions.preview', { id: Number(id) })
}

export function exportSubscription(
  id: string,
): Promise<{ handle: string; bytes: number; nodeCount: number; filename: string }> {
  return call('proxy.subscriptions.export', { id: Number(id) })
}

export function appendToSubscription(
  id: string,
  ids: string[],
): Promise<{ addedCount: number; duplicateCount: number; memberCount: number }> {
  return call('proxy.subscriptions.append', { id: Number(id), ids: ids.map(Number) })
}
