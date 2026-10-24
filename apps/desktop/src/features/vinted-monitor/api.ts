import { callPlugin } from '@/lib/platform/native-plugins'
import { ImageTransferQueue } from './image-transfer-queue'
import {
  VINTED_CAPABILITY,
  VINTED_PLUGIN_ID,
  type Item,
  type ItemFilters,
  type ItemList,
  type MonitorInput,
  type MonitorList,
  type MonitorProxy,
  type Pagination,
  type ProxyInput,
  type ProxyList,
  type ReviewStatus,
  type Run,
  type RunList,
} from './types'

function call<T>(method: string, payload: unknown = {}, deadlineMs?: number): Promise<T> {
  return callPlugin<T>(VINTED_PLUGIN_ID, VINTED_CAPABILITY, method, payload, deadlineMs)
}

export function listMonitors(pagination?: Pagination): Promise<MonitorList> {
  return call<MonitorList>('vinted.monitors.list', pagination ?? {})
}

export function listProxies(): Promise<ProxyList> {
  return call('vinted.proxies.list')
}

export function saveProxy(
  input: ProxyInput,
): Promise<{ item: MonitorProxy; created: boolean }> {
  return call('vinted.proxies.save', input)
}

export function removeProxy(proxyId: string): Promise<{ removed: boolean }> {
  return call('vinted.proxies.remove', { proxyId })
}

export function setDefaultProxy(
  proxyId: string | null,
): Promise<{ defaultProxyId: string | null }> {
  return call('vinted.proxies.default', { proxyId })
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

export function listRuns(
  monitorId?: string,
  pagination: number | Pagination = 30,
): Promise<RunList> {
  return call<RunList>('vinted.runs.list', {
    ...(monitorId === undefined ? {} : { monitorId }),
    ...(typeof pagination === 'number' ? { limit: pagination } : pagination),
  })
}

export function getRun(runId: string): Promise<{ item: Run }> {
  return call('vinted.runs.get', { runId })
}

export function listItems(params: Pagination & ItemFilters): Promise<ItemList>
export function listItems(
  monitorId: string,
  page: number,
  pageSize: number,
  keyword?: string,
): Promise<ItemList>
export function listItems(
  params: string | (Pagination & ItemFilters),
  page = 0,
  pageSize = 20,
  keyword?: string,
): Promise<ItemList> {
  if (typeof params !== 'string') return call('vinted.items.list', params)
  return call<ItemList>('vinted.items.list', {
    monitorId: params,
    page,
    pageSize,
    ...(keyword === undefined || keyword === '' ? {} : { keyword }),
  })
}

export function getItem(itemId: string): Promise<{ item: Item }> {
  return call('vinted.items.get', { itemId })
}

export function starItem(itemId: string, starred: boolean): Promise<{ item: Item }> {
  return call('vinted.items.star', { itemId, starred })
}

export function reviewItem(
  itemId: string,
  status: ReviewStatus,
  note: string,
): Promise<{ item: Item }> {
  return call('vinted.items.availability', { itemId, status, note })
}

export function removeItem(itemId: string): Promise<{ removed: boolean }> {
  return call('vinted.items.remove', { itemId })
}

export function monitorSeller(
  itemId: string,
): Promise<{ monitor: MonitorList['items'][number]; created: boolean }> {
  return call('vinted.items.monitorSeller', { itemId })
}

export function inspectUrl(url: string): Promise<{
  kind: 'catalog' | 'member'
  host: string
  userId: string | null
  url: string
}> {
  return call('vinted.url.inspect', { url })
}

const IMAGE_MAX_BYTES = 8 * 1024 * 1024
const IMAGE_MAX_CHUNK = 256 * 1024
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const TRANSFER_ERROR = '商品图片传输数据无效，请更新监控插件后重试'
const imageTransfers = new ImageTransferQueue()

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(TRANSFER_ERROR)
  }
  return value as Record<string, unknown>
}

/** Images and AI references share the monitor plugin's selected proxy route. */
export async function loadVintedImage(
  itemId: string,
  url: string,
  signal: AbortSignal,
): Promise<Blob> {
  return imageTransfers.run(signal, () => transferVintedImage(itemId, url, signal))
}

async function transferVintedImage(
  itemId: string,
  url: string,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted()
  let id: string | null = null
  try {
    const meta = object(await call('vinted.image.open', { itemId, url }, 40_000))
    if (typeof meta.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(meta.id)) {
      throw new Error(TRANSFER_ERROR)
    }
    id = meta.id
    signal.throwIfAborted()
    const { size, chunkSize, mime } = meta
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > IMAGE_MAX_BYTES ||
      typeof chunkSize !== 'number' ||
      !Number.isSafeInteger(chunkSize) ||
      chunkSize <= 0 ||
      chunkSize > IMAGE_MAX_CHUNK ||
      typeof mime !== 'string' ||
      !IMAGE_MIMES.has(mime)
    )
      throw new Error(TRANSFER_ERROR)
    const bytes = new Uint8Array(size)
    for (let offset = 0; offset < size; offset += chunkSize) {
      signal.throwIfAborted()
      const chunk = object(await call('vinted.image.read', { id, offset }))
      signal.throwIfAborted()
      const expected = Math.min(chunkSize, size - offset)
      if (
        chunk.offset !== offset ||
        typeof chunk.data !== 'string' ||
        chunk.data.length !== Math.ceil(expected / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data)
      )
        throw new Error(TRANSFER_ERROR)
      const decoded = atob(chunk.data)
      if (decoded.length !== expected || btoa(decoded) !== chunk.data)
        throw new Error(TRANSFER_ERROR)
      for (let i = 0; i < decoded.length; i += 1)
        bytes[offset + i] = decoded.charCodeAt(i)
    }
    return new Blob([bytes], { type: mime })
  } catch (cause) {
    if (signal.aborted) signal.throwIfAborted()
    const reason =
      typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : ''
    const detail = /未声明该方法|不支持该方法/.test(reason)
      ? '请先更新 Vinted 监控插件'
      : reason || '商品图片加载失败，请检查采集代理后重试'
    throw imageTransferError(detail, cause)
  } finally {
    if (id !== null) await call('vinted.image.close', { id }).catch(() => undefined)
  }
}

function imageTransferError(detail: string, cause: unknown): Error {
  return Object.assign(new Error(detail), { cause })
}
