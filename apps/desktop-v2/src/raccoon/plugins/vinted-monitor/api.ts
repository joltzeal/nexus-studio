import { callPlugin } from '../call.ts'
import {
  VINTED_CAPABILITY,
  VINTED_PLUGIN_ID,
  type ItemFilters,
  type MonitorInput,
  type Pagination,
  type ProxyInput,
  type ReviewStatus,
} from './model.ts'
import {
  parseItemPage,
  parseItemResult,
  parseMonitorList,
  parseMonitorResult,
  parseObject,
  parseProxyList,
  parseProxyResult,
  parseRunPage,
  parseRun,
  parseMonitor,
  parseBoolean,
  parseRunResult,
  parseStarResult,
  parseUrlResult,
  parseRemoveResult,
  parseDefaultProxyResult,
} from './parse.ts'

function call<T>(
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs = 30_000,
): Promise<T> {
  return callPlugin(
    VINTED_PLUGIN_ID,
    VINTED_CAPABILITY,
    method,
    payload,
    parse,
    deadlineMs,
  )
}

export const vintedMonitorApi = {
  monitors: () => call('vinted.monitors.list', {}, parseMonitorList),
  saveMonitor: (input: MonitorInput) =>
    call('vinted.monitors.save', input, parseMonitorResult),
  removeMonitor: (monitorId: string) =>
    call('vinted.monitors.remove', { monitorId }, parseRemoveResult),
  runMonitor: (monitorId: string) =>
    call('vinted.monitors.run', { monitorId }, parseRunResult),
  runs: (monitorId?: string, pagination: Pagination = { page: 0, pageSize: 20 }) =>
    call(
      'vinted.runs.list',
      { ...pagination, ...(monitorId === undefined ? {} : { monitorId }) },
      parseRunPage,
    ),
  getRun: (runId: string) =>
    call('vinted.runs.get', { runId }, (value) => ({
      item: parseRun(parseObject(value).item),
    })),
  items: (pagination: Pagination & ItemFilters) =>
    call('vinted.items.list', pagination, parseItemPage),
  getItem: (itemId: string) => call('vinted.items.get', { itemId }, parseItemResult),
  starItem: (itemId: string, starred: boolean) =>
    call('vinted.items.star', { itemId, starred }, parseStarResult),
  reviewItem: (itemId: string, status: ReviewStatus, note: string) =>
    call('vinted.items.availability', { itemId, status, note }, parseStarResult),
  removeItem: (itemId: string) =>
    call('vinted.items.remove', { itemId }, parseRemoveResult),
  monitorSeller: (itemId: string) =>
    call('vinted.items.monitorSeller', { itemId }, (value) => {
      const row = parseObject(value)
      return { monitor: parseMonitor(row.monitor), created: parseBoolean(row.created) }
    }),
  proxies: () => call('vinted.proxies.list', {}, parseProxyList),
  saveProxy: (input: ProxyInput) => call('vinted.proxies.save', input, parseProxyResult),
  removeProxy: (proxyId: string) =>
    call('vinted.proxies.remove', { proxyId }, parseRemoveResult),
  setDefaultProxy: (proxyId: string | null) =>
    call('vinted.proxies.default', { proxyId }, parseDefaultProxyResult),
  inspectUrl: (url: string) => call('vinted.url.inspect', { url }, parseUrlResult),
  imageOpen: (itemId: string, url: string) =>
    call('vinted.image.open', { itemId, url }, parseObject, 40_000),
  imageRead: (id: string, offset: number) =>
    call('vinted.image.read', { id, offset }, parseObject, 40_000),
  imageClose: (id: string) => call('vinted.image.close', { id }, parseObject, 40_000),
}
