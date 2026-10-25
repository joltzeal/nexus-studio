import type { NativeProfile } from '@/lib/platform/native-profiles'
import { PROXY_PLUGIN_ID } from './types'

export type ProxyUsageProfile = Pick<
  NativeProfile,
  'id' | 'name' | 'proxyPlugin' | 'proxyEndpoint'
>

interface ProxyUsageWindow {
  id: string
  name: string
  viaDefault: boolean
}

interface ProxyEndpointUsage {
  current: ProxyUsageWindow | null
  others: ProxyUsageWindow[]
}

export type ProxyUsageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; byEndpoint: ReadonlyMap<string, ProxyEndpointUsage> }

export function indexProxyUsage(
  profiles: readonly ProxyUsageProfile[],
  defaultEndpointId: string | null,
  currentWindowId: string | null = null,
): ReadonlyMap<string, ProxyEndpointUsage> {
  const usage = new Map<string, ProxyEndpointUsage>()
  for (const profile of profiles) {
    if (profile.proxyPlugin !== PROXY_PLUGIN_ID) continue
    const endpointId =
      profile.proxyEndpoint === null ? defaultEndpointId : String(profile.proxyEndpoint)
    if (endpointId === null) continue
    const entry = usage.get(endpointId) ?? { current: null, others: [] }
    const window: ProxyUsageWindow = {
      id: profile.id,
      name: profile.name,
      viaDefault: profile.proxyEndpoint === null,
    }
    if (profile.id === currentWindowId) entry.current = window
    else entry.others.push(window)
    usage.set(endpointId, entry)
  }
  return usage
}

export function proxyUsageLabel(state: ProxyUsageState, endpointId: string): string {
  if (state.status === 'loading') return '正在读取窗口占用…'
  if (state.status === 'error') return '窗口占用未知（读取失败）'
  const usage = state.byEndpoint.get(endpointId)
  if (usage === undefined) return '未被窗口使用'
  const current = usage.current
    ? `当前窗口使用${usage.current.viaDefault ? '（跟随默认）' : ''} · `
    : ''
  if (usage.others.length === 0) return `${current}无其他窗口使用`
  const names = usage.others
    .map((window) => `${window.name}${window.viaDefault ? '（跟随默认）' : ''}`)
    .join('、')
  return `${current}已被 ${usage.others.length} 个其他窗口使用：${names}`
}
