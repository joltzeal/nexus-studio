export const PROXY_POOL_PAGE_METHODS = [
  'proxy.list',
  'proxy.groups.list',
  'proxy.groups.create',
  'proxy.config.get',
  'proxy.config.set',
  'proxy.create',
  'proxy.update',
  'proxy.delete',
  'proxy.check',
  'proxy.import',
  'proxy.exportUrls',
  'proxy.subscriptions.list',
  'proxy.subscriptions.create',
  'proxy.subscriptions.delete',
  'proxy.subscriptions.preview',
  'proxy.subscriptions.export',
  'proxy.subscriptions.append',
] as const

export function supportsProxyPoolPage(methods: readonly string[]): boolean {
  const available = new Set(methods)
  return PROXY_POOL_PAGE_METHODS.every((method) => available.has(method))
}
