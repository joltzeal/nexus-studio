import addressManifest from '@nexus/plugin-address-generator/manifest'
import proxyManifest from '@nexus/plugin-proxy-pool/manifest'

/**
 * Plugins whose package is built from this repository.
 *
 * Only the manifest declaration is read here: no entry point, process,
 * capability method or credential is loaded. The manifest is a description,
 * not proof that the host can run the plugin.
 */
export interface BundledPlugin {
  readonly manifest: typeof proxyManifest
  readonly summary: string
  readonly status: string
}

export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    manifest: proxyManifest,
    summary: '代理库存、连通性检测、IP 风险与 Clash 订阅。',
    status: '插件包已构建，宿主未接入',
  },
  {
    manifest: addressManifest,
    summary: '公开地址生成、地图选点与随机收货资料。',
    status: '插件包已构建，宿主未接入',
  },
]
