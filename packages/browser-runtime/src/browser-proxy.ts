import { buildLaunchOptions, type LaunchPersistentContextOptions } from 'cloakbrowser'
import { isIP } from 'node:net'
import { startSocksRelay } from './socks-relay.js'

function withMacLocale(
  options: LaunchPersistentContextOptions,
): LaunchPersistentContextOptions {
  const major = Number(options.browserVersion?.split('.')[0])
  if (process.platform !== 'darwin' || !major || major >= 148) return options
  const locale =
    options.locale ??
    options.args
      ?.find((arg) => arg.startsWith('--fingerprint-locale='))
      ?.slice('--fingerprint-locale='.length)
  if (!locale || options.args?.some((arg) => arg.startsWith('--accept-lang='))) {
    return options
  }
  // Chromium 145 on macOS keeps the system language with --lang alone.
  return { ...options, args: [...(options.args ?? []), `--accept-lang=${locale}`] }
}

export async function prepareBrowserProxy(
  input: LaunchPersistentContextOptions,
  signal: AbortSignal,
): Promise<LaunchPersistentContextOptions> {
  let options = input
  let geoipProxy = options.proxy
  if (typeof options.proxy === 'string' && /^socks5h?:/i.test(options.proxy)) {
    try {
      const proxy = new URL(options.proxy)
      if (proxy.username || proxy.password) {
        const relay = await startSocksRelay(options.proxy, signal)
        options = { ...options, proxy: relay.url }
        geoipProxy = relay.url.replace('socks5:', 'socks5h:')
      }
    } catch {
      throw new Error('PROFILE_PROXY_BRIDGE_FAILED')
    }
  }
  if (!options.proxy || !options.geoip) return withMacLocale(options)
  // Resolve through the SDK once, using the same authenticated route as Chromium.
  // Disabling defaults here leaves persistent fingerprint seed handling to launch.
  const prepared = await buildLaunchOptions({
    ...options,
    proxy: geoipProxy ?? options.proxy,
    stealthArgs: false,
  })
  signal.throwIfAborted()
  const args = prepared.args ?? []
  const exitIp = args
    .find((arg) => arg.startsWith('--fingerprint-webrtc-ip='))
    ?.slice('--fingerprint-webrtc-ip='.length)
  if (
    !exitIp ||
    !isIP(exitIp) ||
    /^127\./.test(exitIp) ||
    ['::1', '0.0.0.0', '::'].includes(exitIp)
  ) {
    throw new Error('PROFILE_GEOIP_EXIT_IP_REQUIRED')
  }
  return withMacLocale({
    ...options,
    geoip: false,
    args: args.filter(
      (arg) =>
        !arg.startsWith('--proxy-server=') && !arg.startsWith('--proxy-bypass-list='),
    ),
  })
}
