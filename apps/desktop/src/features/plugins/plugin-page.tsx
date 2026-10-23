import type { ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ProxyPoolPage } from '@/features/proxy/proxy-pool-page'
import { AddressPage } from '@/features/addresses/address-page'
import { SupplyPage } from '@/features/supply/supply-page'
import { AiImagePage } from '@/features/ai-image/ai-image-page'
import { AccountsPage } from '@/features/accounts/accounts-page'
import { Sim8Page } from '@/features/sim8/sim8-page'
import { VintedMonitorPage } from '@/features/vinted-monitor/vinted-monitor-page'
import type { AiImageHandoff } from '@/lib/page-handoff'
import type { PluginView } from '@/lib/platform/native-plugins'

interface PageProps {
  plugin: PluginView
  hostAvailable: boolean
  aiImageReady: boolean
  handoff: AiImageHandoff | null
  onHandoffConsumed: () => void
}

// These are bundled UI adapters, not the list of installed navigation entries.
const pages: Record<string, ComponentType<PageProps> | undefined> = {
  'studio.proxy-pool': ProxyPoolPage,
  'studio.address-generator': AddressPage,
  'studio.shared-supply': SupplyPage,
  'studio.ai-image': AiImagePage,
  'studio.vinted-accounts': AccountsPage,
  'studio.sim8': Sim8Page,
  'studio.vinted-monitor': VintedMonitorPage,
}

const states = {
  available: '未安装',
  starting: '启动中',
  running: '运行中',
  retrying: '重试中',
}

export function PluginPage({
  onManage,
  onWindows,
  ...props
}: PageProps & { onManage: () => void; onWindows: () => void }) {
  const Page = Object.prototype.hasOwnProperty.call(pages, props.plugin.id)
    ? pages[props.plugin.id]
    : undefined
  if (Page) return <Page {...props} />
  const { plugin } = props
  return (
    <section className="collection-page page-reveal" aria-labelledby="plugin-heading">
      <div className="section-intro">
        <h1 className="page-heading" id="plugin-heading">
          {plugin.name}
        </h1>
        <div className="section-actions">
          {plugin.capabilities.includes('window.sync') ? (
            <Button variant="outline" onClick={onWindows}>
              前往窗口管理
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onManage}>
            管理插件
          </Button>
        </div>
      </div>
      <dl className="about-details">
        <div className="about-row">
          <dt>状态</dt>
          <dd>
            <Badge variant="secondary">{states[plugin.state]}</Badge>
          </dd>
        </div>
        <div className="about-row">
          <dt>插件标识</dt>
          <dd>{plugin.id}</dd>
        </div>
        <div className="about-row">
          <dt>版本</dt>
          <dd>{plugin.version}</dd>
        </div>
        <div className="about-row">
          <dt>能力</dt>
          <dd>{plugin.capabilities.join(' · ') || '—'}</dd>
        </div>
        <div className="about-row">
          <dt>可用方法</dt>
          <dd>{plugin.methods.length} 个</dd>
        </div>
      </dl>
      {plugin.lastError ? <p role="alert">{plugin.lastError}</p> : null}
    </section>
  )
}
