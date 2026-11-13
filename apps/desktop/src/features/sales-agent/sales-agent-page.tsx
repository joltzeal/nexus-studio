import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PluginGate } from '@/features/plugins/plugin-gate'
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import type { PluginView } from '@/lib/platform/native-plugins'
import { useDetailNavigation } from '@/lib/detail-navigation'
import { agentUnavailable, getAgentSettings } from './api'
import { emptyAgentDraft } from './assignment'
import { BatchComposer } from './batch-composer'
import { BatchRuns } from './batch-runs'
import { AgentSettingsDialog } from './settings-dialog'
import type { EventStream } from './state'
import { useAgentQuery } from './use-query'
import { ReviewWorkbench, type RelatedAgentHistory } from './review-workbench'
import { RetentionDialog } from './retention-dialog'

export interface SalesAgentPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
}

export function SalesAgentPage({ plugin, hostAvailable }: SalesAgentPageProps) {
  if (!hostAvailable || !plugin || plugin.state !== 'running') {
    return (
      <PluginGate
        label="ecom agent"
        hostAvailable={hostAvailable}
        plugin={plugin?.state === 'available' ? null : plugin}
      />
    )
  }
  const unavailable = agentUnavailable(plugin)
  if (unavailable) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>ecom agent 暂不可用</EmptyTitle>
          <EmptyDescription>{unavailable}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const identity = JSON.stringify([
    plugin.id,
    plugin.version,
    plugin.source,
    plugin.sourceDirectory,
    plugin.status?.pid,
    plugin.status?.processId,
    plugin.status?.startedAt,
    [...plugin.methods].sort(),
  ])
  return <SalesAgentWorkspace key={identity} />
}

function dependency(
  plugins: PluginView[],
  id: string,
  capability: string,
  methods: string[],
): string | null {
  const plugin = plugins.find((candidate) => candidate.id === id)
  const label = id === 'studio.products' ? '商品' : 'Vinted 账号池'
  if (!plugin || plugin.state === 'available')
    return `${label}插件尚未安装，请在插件中心安装。`
  if (!plugin.enabled || plugin.state !== 'running') return `${label}插件尚未运行。`
  if (!plugin.capabilities.includes(capability) || !plugin.granted.includes(capability))
    return `${label}插件缺少 ${capability} 授权。`
  if (!plugin.storageDurable) return `${label}插件未启用持久存储。`
  if (!methods.every((method) => plugin.methods.includes(method)))
    return `${label}插件需要更新。`
  return null
}

export function SalesAgentWorkspace() {
  const [tab, setTab] = useState('prepare')
  const [draft, setDraft] = useState(emptyAgentDraft)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [retentionOpen, setRetentionOpen] = useState(false)
  const [related, setRelated] = useState<RelatedAgentHistory | null>(null)
  const [revision, setRevision] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [eventCache] = useState(() => new Map<string, EventStream>())
  useDetailNavigation('agent', (request) => {
    if (request.related) {
      setRelated({ kind: request.related, id: request.id })
      setTab('attention')
    } else {
      setSelectedId(request.batchId ?? request.id)
      setTab('runs')
    }
  })
  const [catalog, setCatalog] = useState<{
    plugins: PluginView[] | null
    error: string | null
  }>({ plugins: null, error: null })
  const settings = useAgentQuery(`settings-state-${revision}`, async () => ({
    configured: (await getAgentSettings()) !== null,
  }))
  useEffect(
    () =>
      watchPluginCatalog(
        (plugins) => setCatalog({ plugins, error: null }),
        () =>
          setCatalog({
            plugins: null,
            error: '插件目录读取失败，请在插件中心检查并刷新。',
          }),
      ),
    [],
  )
  const catalogError = catalog.error ?? (catalog.plugins ? null : '正在读取插件目录…')
  const accountsUnavailable =
    catalogError ??
    dependency(catalog.plugins ?? [], 'studio.vinted-accounts', 'account.pool', [
      'vinted.accounts.bindings',
      'vinted.accounts.agent.snapshot',
      'vinted.accounts.observations.record',
    ])
  const productsUnavailable =
    catalogError ??
    dependency(catalog.plugins ?? [], 'studio.products', 'product.catalog', [
      'products.list',
      'products.get',
      'products.images.read',
      'products.publications.record',
    ])
  const settingsUnavailable = settings.error
    ? '模型配置读取失败，请打开模型设置重试。'
    : settings.loading
      ? '正在读取模型配置…'
      : settings.data?.configured
        ? null
        : '请先在模型设置保存判断模型和生成 / 识图模型。'

  return (
    <section
      className="sales-agent-page collection-page page-reveal"
      aria-labelledby="sales-agent-heading"
    >
      <Card className="sales-agent-card">
        <CardHeader className="sales-agent-page-header">
          <div>
            <CardTitle>
              <h1 id="sales-agent-heading">ecom agent</h1>
            </CardTitle>
            <CardDescription>
              固定商品与账号归属，查看真实任务进度与待处理结果。
            </CardDescription>
          </div>
          <Button variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings2 data-icon="inline-start" />
            模型设置
          </Button>
        </CardHeader>
        <CardContent className="sales-agent-content">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="prepare">创建任务</TabsTrigger>
              <TabsTrigger value="runs">运行记录</TabsTrigger>
              <TabsTrigger value="attention">待处理与审查</TabsTrigger>
            </TabsList>
            {/* Keep a pending submission mounted while its user inspects durable runs. */}
            <TabsContent value="prepare" forceMount hidden={tab !== 'prepare'}>
              <BatchComposer
                draft={draft}
                setDraft={setDraft}
                accountsUnavailable={accountsUnavailable}
                productsUnavailable={productsUnavailable}
                settingsUnavailable={settingsUnavailable}
                onRuns={() => setTab('runs')}
                onSettings={() => setSettingsOpen(true)}
                onCreated={(batch) => {
                  setSelectedId(batch.id)
                  setRevision((value) => value + 1)
                  setDraft(emptyAgentDraft())
                  setTab('runs')
                }}
              />
            </TabsContent>
            <TabsContent value="runs">
              <div className="sales-agent-toolbar">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRetentionOpen(true)}
                >
                  清理已结束任务
                </Button>
              </div>
              {tab === 'runs' ? (
                <BatchRuns
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  revision={revision}
                  eventCache={eventCache}
                />
              ) : null}
              {accountsUnavailable ? (
                <Alert>
                  <AlertDescription>
                    {accountsUnavailable} 已保存的批次仍可查询；执行前由宿主核对依赖。
                  </AlertDescription>
                </Alert>
              ) : null}
            </TabsContent>
            <TabsContent value="attention">
              {tab === 'attention' ? (
                <ReviewWorkbench
                  key={related ? `${related.kind}-${related.id}` : 'all'}
                  related={related}
                  onClearRelated={() => setRelated(null)}
                  onOpenBatch={(id) => {
                    setSelectedId(id)
                    setTab('runs')
                  }}
                />
              ) : null}
            </TabsContent>
          </Tabs>
        </CardContent>
        <CardFooter className="sales-agent-footer">
          任务在 Nexus 运行期间执行；退出后保留进度，重新打开可核对并继续。
        </CardFooter>
      </Card>
      {settingsOpen ? (
        <AgentSettingsDialog
          onClose={() => setSettingsOpen(false)}
          onSaved={() => setRevision((value) => value + 1)}
        />
      ) : null}
      {retentionOpen ? (
        <RetentionDialog
          onClose={() => setRetentionOpen(false)}
          onCleaned={() => {
            setSelectedId(null)
            setRevision((value) => value + 1)
          }}
        />
      ) : null}
    </section>
  )
}
