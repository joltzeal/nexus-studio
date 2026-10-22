import { callPlugin } from '@/lib/platform/native-plugins'
import {
  VINTED_CAPABILITY,
  VINTED_PLUGIN_ID,
  type ItemList,
  type MonitorInput,
  type MonitorList,
  type Run,
  type RunList,
} from './types'

function call<T>(method: string, payload: unknown = {}): Promise<T> {
  return callPlugin<T>(VINTED_PLUGIN_ID, VINTED_CAPABILITY, method, payload)
}

export function listMonitors(): Promise<MonitorList> {
  return call<MonitorList>('vinted.monitors.list')
}

export function saveMonitor(
  input: MonitorInput,
): Promise<{ item: MonitorList['items'][number]; created: boolean }> {
  return call('vinted.monitors.save', input)
}

export function removeMonitor(monitorId: string): Promise<{ removed: boolean }> {
  return call('vinted.monitors.remove', { monitorId })
}

export function runMonitor(monitorId: string): Promise<{ run: Run }> {
  return call('vinted.monitors.run', { monitorId })
}

export function listRuns(monitorId?: string, limit = 30): Promise<RunList> {
  return call<RunList>(
    'vinted.runs.list',
    monitorId === undefined ? { limit } : { monitorId, limit },
  )
}

export function getRun(runId: string): Promise<{ item: Run }> {
  return call('vinted.runs.get', { runId })
}

export function listItems(
  monitorId: string,
  page: number,
  pageSize: number,
  keyword?: string,
): Promise<ItemList> {
  return call<ItemList>('vinted.items.list', {
    monitorId,
    page,
    pageSize,
    ...(keyword === undefined || keyword === '' ? {} : { keyword }),
  })
}

export function inspectUrl(url: string): Promise<{
  kind: 'catalog' | 'member'
  host: string
  userId: string | null
  url: string
}> {
  return call('vinted.url.inspect', { url })
}
