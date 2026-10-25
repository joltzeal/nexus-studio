import type { LaunchPersistentContextOptions } from 'cloakbrowser'
import { startSocksRelay } from './socks-relay.js'
import { resolveOnlineProxyGeo } from './online-proxy-geo.js'

export async function prepareBrowserProxy(
  input: LaunchPersistentContextOptions,
  signal: AbortSignal,
): Promise<LaunchPersistentContextOptions> {
  let options = input
  if (typeof options.proxy === 'string' && /^socks5h?:/i.test(options.proxy)) {
    try {
      const proxy = new URL(options.proxy)
      if (proxy.username || proxy.password) {
        const relay = await startSocksRelay(options.proxy, signal)
        options = { ...options, proxy: relay.url }
      }
    } catch {
      throw new Error('PROFILE_PROXY_BRIDGE_FAILED')
    }
  }
  if (!options.proxy || !options.geoip) {
    return { ...options, geoip: false }
  }
  let proxy = options.proxy
  if (typeof proxy !== 'string') {
    const url = new URL(proxy.server)
    if (proxy.username) url.username = proxy.username
    if (proxy.password) url.password = proxy.password
    proxy = url.toString()
  }
  const geo = await resolveOnlineProxyGeo(proxy, signal, {
    requireTimezone: !options.timezone,
    requireLocale: !options.locale,
  })
  signal.throwIfAborted()
  const timezone = options.timezone || geo.timezone
  const locale = options.locale || geo.locale
  return {
    ...options,
    geoip: false,
    ...(timezone ? { timezone } : {}),
    ...(locale ? { locale } : {}),
    args: [
      ...(options.args ?? []).filter(
        (arg) => !arg.startsWith('--fingerprint-webrtc-ip='),
      ),
      `--fingerprint-webrtc-ip=${geo.ip}`,
    ],
  }
}
