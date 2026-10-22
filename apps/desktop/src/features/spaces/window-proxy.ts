import { checkProxy, getConfig, probeProxy } from '@/features/proxy/api'
import { message, type CheckResult } from '@/features/proxy/types'

/** The three ways a window can reach the network. */
export interface WindowProxyRef {
  proxy: string | null
  proxyPlugin: string | null
  proxyEndpoint: number | null
}

export type ProxyCheckOutcome =
  | { kind: 'checked'; result: CheckResult }
  /** The proxy cannot be measured at all, e.g. the pool plugin is not running. */
  | { kind: 'unsupported'; reason: string }

export function hasProxy(ref: WindowProxyRef): boolean {
  return ref.proxy !== null || ref.proxyPlugin !== null
}

/**
 * Runs the pool plugin's own check for a window's proxy. A pinned endpoint is
 * checked directly; a legacy window that only names the plugin falls back to
 * the plugin's default endpoint; a typed address is probed without saving it.
 */
export async function checkWindowProxy(ref: WindowProxyRef): Promise<ProxyCheckOutcome> {
  try {
    if (ref.proxyEndpoint !== null) {
      return {
        kind: 'checked',
        result: await checkProxy(String(ref.proxyEndpoint), null, true),
      }
    }
    if (ref.proxyPlugin !== null) {
      const config = await getConfig()
      if (config.defaultEndpointId === null) {
        return {
          kind: 'unsupported',
          reason: '代理池插件还没有选择默认代理，无法检测',
        }
      }
      return {
        kind: 'checked',
        result: await checkProxy(config.defaultEndpointId, null, true),
      }
    }
    if (ref.proxy !== null) {
      return { kind: 'checked', result: await probeProxy(ref.proxy) }
    }
    return { kind: 'unsupported', reason: '这个窗口没有配置代理' }
  } catch (error) {
    // A missing or stopped plugin rejects the call; that is not a proxy failure.
    return { kind: 'unsupported', reason: message(error) }
  }
}
