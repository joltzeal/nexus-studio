import { callPlugin } from '../call'
import {
  PROXY_PLUGIN_ID,
  EMPTY_QUERY,
  type ProxyInput,
  type ProxyQuery,
  type Scheme,
  type SubscriptionInput,
} from './model'
import {
  array,
  boolean,
  integer,
  object,
  parseConfig,
  parseList,
  parseProxy,
  parseSubscription,
  text,
} from './parse'

const call = <T>(
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs?: number,
) => callPlugin(PROXY_PLUGIN_ID, 'proxy.provider', method, payload, parse, deadlineMs)

const selection = (ids: string[]) =>
  ids.map((id) => {
    const numeric = Number(id)
    if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error('代理标识无效')
    return numeric
  })
const batch = (value: unknown) => {
  const row = object(value)
  return {
    requested: integer(row.requested),
    created: integer(row.created),
    duplicates: integer(row.duplicates),
    merged: integer(row.merged),
  }
}

export const proxyPoolApi = {
  get: (endpoint: number) =>
    call('proxy.get', { id: endpoint }, (value) => {
      const result = parseProxy(value)
      if (result.id !== String(endpoint)) throw new Error('代理池端点返回无效')
      return result
    }),
  list: async (query: ProxyQuery) => {
    const result = await call('proxy.list', query, parseList)
    if (result.offset !== query.offset || result.limit !== query.limit)
      throw new Error('代理池分页返回无效')
    return result
  },
  groups: () =>
    call('proxy.groups.list', {}, (value) =>
      array(object(value).items, (item) => {
        const row = object(item)
        return {
          id: integer(row.id, 1),
          name: text(row.name),
          createdAt: text(row.createdAt),
        }
      }),
    ),
  createGroup: (name: string) =>
    call('proxy.groups.create', { name }, (value) => {
      const row = object(value)
      return {
        id: integer(row.id, 1),
        name: text(row.name),
        createdAt: text(row.createdAt),
      }
    }),
  create: (input: ProxyInput) => call('proxy.create', input, parseProxy),
  update: (id: string, input: ProxyInput) =>
    call('proxy.update', { id: selection([id])[0], ...input }, parseProxy),
  remove: (ids: string[]) =>
    call('proxy.delete', { ids: selection(ids) }, (value) =>
      integer(object(value).deleted),
    ),
  import: (proxyUrls: string, groupId: number | null) =>
    call('proxy.import', { proxyUrls, groupId }, batch),
  check: (id: string, scheme: Scheme | null) =>
    call(
      'proxy.check',
      { id: selection([id])[0], scheme, singleSchemeFallback: false },
      (value) => {
        const row = object(value)
        if (row.id !== id) throw new Error('代理检测返回标识无效')
        return { ok: boolean(row.ok), saved: boolean(row.saved) }
      },
      60_000,
    ),
  exportUrls: (ids: string[], preferredScheme: Scheme | null) =>
    call('proxy.exportUrls', { ids: selection(ids), preferredScheme }, (value) => {
      const row = object(value)
      const urls = array(row.urls, text)
      const count = integer(row.count)
      if (count !== urls.length) throw new Error('代理 URL 返回数量无效')
      return { urls, count, requiresSecret: boolean(row.requiresSecret) }
    }),
  config: () => call('proxy.config.get', {}, parseConfig),
  saveConfig: (input: {
    defaultEndpointId: string | null
    riskEnabled: boolean
    riskCacheSeconds: number
    riskApiKey?: string
  }) =>
    call(
      'proxy.config.set',
      {
        ...input,
        defaultEndpointId:
          input.defaultEndpointId === null
            ? null
            : selection([input.defaultEndpointId])[0],
      },
      parseConfig,
    ),
  subscriptions: () =>
    call('proxy.subscriptions.list', {}, (value) =>
      array(object(value).items, parseSubscription),
    ),
  createSubscription: (input: SubscriptionInput) =>
    call('proxy.subscriptions.create', input, parseSubscription),
  deleteSubscription: (id: string) =>
    call('proxy.subscriptions.delete', { id: selection([id])[0] }, (value) =>
      integer(object(value).deleted),
    ),
  appendSubscription: (id: string, ids: string[]) =>
    call(
      'proxy.subscriptions.append',
      { id: selection([id])[0], ids: selection(ids) },
      (value) => {
        const row = object(value)
        return {
          added: integer(row.addedCount),
          duplicates: integer(row.duplicateCount),
          total: integer(row.memberCount),
        }
      },
    ),
  previewSubscription: (id: string) =>
    call('proxy.subscriptions.preview', { id: selection([id])[0] }, (value) => {
      const row = object(value)
      if (row.redacted !== true) throw new Error('订阅预览未脱敏，已阻止显示')
      return {
        yaml: text(row.yaml),
        nodeCount: integer(row.nodeCount),
        excludedCount: integer(row.excludedCount),
      }
    }),
  exportSubscription: (id: string) =>
    call('proxy.subscriptions.export', { id: selection([id])[0] }, (value) => {
      const row = object(value)
      return {
        handle: text(row.handle),
        bytes: integer(row.bytes),
        nodeCount: integer(row.nodeCount),
        filename: text(row.filename),
      }
    }),
}

export async function listAllProxies() {
  const items = []
  let offset = 0
  for (;;) {
    const page = await proxyPoolApi.list({ ...EMPTY_QUERY, offset, limit: 500 })
    items.push(...page.items)
    offset += page.items.length
    if (offset >= page.total) break
    if (page.items.length === 0) throw new Error('代理池库存读取不完整，请刷新重试')
  }
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error('代理池库存读取期间发生变化，请刷新重试')
  return items
}
