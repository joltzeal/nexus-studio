import { DEFAULT_WINDOW_CONFIG, type WindowConfig } from '@/demo/model'
import type { NativeProfile } from '@/lib/platform/native-profiles'

/**
 * Projects a stored profile onto the seven fields `parseWindowConfig` accepts.
 *
 * Spreading `profile.settings` directly would also carry `platform` and `note`,
 * which live beside the config rather than inside it. The strict field check
 * then rejects the very window the editor just loaded, which is how editing an
 * existing window ended up reporting "窗口配置包含未知字段".
 */
export function configOf(profile: NativeProfile | null): WindowConfig {
  if (profile === null) {
    // A fresh object: the editor mutates its own copy, never the module default.
    return { ...DEFAULT_WINDOW_CONFIG, proxy: { protocol: 'direct', server: '' } }
  }
  const { geoip, timezone, locale, viewport, fingerprintSeed, startUrl } =
    profile.settings
  const proxy = profile.proxy
  return {
    // A plugin-resolved proxy leaves `proxy` empty; the source select carries
    // that state, and `direct` here only means "no literal server string".
    proxy: proxy
      ? {
          protocol: proxy.startsWith('socks5://') ? 'socks5' : 'http',
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
