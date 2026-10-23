import { invoke, isTauri } from '@tauri-apps/api/core'

export type ProxyMode = 'direct' | 'system' | 'manual'

export interface NetworkProxy {
  mode: ProxyMode
  url: string | null
}

export function nativeNetworkProxyAvailable(): boolean {
  return isTauri()
}

export function getNetworkProxy(): Promise<NetworkProxy> {
  return invoke<NetworkProxy>('network_proxy_get')
}

export function setNetworkProxy(value: NetworkProxy): Promise<NetworkProxy> {
  return invoke<NetworkProxy>('network_proxy_set', { value })
}
