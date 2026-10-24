import { isIP } from 'node:net'
import { invalidRequest } from './errors.js'
import type { ProxyRecord, ProxyView } from './types.js'
import type { StoreDocument } from '../store/private-store.js'

export function proxyHost(value: string): string {
  const host = value.trim().replace(/^\[([^\]]+)\]$/, '$1')
  if (isIP(host)) return host
  if (
    host.length > 253 ||
    !host
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) {
    throw invalidRequest('代理主机应为 IP 或域名，不能包含协议、端口、路径或口令')
  }
  return host.toLowerCase()
}

export function validateProxy(proxy: ProxyRecord): ProxyRecord {
  if (!proxy.enabled) throw invalidRequest('所选代理不存在或已停用')
  const host = proxyHost(proxy.host)
  if (
    !Number.isInteger(proxy.port) ||
    proxy.port < 1 ||
    proxy.port > 65535 ||
    !['http', 'https', 'socks5', 'socks5h'].includes(proxy.scheme) ||
    typeof proxy.username !== 'string' ||
    typeof proxy.password !== 'string'
  ) {
    throw invalidRequest('代理配置无效')
  }
  if (
    (proxy.scheme === 'socks5' || proxy.scheme === 'socks5h') &&
    (Buffer.byteLength(proxy.username) > 255 ||
      Buffer.byteLength(proxy.password) > 255 ||
      (proxy.password !== '' && proxy.username === ''))
  ) {
    throw invalidRequest('SOCKS 认证需要用户名，用户名和密码不得超过 255 字节')
  }
  return { ...proxy, host }
}

/** null is the sole path that inherits the host's application-network route. */
export function selectProxy(
  document: StoreDocument,
  proxyId: string | null,
  allowDisabled = false,
): Readonly<ProxyRecord> | null {
  const selectedId = proxyId ?? document.defaultProxyId
  if (selectedId === null) return null
  const proxy = document.proxies.find((p) => p.id === selectedId)
  if (!proxy || (!allowDisabled && !proxy.enabled))
    throw invalidRequest('所选代理不存在或已停用')
  return Object.freeze({
    ...validateProxy({ ...proxy, enabled: true }),
    enabled: proxy.enabled,
  })
}

export function proxyView(proxy: ProxyRecord): ProxyView {
  return {
    id: proxy.id,
    name: proxy.name,
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    enabled: proxy.enabled,
    hasPassword: proxy.password !== '',
  }
}
