import type { BrowserWindow, CreateBrowserWindowInput } from '@nexus/contracts/browser'
import { PROXY_PLUGIN_ID } from './plugins/proxy-pool/model.ts'

const poolPrefix = '\u0000proxy-pool:'

export type ProfileProxyBinding = Pick<
  CreateBrowserWindowInput,
  'proxyMode' | 'proxyId' | 'proxy' | 'proxyPlugin' | 'proxyEndpoint'
>

export function poolProxyChoice(endpoint: string | number) {
  const id = Number(endpoint)
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== String(endpoint))
    throw new Error('代理池端点标识无效')
  return `${poolPrefix}${id}`
}

export function poolProxyEndpoint(choice: string | null | undefined): number | null {
  if (!choice?.startsWith(poolPrefix)) return null
  const endpoint = choice.slice(poolPrefix.length)
  poolProxyChoice(endpoint)
  return Number(endpoint)
}

export function profileProxyChoice(profile: BrowserWindow): string | null {
  if (profile.proxyMode === 'direct') return null
  if (
    profile.proxyMode === 'plugin' &&
    profile.proxyPlugin === PROXY_PLUGIN_ID &&
    profile.proxyEndpoint !== null
  )
    return poolProxyChoice(profile.proxyEndpoint)
  return profile.proxyId ?? profile.id
}

export function profileProxyBinding(
  choice: string | null,
  previous?: BrowserWindow | null,
): ProfileProxyBinding {
  if (previous && choice === profileProxyChoice(previous)) {
    return {
      proxyMode: previous.proxyMode,
      proxyId: previous.proxyId ?? null,
      proxy: previous.proxy,
      proxyPlugin: previous.proxyPlugin,
      proxyEndpoint: previous.proxyEndpoint,
    }
  }
  const endpoint = poolProxyEndpoint(choice)
  return {
    proxyMode: endpoint !== null ? 'plugin' : choice ? 'manual' : 'direct',
    proxyId: endpoint === null ? choice || null : null,
    proxy: null,
    proxyPlugin: endpoint !== null ? PROXY_PLUGIN_ID : null,
    proxyEndpoint: endpoint,
  }
}
