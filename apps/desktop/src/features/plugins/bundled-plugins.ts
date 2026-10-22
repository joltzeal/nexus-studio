import addressManifest from '@nexus/plugin-address-generator/manifest'
import aiImageManifest from '@nexus/plugin-ai-image/manifest'
import proxyManifest from '@nexus/plugin-proxy-pool/manifest'
import supplyManifest from '@nexus/plugin-shared-supply/manifest'
import vintedMonitorManifest from '@nexus/plugin-vinted-monitor/manifest'

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
  {
    manifest: supplyManifest,
    summary: '分类商户与商品浏览、关键词搜索、以图搜图与本地收藏。',
    status: '插件包已构建，宿主未接入',
  },
  {
    manifest: aiImageManifest,
    summary: 'OpenAI 与兼容接口生图改图、参考图文案、场景预设与生成记录。',
    status: '插件包已构建，宿主未接入',
  },
  {
    manifest: vintedMonitorManifest,
    summary: 'Vinted 搜索页与会员衣柜定时采集、采集记录与商品归档。',
    status: '插件包已构建，宿主未接入',
  },
]
