import { use, useState, type ReactNode } from 'react'
import { Button, EmptyState, SegmentControl, Alert } from '@proxyshard/shardx-ui-kit'
import { PageHeader } from '../../../widgets/PageHeader'
import { PluginWorkspace } from '../PluginWorkspace'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import type { PluginView } from '../../../raccoon/plugins/types'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { useDetailNavigation } from '../../../raccoon/plugins/detail-navigation'
import { NavSettingsIcon } from '../../../shared/icons'
import { agentUnavailable, getAgentSettings } from './api'
import { emptyAgentDraft } from './assignment'
import { BatchComposer } from './batch-composer'
import { BatchRuns } from './batch-runs'
import { AgentSettingsDialog } from './settings-dialog'
import { RetentionDialog } from './retention-dialog'
import { ReviewWorkbench, type RelatedAgentHistory } from './review-workbench'
import { useAgentQuery } from './use-query'
import type { EventStream } from './state'
import { AgentConnection } from './scope'

export function SalesAgentPage({
  connectionId,
  onManage,
}: {
  connectionId: string | null
  onManage: () => void
}) {
  const plugins = usePluginCatalog((state) => state.plugins)
  const plugin = plugins.find((item) => item.id === 'studio.sales-agent') ?? null
  const unavailable = !isNativeRaccoon()
    ? 'Ecom Agent 需要桌面应用，网页不能执行。'
    : agentUnavailable(plugin)
  if (unavailable)
    return (
      <>
        <PageHeader title="Ecom Agent" />
        <PluginWorkspace>
          <EmptyState
            title="Ecom Agent 暂不可用"
            hint={unavailable}
            action={{ label: '管理插件', onClick: onManage }}
          />
        </PluginWorkspace>
      </>
    )
  return (
    <AgentConnection value={connectionId}>
      <SalesAgentWorkspace
        key={`${connectionId}:${plugin?.installation}:${plugin?.runtimeGeneration}`}
        plugins={plugins}
      />
    </AgentConnection>
  )
}

function dependency(
  plugins: PluginView[],
  id: string,
  capability: string,
  methods: string[],
) {
  const plugin = plugins.find((item) => item.id === id)
  const name = id === 'studio.products' ? '商品管理' : 'Vinted 账号池'
  if (!plugin || plugin.state === 'available') return `${name}插件尚未安装。`
  if (!plugin.enabled || plugin.state !== 'running') return `${name}插件尚未运行。`
  if (!plugin.capabilities.includes(capability) || !plugin.granted.includes(capability))
    return `${name}插件缺少 ${capability} 授权。`
  if (!plugin.storageDurable) return `${name}插件未启用持久存储。`
  if (!methods.every((method) => plugin.methods.includes(method)))
    return `${name}插件需要更新。`
  return null
}

function SalesAgentWorkspace({ plugins }: { plugins: PluginView[] }) {
  const [tab, setTab] = useState('prepare')
  const [draft, setDraft] = useState(emptyAgentDraft)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [retentionOpen, setRetentionOpen] = useState(false)
  const [related, setRelated] = useState<RelatedAgentHistory | null>(null)
  const [revision, setRevision] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [eventCache] = useState(() => new Map<string, EventStream>())
  const catalogError = usePluginCatalog((state) => state.error)
  const settings = useAgentQuery(`settings-state-${revision}`, async () => ({
    configured: (await getAgentSettings()) !== null,
  }))
  useDetailNavigation('agent', (request) => {
    if (request.related) {
      setRelated({ kind: request.related, id: request.id })
      setTab('attention')
    } else {
      setSelectedId(request.batchId ?? request.id)
      setTab('runs')
    }
  })
  const accountsUnavailable =
    catalogError ??
    dependency(plugins, 'studio.vinted-accounts', 'account.pool', [
      'vinted.accounts.bindings',
      'vinted.accounts.agent.snapshot',
      'vinted.accounts.observations.record',
    ])
  const productsUnavailable =
    catalogError ??
    dependency(plugins, 'studio.products', 'product.catalog', [
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
    <>
      <PageHeader
        title="Ecom Agent"
        actions={
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            leftIcon={<NavSettingsIcon className="size-3.5" />}
            onClick={() => setSettingsOpen(true)}
          >
            模型与执行设置
          </Button>
        }
      />
      <PluginWorkspace scroll>
        <SegmentControl
          value={tab}
          onChange={setTab}
          semantics="tabs"
          size="xsmall"
          fit
          className="self-start"
          items={[
            { value: 'prepare', label: '创建任务' },
            { value: 'runs', label: '运行记录' },
            { value: 'attention', label: '待处理与审查' },
          ]}
        />
        <PreparePanel hidden={tab !== 'prepare'}>
          {(connectionId) => (
            <BatchComposer
              draft={draft}
              setDraft={setDraft}
              key={connectionId}
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
          )}
        </PreparePanel>
        {tab === 'runs' && (
          <section
            role="tabpanel"
            aria-label="运行记录"
            className="flex min-w-0 flex-col gap-3"
          >
            <div className="flex justify-end">
              <Button
                size="xsmall"
                variant="neutral"
                mode="stroke"
                onClick={() => setRetentionOpen(true)}
              >
                清理已结束任务
              </Button>
            </div>
            <BatchRuns
              selectedId={selectedId}
              onSelect={setSelectedId}
              revision={revision}
              eventCache={eventCache}
            />
            {accountsUnavailable && (
              <Alert status="warning">
                {accountsUnavailable} 已保存的批次仍可查询；执行前由宿主核对依赖。
              </Alert>
            )}
          </section>
        )}
        {tab === 'attention' && (
          <section role="tabpanel" aria-label="待处理与审查">
            <ReviewWorkbench
              key={related ? `${related.kind}-${related.id}` : 'all'}
              related={related}
              onClearRelated={() => setRelated(null)}
              onOpenBatch={(id) => {
                setSelectedId(id)
                setTab('runs')
              }}
            />
          </section>
        )}
        <p className="mt-auto border-t border-stroke-soft-200 pt-3 text-help text-text-sub-600">
          任务在 Raccoon 运行期间执行；退出后保留进度，重新打开可核对并继续。
        </p>
      </PluginWorkspace>
      {settingsOpen && (
        <AgentSettingsDialog
          onClose={() => setSettingsOpen(false)}
          onSaved={() => setRevision((value) => value + 1)}
        />
      )}
      {retentionOpen && (
        <RetentionDialog
          onClose={() => setRetentionOpen(false)}
          onCleaned={() => {
            setSelectedId(null)
            setRevision((value) => value + 1)
          }}
        />
      )}
    </>
  )
}

function PreparePanel({
  hidden,
  children,
}: {
  hidden: boolean
  children: (connectionId: string) => ReactNode
}) {
  const connectionId = use(AgentConnection)
  return (
    <section
      role="tabpanel"
      aria-label="创建任务"
      hidden={hidden}
      className={hidden ? 'hidden!' : 'min-w-0'}
    >
      {connectionId ? (
        children(connectionId)
      ) : (
        <EmptyState
          title="请先选择已配置的 Workspace"
          hint="商品与 Profile 分配按当前 connectionId 隔离；运行记录仍可查询。"
        />
      )}
    </section>
  )
}
