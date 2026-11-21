import type {
  BrowserCapabilities,
  BrowserProxyEntry,
  BrowserWindow,
  CreateBrowserWindowInput,
} from '@nexus/contracts/browser'
import { poolProxyEndpoint, profileProxyBinding } from '../profile-proxy.ts'

type ProxySnapshot = Pick<
  CreateBrowserWindowInput,
  'proxyMode' | 'proxy' | 'proxyId' | 'proxyPlugin' | 'proxyEndpoint'
>
type ProxySource = Pick<
  BrowserWindow,
  'proxyMode' | 'proxy' | 'proxyPlugin' | 'proxyEndpoint'
> &
  Pick<BrowserWindow, 'proxyId'>

export function templateProxyChoice(source: Pick<BrowserWindow, 'proxyMode'>): string {
  return source.proxyMode === 'direct' ? '' : '__template'
}

export function batchProxySnapshot(
  choice: string,
  source: ProxySource | null | undefined,
  proxies: readonly BrowserProxyEntry[],
  capabilities: Pick<BrowserCapabilities, 'manualProxy' | 'proxyPlugin'>,
): ProxySnapshot {
  if (choice === '__template') {
    if (!source || source.proxyMode === 'provider')
      throw new Error('厂商管理的模板代理无法直接复制，请明确选择代理或直连')
    if (
      source.proxyMode === 'manual' &&
      (!capabilities.manualProxy || (!source.proxyId && !source.proxy))
    )
      throw new Error('原 Profile 的手动代理无法用于本批创建')
    if (
      source.proxyMode === 'plugin' &&
      (!capabilities.proxyPlugin || !source.proxyPlugin || !source.proxyEndpoint)
    )
      throw new Error('原 Profile 的插件代理未固定具体端点，无法用于本批创建')
    return {
      proxyMode: source.proxyMode,
      proxy: source.proxy,
      proxyId: source.proxyId ?? null,
      proxyPlugin: source.proxyPlugin,
      proxyEndpoint: source.proxyEndpoint,
    }
  }
  if (!choice) return profileProxyBinding(null)
  if (poolProxyEndpoint(choice) !== null) {
    if (!capabilities.proxyPlugin) throw new Error('此浏览器接入不支持代理池')
    return profileProxyBinding(choice)
  }
  if (!proxies.some((item) => item.id === choice) || !capabilities.manualProxy)
    throw new Error('所选代理不存在或此 Provider 不支持手动代理')
  return profileProxyBinding(choice)
}
