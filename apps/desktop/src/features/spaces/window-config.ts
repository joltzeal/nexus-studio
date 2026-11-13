import type { BrowserWindow } from '@/lib/platform/windows'
import { randomFingerprintSeed } from '@/lib/random-name'

export interface WindowConfig {
  proxy: { protocol: 'direct' | 'http' | 'https' | 'socks5'; server: string }
  geoip: boolean
  timezone: string
  locale: string
  viewport: 'default' | '1440x900' | '1920x1080'
  fingerprintSeed: number | null
  startUrl: string
}

export const DEFAULT_WINDOW_CONFIG: WindowConfig = {
  proxy: { protocol: 'direct', server: '' },
  geoip: false,
  timezone: '',
  locale: '',
  viewport: 'default',
  fingerprintSeed: null,
  startUrl: '',
}

// New windows retain the GeoIP preference even before a proxy is assigned.
export function createWindowConfig(fingerprintSeed: number): WindowConfig {
  return {
    ...DEFAULT_WINDOW_CONFIG,
    proxy: { protocol: 'direct', server: '' },
    geoip: true,
    fingerprintSeed,
  }
}

function invalid(reason: string): never {
  throw new Error(`窗口配置无效：${reason}。`)
}

function record(
  input: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    invalid(`${label}需要是对象`)
  const keys = Object.keys(input)
  const missing = fields.filter((field) => !keys.includes(field))
  const unknown = keys.filter((key) => !fields.includes(key))
  // Naming the offending fields matters: a bare "unknown or missing field" gives
  // the reader nothing to act on, and this check is what rejects a record whose
  // writer and reader disagree about the shape.
  if (missing.length > 0 && unknown.length > 0)
    invalid(
      `${label}包含未知字段（${unknown.join('、')}）且缺少必要字段（${missing.join('、')}）`,
    )
  if (missing.length > 0) invalid(`${label}缺少必要字段：${missing.join('、')}`)
  if (unknown.length > 0) invalid(`${label}包含未知字段：${unknown.join('、')}`)
  return input as Record<string, unknown>
}

function optionalText(input: unknown, label: string, maxLength: number): string {
  if (typeof input !== 'string' || input.length > maxLength) {
    invalid(`${label}需要是最多 ${maxLength} 个字符的文本`)
  }
  return input.trim()
}

export function parseWindowConfig(input: unknown): WindowConfig {
  const config = record(
    input,
    ['proxy', 'geoip', 'timezone', 'locale', 'viewport', 'fingerprintSeed', 'startUrl'],
    '窗口配置',
  )
  const proxy = record(config.proxy, ['protocol', 'server'], '代理配置')
  const protocol = proxy.protocol
  if (
    protocol !== 'direct' &&
    protocol !== 'http' &&
    protocol !== 'https' &&
    protocol !== 'socks5'
  )
    invalid('代理协议不受支持')
  const server = optionalText(proxy.server, '代理地址', 200)
  if (protocol === 'direct' && server) invalid('直连模式不能填写代理地址')
  if (protocol !== 'direct') {
    try {
      const url = new URL(server)
      const port = Number(server.match(/:(\d{1,5})(?:\/)?$/)?.[1])
      if (
        url.protocol !== `${protocol}:` ||
        !url.hostname ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        (url.pathname && url.pathname !== '/') ||
        url.search ||
        url.hash
      ) {
        invalid('代理地址应为协议://主机:端口，可包含认证信息，不能包含路径、查询或片段')
      }
    } catch {
      invalid('代理地址应为协议://主机:端口，可包含认证信息，不能包含路径、查询或片段')
    }
  }
  // Online IP matching depends on where the proxy comes from, which this
  // parser does not know: a window can sit behind a plugin-resolved proxy and
  // still store `direct` here. The consistency check lives with the caller.
  if (typeof config.geoip !== 'boolean') invalid('IP 自动匹配需要是开关值')
  const timezone = optionalText(config.timezone, '时区', 64)
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    } catch {
      invalid('时区需要使用有效的 IANA 标识')
    }
  }
  const locale = optionalText(config.locale, '语言', 35)
  if (locale) {
    try {
      if (!Intl.getCanonicalLocales(locale).length) invalid('语言标识无效')
    } catch {
      invalid('语言需要使用有效的 BCP 47 标识')
    }
  }
  const viewport = config.viewport
  if (viewport !== 'default' && viewport !== '1440x900' && viewport !== '1920x1080')
    invalid('窗口尺寸不受支持')
  const fingerprintSeed = config.fingerprintSeed
  if (
    fingerprintSeed !== null &&
    (typeof fingerprintSeed !== 'number' ||
      !Number.isSafeInteger(fingerprintSeed) ||
      fingerprintSeed < 1 ||
      fingerprintSeed > 2147483647)
  ) {
    invalid('指纹种子需要是 1 至 2147483647 的整数')
  }
  const startUrl = optionalText(config.startUrl, '起始地址', 2048)
  if (startUrl) {
    try {
      const url = new URL(startUrl)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        invalid('起始地址需要是无凭据的 HTTP 或 HTTPS 地址')
    } catch {
      invalid('起始地址需要是无凭据的 HTTP 或 HTTPS 地址')
    }
  }
  return {
    proxy: { protocol, server },
    geoip: config.geoip,
    timezone,
    locale,
    viewport,
    fingerprintSeed,
    startUrl,
  }
}

// Keep Raccoon metadata outside the strictly validated browser configuration.
export function configOf(profile: BrowserWindow | null): WindowConfig {
  if (profile === null) {
    return createWindowConfig(randomFingerprintSeed())
  }
  const { geoip, timezone, locale, viewport, fingerprintSeed, startUrl } =
    profile.settings
  const proxy = profile.proxy
  return {
    // A plugin-resolved proxy leaves `proxy` empty; the source select carries
    // that state, and `direct` here only means "no literal server string".
    proxy: proxy
      ? {
          protocol: proxy.startsWith('socks5://')
            ? 'socks5'
            : proxy.startsWith('https://')
              ? 'https'
              : 'http',
          server: proxy,
        }
      : { protocol: 'direct', server: '' },
    geoip,
    timezone,
    locale,
    viewport,
    fingerprintSeed,
    startUrl,
  }
}
