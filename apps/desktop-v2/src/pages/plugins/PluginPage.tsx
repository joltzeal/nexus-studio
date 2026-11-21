import { Activity, lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react'
import { Button, EmptyState } from '@proxyshard/shardx-ui-kit'
import { PageHeader } from '../../widgets/PageHeader'
import { PluginWorkspace } from './PluginWorkspace'
import { usePluginCatalog } from '../../raccoon/plugins/catalog'
import {
  PluginPageLifetime,
  PluginPageLifetimeContext,
} from '../../raccoon/plugins/page-lifetime'

const ProxyPoolPage = lazy(() =>
  import('./proxy-pool').then((module) => ({ default: module.ProxyPoolPage })),
)
const Sim8Page = lazy(() =>
  import('./sim8').then((module) => ({ default: module.Sim8Page })),
)
const AccountsPage = lazy(() =>
  import('./vinted-accounts').then((module) => ({ default: module.VintedAccountsPage })),
)
const EmailPage = lazy(() =>
  import('./email').then((module) => ({ default: module.EmailPage })),
)
const AddressPage = lazy(() =>
  import('./address-generator').then((module) => ({
    default: module.AddressGeneratorPage,
  })),
)
const AiImagePage = lazy(() =>
  import('./ai-image').then((module) => ({ default: module.AiImagePage })),
)
const ProductsPage = lazy(() =>
  import('./products').then((module) => ({ default: module.ProductsPage })),
)
const SharedSupplyPage = lazy(() =>
  import('./shared-supply').then((module) => ({ default: module.SharedSupplyPage })),
)
const VintedMonitorPage = lazy(() =>
  import('./vinted-monitor').then((module) => ({ default: module.VintedMonitorPage })),
)
const SalesAgentPage = lazy(() =>
  import('./sales-agent').then((module) => ({ default: module.SalesAgentPage })),
)

export function RetainedAgentPage(props: {
  active: boolean
  connectionId: string | null
  onManage: () => void
}) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.sales-agent'),
  )
  if (!plugin?.enabled || plugin.state === 'available') return null
  return (
    <RetainedAgentWorkspace
      key={`${props.connectionId}:${plugin.installation}:${plugin.runtimeGeneration}`}
      {...props}
    />
  )
}

function RetainedAgentWorkspace({
  active,
  connectionId,
  onManage,
}: {
  active: boolean
  connectionId: string | null
  onManage: () => void
}) {
  const [visited, setVisited] = useState(active)
  const [lifetime] = useState(() => new PluginPageLifetime(active))
  useLayoutEffect(() => {
    lifetime.visible = active
  }, [active, lifetime])
  useEffect(() => {
    if (active) setVisited(true)
  }, [active])
  useEffect(() => () => lifetime.dispose(), [lifetime])
  return (
    <PluginPageLifetimeContext value={lifetime}>
      <Activity mode={active ? 'visible' : 'hidden'}>
        {(active || visited) && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Suspense fallback={<PageHeader title="正在加载 Ecom Agent" />}>
              <SalesAgentPage connectionId={connectionId} onManage={onManage} />
            </Suspense>
          </div>
        )}
      </Activity>
    </PluginPageLifetimeContext>
  )
}

export function PluginPage({
  id,
  connectionId = null,
  onManage,
}: {
  id: string
  connectionId?: string | null
  onManage: () => void
}) {
  const plugin = usePluginCatalog((state) => state.plugins.find((item) => item.id === id))
  const relationGate = usePluginCatalog((state) =>
    state.plugins
      .filter(
        (item) => item.id === 'studio.email' || item.id === 'studio.vinted-accounts',
      )
      .map(
        (item) =>
          `${item.id}:${item.version}:${item.enabled}:${item.state}:${item.capabilities.join(',')}:${item.granted.join(',')}:${item.methods.join(',')}`,
      )
      .join('|'),
  )
  const pending = (
    <>
      <PageHeader title={plugin?.name ?? '插件'} />
      <PluginWorkspace>
        <p>正在加载插件页面</p>
      </PluginWorkspace>
    </>
  )
  if (id === 'studio.proxy-pool')
    return (
      <Suspense fallback={pending}>
        <ProxyPoolPage onManage={onManage} />
      </Suspense>
    )
  if (id === 'studio.sim8')
    return (
      <Suspense fallback={pending}>
        <Sim8Page onManage={onManage} />
      </Suspense>
    )
  if (id === 'studio.vinted-accounts')
    return (
      <Suspense fallback={pending}>
        <AccountsPage
          key={`${connectionId}:${relationGate}`}
          connectionId={connectionId}
          onManage={onManage}
        />
      </Suspense>
    )
  if (id === 'studio.email')
    return (
      <Suspense fallback={pending}>
        <EmailPage key={relationGate} onManage={onManage} />
      </Suspense>
    )
  if (id === 'studio.address-generator')
    return (
      <Suspense fallback={pending}>
        <AddressPage
          key={`${plugin?.version}:${plugin?.enabled}:${plugin?.state}:${plugin?.runtimeGeneration ?? ''}:${relationGate}`}
          onManage={onManage}
        />
      </Suspense>
    )
  if (id === 'studio.ai-image')
    return (
      <Suspense fallback={pending}>
        <AiImagePage
          key={`${plugin?.version}:${plugin?.enabled}:${plugin?.state}:${plugin?.runtimeGeneration ?? ''}`}
          onManage={onManage}
        />
      </Suspense>
    )
  if (id === 'studio.products')
    return (
      <Suspense fallback={pending}>
        <ProductsPage
          key={`${plugin?.version}:${plugin?.installation}:${plugin?.runtimeGeneration ?? ''}`}
          onManage={onManage}
        />
      </Suspense>
    )
  if (id === 'studio.shared-supply')
    return (
      <Suspense fallback={pending}>
        <SharedSupplyPage
          key={`${plugin?.version}:${plugin?.installation}:${plugin?.runtimeGeneration ?? ''}`}
          onManage={onManage}
        />
      </Suspense>
    )
  if (id === 'studio.vinted-monitor')
    return (
      <Suspense fallback={pending}>
        <VintedMonitorPage
          key={`${plugin?.version}:${plugin?.installation}:${plugin?.runtimeGeneration ?? ''}`}
          onManage={onManage}
        />
      </Suspense>
    )
  if (id === 'studio.sales-agent')
    return (
      <Suspense fallback={pending}>
        <SalesAgentPage
          key={connectionId}
          connectionId={connectionId}
          onManage={onManage}
        />
      </Suspense>
    )
  return (
    <>
      <PageHeader
        title={plugin?.name ?? '插件'}
        actions={
          <Button size="xsmall" mode="stroke" variant="neutral" onClick={onManage}>
            管理插件
          </Button>
        }
      />
      <PluginWorkspace>
        <EmptyState
          title="此插件的业务页面尚未接入"
          hint={
            plugin
              ? `${plugin.version} · ${plugin.capabilities.join(' · ')}`
              : '请重新读取插件目录'
          }
        />
      </PluginWorkspace>
    </>
  )
}
