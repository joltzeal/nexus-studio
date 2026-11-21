import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  AlertModal,
  Button,
  DataList,
  EmptyState,
  Input,
  Modal,
  SegmentControl,
  Select,
  Textarea,
  type DataListColumn,
} from '@proxyshard/shardx-ui-kit'
import { PageHeader } from '../../../widgets/PageHeader'
import { PluginFilterRow, PluginSearch } from '../PluginFilterRow'
import { PluginWorkspace } from '../PluginWorkspace'
import { ListColumn } from '../../../shared/ui/ListColumn'
import { AddIcon, AssignAccountIcon, CopyIcon, DeleteIcon, ExtendTimeIcon, EyeIcon, MessageIcon, RefreshIcon, ReplaceLinkIcon } from '../../../shared/icons'
import { PluginRowAction } from '../PluginRowAction'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { sim8Api } from '../../../raccoon/plugins/sim8/api'
import {
  createNativeSim8AccountBridge,
  type Sim8AccountTarget,
} from '../../../raccoon/plugins/sim8/accounts'
import { SIM8_PLUGIN_ID } from '../../../raccoon/plugins/sim8/methods'
import {
  sim8OptionalGroup,
  supportsSim8Page,
} from '../../../raccoon/plugins/sim8/page-contract'
import {
  APP_TYPES,
  EXPIRY_OPTIONS,
  allocationLabel,
  appTypeLabel,
  filterStatusLabel,
  formatMoney,
  recordExpired,
  shortTime,
  type AllocationState,
  type AppItem,
  type CategoryItem,
  type ExpiryReminder,
  type FilterAppItem,
  type FilterDetail,
  type OrderItem,
  type PrefixReport,
  type RecordList,
  type Sim8Config,
  type SmsRead,
  type SmsRecord,
} from '../../../raccoon/plugins/sim8/types'

type Tab = 'records' | 'buy' | 'orders' | 'filter' | 'expiry' | 'settings'
const TAB_ITEMS: { value: Tab; label: string }[] = [
  { value: 'records', label: '号码池' },
  { value: 'buy', label: '买号' },
  { value: 'orders', label: '订单' },
  { value: 'filter', label: '筛选检测' },
  { value: 'expiry', label: '到期提醒' },
  { value: 'settings', label: '设置' },
]
const PAGE_SIZE = 20
const ACCOUNT_CAPABILITY = 'account.pool'
const ACCOUNT_METHODS = ['vinted.accounts.list', 'vinted.accounts.save']

function accountCapability(
  plugin:
    | {
        capabilities: string[]
        granted: string[]
        methods: string[]
        enabled: boolean
        state: string
      }
    | undefined,
) {
  return (
    !!plugin &&
    plugin.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(ACCOUNT_CAPABILITY) &&
    plugin.granted.includes(ACCOUNT_CAPABILITY) &&
    ACCOUNT_METHODS.every((method) => plugin.methods.includes(method))
  )
}

const accountBridge = createNativeSim8AccountBridge()

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : '请求失败，请稍后重试'
}

export function Sim8Page({ onManage }: { onManage: () => void }) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((entry) => entry.id === SIM8_PLUGIN_ID),
  )
  const accountPlugin = usePluginCatalog((state) =>
    state.plugins.find((entry) => entry.id === 'studio.vinted-accounts'),
  )
  const compatible = supportsSim8Page(plugin)
  const hasOrders = sim8OptionalGroup(plugin, 'orders')
  const hasRenewals = sim8OptionalGroup(plugin, 'renewals')
  const hasFilter = sim8OptionalGroup(plugin, 'filtering')
  const hasExpiry = sim8OptionalGroup(plugin, 'expiry')
  const canLink = accountCapability(accountPlugin)
  const [tab, setTab] = useState<Tab>('records')
  const [config, setConfig] = useState<Sim8Config | null>(null)
  const [records, setRecords] = useState<RecordList | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [otp, setOtp] = useState<{ tel: string; result: SmsRead } | null>(null)
  const [link, setLink] = useState<SmsRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SmsRecord | 'all' | null>(null)
  const [dismissTarget, setDismissTarget] = useState<ExpiryReminder | null>(null)
  const [paidAction, setPaidAction] = useState<{
    kind: 'renew' | 'change-link'
    records: SmsRecord[]
  } | null>(null)
  const [expiry, setExpiry] = useState<{
    items: ExpiryReminder[]
    pendingTels: string[]
    failed: number
    storageDurable: boolean
  } | null>(null)

  const refresh = useCallback(async () => {
    if (!compatible || !isNativeRaccoon()) return
    setBusy(true)
    setError(null)
    try {
      const [nextConfig, nextRecords] = await Promise.all([
        sim8Api.config(),
        sim8Api.records(query),
      ])
      setConfig(nextConfig)
      setRecords(nextRecords)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }, [compatible, query])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function reloadRecords() {
    try {
      const next = await sim8Api.records(query)
      setRecords(next)
    } catch (cause) {
      setError(`操作已完成，但号码池刷新失败：${message(cause)}`)
    }
  }

  async function readCode(record: SmsRecord) {
    setBusy(true)
    setError(null)
    try {
      const result = await sim8Api.readSms(record.tel)
      setOtp({ tel: result.tel, result: result.result })
      await reloadRecords()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  async function saveContact(account: Sim8AccountTarget, record: SmsRecord) {
    setBusy(true)
    setError(null)
    try {
      await accountBridge.attachTo(account.id, record)
      toast.ok(`已写入 ${account.account}`)
      setLink(null)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    if (deleteTarget === null) return
    setBusy(true)
    try {
      if (deleteTarget === 'all') await sim8Api.clearRecords()
      else await sim8Api.removeRecord(deleteTarget.tel)
      setDeleteTarget(null)
      toast.ok(deleteTarget === 'all' ? '本机号码记录已清空' : '本机号码记录已删除')
      await reloadRecords()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  const tabs = TAB_ITEMS.filter(({ value }) => value !== 'orders' || hasOrders)
    .filter(({ value }) => value !== 'filter' || hasFilter)
    .filter(({ value }) => value !== 'expiry' || hasExpiry)
  const visible = useMemo(() => records?.items ?? [], [records])

  useEffect(() => {
    if (!tabs.some((item) => item.value === tab)) setTab('records')
  }, [hasExpiry, hasFilter, hasOrders, tab])

  if (!compatible || !isNativeRaccoon()) {
    const heading = !isNativeRaccoon()
      ? '桌面应用中使用 SIM8'
      : plugin?.state === 'unlicensed'
        ? 'SIM8 插件需要激活'
        : plugin?.state === 'running'
          ? 'SIM8 插件接口需要更新'
          : 'SIM8 插件尚未就绪'
    return (
      <>
        <PageHeader
          title="SIM8 接码"
          actions={
            <Button size="xsmall" mode="stroke" variant="neutral" onClick={onManage}>
              管理插件
            </Button>
          }
        />
        <PluginWorkspace>
          <EmptyState
            title={heading}
            hint="请在插件中心检查安装、授权和运行状态"
            action={{ label: '前往插件中心', onClick: onManage }}
          />
        </PluginWorkspace>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="SIM8 接码"
        count={records?.total}
        actions={
          <>
            {config?.hasToken && (
              <span className="text-secondary tabular-nums text-text-sub-600">
                余额 {formatMoney(config.profile?.money ?? 0)}
              </span>
            )}
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy}
              leftIcon={<RefreshIcon className="size-3.5" />}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => setTab('settings')}
            >
              设置
            </Button>
          </>
        }
      />
      <PluginWorkspace scroll={tab !== 'records' && tab !== 'orders'}>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {!isNativeRaccoon() && (
            <p className="m-0 text-secondary text-text-soft-400">
              网页预览不可调用桌面插件；安装、取码和写入保持不可用
            </p>
          )}
          {error && (
            <Alert status="error" variant="lighter" onClose={() => setError(null)}>
              {error}
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={busy}
                onClick={() => void refresh()}
              >
                重试
              </Button>
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentControl
              fit
              size="xsmall"
              semantics="tabs"
              aria-label="SIM8 功能"
              value={tab}
              onChange={(value) => setTab(value as Tab)}
              items={tabs}
            />
            {records?.storageDurable === false && (
              <span className="text-secondary text-text-soft-400">插件数据未持久化</span>
            )}
          </div>
          {!config?.hasToken && tab !== 'settings' ? (
            <Alert status="information" variant="lighter">
              填写接口地址和 API Token 后即可使用 SIM8。Token 由插件保存在自己的私有目录。
            </Alert>
          ) : null}
          {tab === 'records' && (
            <RecordsTab
              records={visible}
              total={records?.total ?? 0}
              query={query}
              setQuery={setQuery}
              busy={busy}
              onRead={(row) => void readCode(row)}
              onLink={canLink ? setLink : undefined}
              onDelete={setDeleteTarget}
              onRenew={
                hasRenewals
                  ? (row) => setPaidAction({ kind: 'renew', records: [row] })
                  : undefined
              }
              onChangeLink={
                hasRenewals
                  ? (row) => setPaidAction({ kind: 'change-link', records: [row] })
                  : undefined
              }
            />
          )}
          {tab === 'buy' && (
            <BuyTab
              disabled={!config?.hasToken || !isNativeRaccoon()}
              onPurchased={reloadRecords}
              onRead={(row) => void readCode(row)}
              onLink={canLink ? setLink : undefined}
            />
          )}
          {tab === 'orders' && hasOrders && (
            <OrdersTab
              renewals={hasRenewals}
              disabled={!config?.hasToken || !isNativeRaccoon()}
              onSynced={reloadRecords}
              onRead={(row) => void readCode(row)}
              onLink={canLink ? setLink : undefined}
              onRenew={(rows) => setPaidAction({ kind: 'renew', records: rows })}
            />
          )}
          {tab === 'filter' && hasFilter && (
            <FilterTab disabled={!config?.hasToken || !isNativeRaccoon()} />
          )}
          {tab === 'expiry' && hasExpiry && (
            <ExpiryTab
              value={expiry}
              setValue={setExpiry}
              dismiss={setDismissTarget}
              disabled={!isNativeRaccoon()}
            />
          )}
          {tab === 'settings' && (
            <SettingsTab
              config={config}
              onSaved={setConfig}
              disabled={!isNativeRaccoon()}
            />
          )}
          {canLink ? null : (
            <p className="m-0 text-secondary text-text-soft-400">
              Vinted 账号池插件未运行或缺少必要接口；其余 SIM8 功能可单独使用
            </p>
          )}
        </div>
      </PluginWorkspace>
      <Modal
        open={otp !== null}
        title={otp?.tel ?? '短信内容'}
        size="md"
        onOpenChange={(open) => {
          if (!open) setOtp(null)
        }}
        footer={
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            onClick={() => setOtp(null)}
          >
            关闭
          </Button>
        }
      >
        {otp && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-panel-title text-text-strong-950">
                {otp.result.code ?? '尚未提取到验证码'}
              </strong>
              {otp.result.code && (
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  leftIcon={<CopyIcon className="size-3.5" />}
                  onClick={() =>
                    void clip.write(otp.result.code ?? '').then(
                      () => toast.ok('验证码已复制'),
                      () => toast.err('剪贴板写入失败'),
                    )
                  }
                >
                  复制验证码
                </Button>
              )}
            </div>
            <Textarea
              className="border border-stroke-soft-200"
              label="短信原文"
              rows={8}
              readOnly
              value={otp.result.body}
            />
            <p className="m-0 text-secondary text-text-soft-400">
              {otp.result.truncated ? '原文已截断 · ' : ''}
              {otp.result.contentType} · {shortTime(otp.result.fetchedAt)}
            </p>
          </div>
        )}
      </Modal>
      <Modal
        open={link !== null}
        title="写入 Vinted 账号"
        description="将号码和接码链接写入账号池，账号其他资料保持不变。"
        onOpenChange={(open) => {
          if (!open) setLink(null)
        }}
        footer={
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            onClick={() => setLink(null)}
          >
            关闭
          </Button>
        }
      >
        {link && <AccountLinkDialog record={link} busy={busy} save={saveContact} />}
      </Modal>
      <AlertModal
        open={deleteTarget !== null}
        status="error"
        title={
          deleteTarget === 'all'
            ? '清空本机号码记录'
            : `删除 ${deleteTarget?.tel ?? '号码'} 的本机记录`
        }
        description="此操作只移除插件在本机保存的记录，不会退号或修改上游订单。"
        confirmLabel="删除记录"
        isLoading={busy}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteTarget(null)
        }}
        onConfirm={() => void confirmDelete()}
      />
      <AlertModal
        open={paidAction !== null}
        status="warning"
        title={
          paidAction?.kind === 'renew'
            ? `确认续费 ${paidAction.records.length} 个号码`
            : `更换 ${paidAction?.records[0]?.tel ?? ''} 的接码链接`
        }
        description={
          paidAction?.kind === 'renew'
            ? '续费会产生 SIM8 账户消费。请核对号码后继续。'
            : '更换后旧接码链接会立即失效，已经关联的账号需要同步更新。'
        }
        confirmLabel={paidAction?.kind === 'renew' ? '确认续费' : '更换链接'}
        isLoading={busy}
        onOpenChange={(open) => {
          if (!open && !busy) setPaidAction(null)
        }}
        onConfirm={() => {
          if (!paidAction) return
          setBusy(true)
          const current = paidAction
          const run =
            current.kind === 'renew'
              ? sim8Api
                  .renewByTels(current.records.map((row) => row.tel))
                  .then((report) => {
                    toast.ok(`续费完成 ${report.success} 个号码`)
                  })
              : current.records[0]?.apiId === null ||
                  current.records[0]?.apiId === undefined
                ? Promise.reject(new Error('号码记录缺少接码 ID'))
                : sim8Api.changeToken(current.records[0].apiId).then(() => {
                    toast.ok('接码链接已更换，旧链接立即失效')
                  })
          void run
            .then(
              () => {
                setPaidAction(null)
                return reloadRecords()
              },
              (cause) => setError(message(cause)),
            )
            .finally(() => setBusy(false))
        }}
      />
      <Modal
        open={dismissTarget !== null}
        title="今天不再提醒"
        description="只关闭这条号码与有效期对应的当日提醒。"
        onOpenChange={(open) => {
          if (!open) setDismissTarget(null)
        }}
        footer={
          <>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => setDismissTarget(null)}
            >
              取消
            </Button>
            <Button
              size="xsmall"
              disabled={busy}
              onClick={() => {
                if (!dismissTarget) return
                setBusy(true)
                void sim8Api
                  .expiryDismiss(dismissTarget.tel, dismissTarget.expiresAt)
                  .then(setExpiry)
                  .then(
                    () => setDismissTarget(null),
                    (cause) => setError(message(cause)),
                  )
                  .finally(() => setBusy(false))
              }}
            >
              关闭提醒
            </Button>
          </>
        }
      >
        {dismissTarget && (
          <p className="m-0 font-mono text-body text-text-strong-950">
            {dismissTarget.tel} · {shortTime(dismissTarget.expiresAt)}
          </p>
        )}
      </Modal>
    </>
  )
}

function RecordsTab({
  records,
  total,
  query,
  setQuery,
  busy,
  onRead,
  onLink,
  onDelete,
  onRenew,
  onChangeLink,
}: {
  records: SmsRecord[]
  total: number
  query: string
  setQuery: (value: string) => void
  busy: boolean
  onRead: (record: SmsRecord) => void
  onLink?: (record: SmsRecord) => void
  onDelete: (record: SmsRecord | 'all') => void
  onRenew?: (record: SmsRecord) => void
  onChangeLink?: (record: SmsRecord) => void
}) {
  const columns: DataListColumn<SmsRecord>[] = [
    {
      id: 'tel',
      header: '号码',
      width: 'minmax(140px,1fr)',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-1">
          <strong className="truncate font-medium text-text-strong-950">{row.tel}</strong>
          <span className="text-micro text-text-soft-400">
            {row.remark || appTypeLabel(row.type)}
          </span>
        </span>
      ),
    },
    {
      id: 'order',
      header: '订单',
      width: 'minmax(100px,.8fr)',
      cell: (row) => (
        <code className="block truncate text-mono text-text-sub-600">
          {row.ordernum || '—'}
        </code>
      ),
    },
    {
      id: 'expires',
      header: '到期',
      width: 'minmax(125px,.8fr)',
      cell: (row) => (
        <span className={recordExpired(row) ? 'text-error-text' : 'text-text-sub-600'}>
          {shortTime(row.endTime)}
        </span>
      ),
    },
    {
      id: 'otp',
      header: '最近验证码',
      width: 'minmax(125px,.8fr)',
      cell: (row) => (
        <span className="font-mono tabular-nums text-text-sub-600">
          {row.lastRead?.code ?? '—'}
        </span>
      ),
    },
    {
      id: 'operations',
      header: '操作',
      width: '152px',
      cell: (row) => (
        <div className="flex items-center gap-1">
          <PluginRowAction
            label="读取短信验证码"
            icon={<MessageIcon className="size-3.5" />}
            disabled={busy || !row.api}
            onClick={() => onRead(row)}
          />
          {onRenew && (
            <PluginRowAction
              label="续费号码"
              icon={<ExtendTimeIcon className="size-3.5" />}
              disabled={busy || row.apiId === null}
              onClick={() => onRenew(row)}
            />
          )}
          {onChangeLink && (
            <PluginRowAction
              label="更换接码链接"
              icon={<ReplaceLinkIcon className="size-3.5" />}
              disabled={busy || row.apiId === null}
              onClick={() => onChangeLink(row)}
            />
          )}
          {onLink && (
            <PluginRowAction
              label="写入 Vinted 账号"
              icon={<AssignAccountIcon className="size-3.5" />}
              disabled={busy || !row.api}
              onClick={() => onLink(row)}
            />
          )}
          <PluginRowAction
            label="删除号码"
            icon={<DeleteIcon className="size-3.5" />}
            variant="error"
            disabled={busy}
            onClick={() => onDelete(row)}
          />
        </div>
      ),
    },
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PluginFilterRow label="号码池筛选">
        <PluginSearch
          pageShortcut
          className="border border-stroke-soft-200"
          label="搜索号码"
          aria-label="搜索号码"
          placeholder="搜索号码、订单号或备注"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          size="xsmall"
          mode="ghost"
          variant="error"
          disabled={busy || total === 0}
          onClick={() => onDelete('all')}
        >
          清空号码池
        </Button>
        <span className="text-secondary tabular-nums text-text-soft-400">
          {records.length} / {total}
        </span>
      </PluginFilterRow>
      <ListColumn>
        <DataList<SmsRecord>
          aria-label="SIM8 本机号码池"
          items={records}
          columns={columns}
          rowHeight={52}
          getId={(row) => row.tel}
          getName={(row) => row.tel}
          labels={{
            selectAll: '选择全部号码',
            select: (tel) => `选择 ${tel}`,
            more: '更多号码操作',
            actions: '操作',
          }}
          status={busy ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="号码池为空"
              hint="购买号码或从订单同步后，会保存在插件自己的号码池里。"
            />
          }
        />
      </ListColumn>
    </div>
  )
}

function BuyTab({
  disabled,
  onPurchased,
  onRead,
  onLink,
}: {
  disabled: boolean
  onPurchased: () => Promise<void>
  onRead: (record: SmsRecord) => void
  onLink?: (record: SmsRecord) => void
}) {
  const [categories, setCategories] = useState<CategoryItem[]>([])
  const [apps, setApps] = useState<AppItem[]>([])
  const [category, setCategory] = useState('2')
  const [type, setType] = useState('1')
  const [appId, setAppId] = useState('')
  const [expiry, setExpiry] = useState('0')
  const [count, setCount] = useState('1')
  const [prefix, setPrefix] = useState('')
  const [excludePrefix, setExcludePrefix] = useState('')
  const [prefixes, setPrefixes] = useState<PrefixReport | null>(null)
  const [result, setResult] = useState<ReturnType<typeof makePurchase> | null>(null)
  const [queued, setQueued] = useState<AllocationState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const loadApps = useCallback(async () => {
    try {
      const next = await sim8Api.apps({
        cateId: Number(category),
        type: Number(type),
        ...(search.trim() ? { name: search.trim() } : {}),
      })
      setApps(next.items)
      setAppId((current) =>
        next.items.some((app) => String(app.id) === current)
          ? current
          : String(next.items[0]?.id ?? ''),
      )
    } catch (cause) {
      setError(message(cause))
      setApps([])
      setAppId('')
    }
  }, [category, search, type])
  useEffect(() => {
    if (!disabled && isNativeRaccoon())
      void sim8Api.categories().then(
        (value) => setCategories(value.items),
        (cause) => setError(message(cause)),
      )
  }, [disabled])
  useEffect(() => {
    if (!disabled && isNativeRaccoon()) void loadApps()
  }, [disabled, loadApps])
  const app = apps.find((item) => String(item.id) === appId) ?? null
  const amount = Number(count)
  const valid = Number.isSafeInteger(amount) && amount >= 1 && amount <= 50_000

  async function buy(deferred: boolean) {
    if (!app || !valid) {
      setError('选择有效项目，并将购买数量设为 1 到 50000 之间的整数')
      return
    }
    setBusy(true)
    setError(null)
    setQueued(null)
    setResult(null)
    const input = {
      appId: app.id,
      num: amount,
      type: Number(type),
      expiry: Number(expiry),
      ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
      ...(excludePrefix.trim() ? { excludePrefix: excludePrefix.trim() } : {}),
    }
    try {
      if (deferred) {
        setQueued(await sim8Api.deferredBuy(input))
        toast.ok('后分配订单已提交')
      } else {
        setResult(await sim8Api.buy(input))
        toast.ok('购买结果已由插件记录确认')
      }
      await onPurchased()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,.75fr)]">
      <section className="flex min-w-0 flex-col gap-3">
        <PluginFilterRow label="购买项目筛选">
          <Select
            className="w-[112px]! [&>[role=combobox]]:border [&>[role=combobox]]:border-stroke-soft-200"
            label="项目分类"
            size="xsmall"
            value={category}
            onChange={setCategory}
            options={categories.map((item) => ({
              value: String(item.id),
              label: item.name,
            }))}
          />
          <Select
            className="w-[96px]! [&>[role=combobox]]:border [&>[role=combobox]]:border-stroke-soft-200"
            label="卡类型"
            size="xsmall"
            value={type}
            onChange={setType}
            options={APP_TYPES.map((item) => ({ value: item.value, label: item.label }))}
          />
          <PluginSearch
            className="border border-stroke-soft-200"
            label="搜索项目"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="按项目名搜索"
          />
          <Select
            className="w-[144px]! [&>[role=combobox]]:border [&>[role=combobox]]:border-stroke-soft-200"
            label="项目"
            size="xsmall"
            value={appId}
            onChange={setAppId}
            options={apps.map((item) => ({
              value: String(item.id),
              label: `${item.name} · ${formatMoney(item.price)}`,
            }))}
          />
        </PluginFilterRow>
        {app && (
          <p className="m-0 text-secondary text-text-sub-600">
            单价 {formatMoney(app.price)}
            {app.stock === null ? '' : ` · 剩余 ${app.stock} 个`}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            className="[&>[role=combobox]]:border [&>[role=combobox]]:border-stroke-soft-200"
            label="有效期"
            size="xsmall"
            value={expiry}
            onChange={setExpiry}
            options={EXPIRY_OPTIONS.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
          />
          <Input
            className="border border-stroke-soft-200"
            inputSize="xsmall"
            label="数量"
            inputMode="numeric"
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            className="border border-stroke-soft-200"
            inputSize="xsmall"
            label="指定前缀"
            placeholder="1415,1416"
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
          />
          <Input
            className="border border-stroke-soft-200"
            inputSize="xsmall"
            label="排除前缀"
            placeholder="1417"
            value={excludePrefix}
            onChange={(event) => setExcludePrefix(event.target.value)}
          />
        </div>
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xsmall"
            mode="ghost"
            variant="neutral"
            disabled={disabled || busy || !app}
            onClick={() => {
              setBusy(true)
              void sim8Api
                .prefixes({ appId: app!.id, type: Number(type), expiry: Number(expiry) })
                .then(setPrefixes)
                .catch((cause) => setError(message(cause)))
                .finally(() => setBusy(false))
            }}
          >
            查看可用前缀
          </Button>
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={disabled || busy || !app || !valid}
            onClick={() => void buy(true)}
          >
            后分配下单
          </Button>
          <Button
            size="xsmall"
            disabled={disabled || busy || !app || !valid}
            leftIcon={<AddIcon className="size-3.5" />}
            onClick={() => void buy(false)}
          >
            购买 · {formatMoney((app?.price ?? 0) * (valid ? amount : 0))}
          </Button>
        </div>
      </section>
      <div className="flex min-h-0 flex-col gap-3">
        {prefixes && (
          <section className="rounded-control bg-bg-weak-50 p-3">
            <h2 className="m-0 text-panel-title text-text-strong-950">
              可用前缀 · {prefixes.num} 个号源
            </h2>
            <div className="mt-3 flex max-h-36 flex-wrap gap-2 overflow-y-auto">
              {prefixes.items.map((item) => (
                <Button
                  key={item.prefix}
                  size="3xsmall"
                  mode="stroke"
                  variant="neutral"
                  onClick={() => setPrefix(item.prefix)}
                >
                  {item.prefix} · {item.num}
                </Button>
              ))}
            </div>
          </section>
        )}
        {queued && (
          <Alert status="information" variant="lighter">
            订单 {queued.ordernum} · {allocationLabel(queued.allocationStatus)} · 申请{' '}
            {queued.requestedNum ?? '—'} / 已分配 {queued.allocatedNum ?? '—'}
            <p className="mb-0 mt-2">号码分配后到订单页同步号码。</p>
          </Alert>
        )}
        {result && (
          <section className="min-h-0 rounded-control bg-bg-weak-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 text-panel-title text-text-strong-950">
                购买结果 · {result.total} 个
              </h2>
              <code className="text-mono text-text-sub-600">{result.ordernum}</code>
            </div>
            {result.records.length === 0 ? (
              <p className="text-secondary text-text-sub-600">
                接口没有返回号码，可在订单页按订单号重新同步。
              </p>
            ) : (
              <RecordResultList
                records={result.records}
                onRead={onRead}
                onLink={onLink}
              />
            )}
            {result.truncated && (
              <p className="text-secondary text-text-soft-400">
                完整号码已保存在号码池，结果仅展示前 200 条。
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function makePurchase() {
  return { ordernum: '', total: 0, records: [] as SmsRecord[], truncated: false }
}

function RecordResultList({
  records,
  onRead,
  onLink,
}: {
  records: SmsRecord[]
  onRead: (record: SmsRecord) => void
  onLink?: (record: SmsRecord) => void
}) {
  return (
    <ul className="m-0 mt-3 flex max-h-72 list-none flex-col gap-1 overflow-auto p-0">
      {records.map((record) => (
        <li
          key={record.tel}
          className="flex flex-wrap items-center justify-between gap-2 border-b border-stroke-soft-200 py-2"
        >
          <span className="flex min-w-0 flex-col">
            <strong className="font-mono text-text-strong-950">{record.tel}</strong>
            <span className="text-micro text-text-soft-400">
              {shortTime(record.endTime)} 到期
            </span>
          </span>
          <span className="flex items-center gap-1">
            <Button
              size="3xsmall"
              mode="ghost"
              variant="neutral"
              onClick={() => onRead(record)}
            >
              取码
            </Button>
            {onLink && (
              <Button
                size="3xsmall"
                mode="ghost"
                variant="neutral"
                disabled={!record.api}
                onClick={() => onLink(record)}
              >
                写入账号
              </Button>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function OrdersTab({
  disabled,
  renewals,
  onSynced,
  onRead,
  onLink,
  onRenew,
}: {
  disabled: boolean
  renewals: boolean
  onSynced: () => Promise<void>
  onRead: (record: SmsRecord) => void
  onLink?: (record: SmsRecord) => void
  onRenew: (records: SmsRecord[]) => void
}) {
  const [rows, setRows] = useState<OrderItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<Awaited<
    ReturnType<typeof sim8Api.orderApis>
  > | null>(null)
  const [single, setSingle] = useState<SmsRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    async (next: number) => {
      setBusy(true)
      setError(null)
      try {
        const result = await sim8Api.orders({
          page: next,
          limit: PAGE_SIZE,
          ...(query.trim() ? { ordernum: query.trim() } : {}),
        })
        setRows(result.items)
        setTotal(result.total)
        setPage(next)
      } catch (cause) {
        setError(message(cause))
      } finally {
        setBusy(false)
      }
    },
    [query],
  )
  useEffect(() => {
    if (!disabled && isNativeRaccoon()) void load(1)
  }, [disabled, load])
  async function sync(ordernum: string) {
    setBusy(true)
    setError(null)
    try {
      setDetail(await sim8Api.orderApis(ordernum))
      await onSynced()
      toast.ok('订单同步已由插件确认')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  const columns: DataListColumn<OrderItem>[] = [
    {
      id: 'id',
      header: '订单号',
      width: 'minmax(140px,1fr)',
      cell: (row) => (
        <code className="text-mono text-text-strong-950">{row.ordernum || '—'}</code>
      ),
    },
    {
      id: 'state',
      header: '分配状态',
      width: '100px',
      cell: (row) => (
        <span className="text-secondary text-text-sub-600">
          {allocationLabel(row.allocationStatus)}
        </span>
      ),
    },
    {
      id: 'amount',
      header: '申请 / 已分配',
      width: '76px',
      cell: (row) => (
        <span className="tabular-nums text-text-sub-600">
          {row.requestedNum ?? '—'} / {row.allocatedNum ?? '—'}
        </span>
      ),
    },
    {
      id: 'expires',
      header: '队列到期',
      width: '140px',
      cell: (row) => <span className="text-text-sub-600">{shortTime(row.expireAt)}</span>,
    },
    {
      id: 'actions',
      header: '操作',
      width: '130px',
      cell: (row) => (
        <div className="flex gap-1">
          <PluginRowAction
            label="同步订单号码"
            icon={<RefreshIcon className="size-3.5" />}
            disabled={busy || !row.ordernum}
            onClick={() => void sync(row.ordernum)}
          />
          <PluginRowAction
            label="查询订单详情"
            icon={<EyeIcon className="size-3.5" />}
            disabled={busy || !row.ordernum}
            onClick={() => {
              setBusy(true)
              void sim8Api
                .orderOne(row.ordernum)
                .then(
                  (value) => setSingle(value.record),
                  (cause) => setError(message(cause)),
                )
                .finally(() => setBusy(false))
            }}
          />
        </div>
      ),
    },
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PluginFilterRow
        label="订单筛选"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) void load(1)
        }}
      >
        <PluginSearch
          pageShortcut
          className="border border-stroke-soft-200"
          label="订单号"
          placeholder="留空查看最近订单"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          type="submit"
          size="xsmall"
          mode="ghost"
          variant="neutral"
          disabled={busy}
        >
          查询
        </Button>
        <span className="text-secondary text-text-soft-400">
          {total} 个订单 · 第 {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页
        </span>
      </PluginFilterRow>
      {error && (
        <Alert status="error" variant="lighter">
          {error}
        </Alert>
      )}
      <ListColumn>
        <DataList<OrderItem>
          aria-label="SIM8 订单"
          items={rows}
          columns={columns}
          rowHeight={48}
          getId={(row) => `${row.ordernum}:${row.allocationStatus}`}
          getName={(row) => row.ordernum}
          labels={{
            selectAll: '选择全部订单',
            select: (ordernum) => `选择订单 ${ordernum}`,
            more: '更多订单操作',
            actions: '操作',
          }}
          status={busy ? 'loading' : 'ready'}
          empty={
            <EmptyState title="没有查到订单" hint="按订单号搜索，或留空查看最近订单。" />
          }
        />
      </ListColumn>
      <div className="flex justify-end gap-2">
        <Button
          size="xsmall"
          mode="stroke"
          variant="neutral"
          disabled={busy || page <= 1}
          onClick={() => void load(page - 1)}
        >
          上一页
        </Button>
        <Button
          size="xsmall"
          mode="stroke"
          variant="neutral"
          disabled={busy || page >= Math.ceil(total / PAGE_SIZE)}
          onClick={() => void load(page + 1)}
        >
          下一页
        </Button>
      </div>
      {detail && (
        <section className="max-h-72 overflow-auto rounded-control bg-bg-weak-50 p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="m-0 text-panel-title text-text-strong-950">
              订单 {detail.ordernum} · {detail.total} 个号码
            </h2>
            {renewals && (
              <Button
                size="3xsmall"
                mode="ghost"
                variant="neutral"
                disabled={detail.records.length === 0 || busy}
                onClick={() => onRenew(detail.records)}
              >
                全部续费
              </Button>
            )}
          </div>
          {detail.records.length ? (
            <RecordResultList records={detail.records} onRead={onRead} onLink={onLink} />
          ) : (
            <p className="text-secondary text-text-sub-600">
              尚未分配号码 · {allocationLabel(detail.allocation.allocationStatus)}
            </p>
          )}
        </section>
      )}
      {single && (
        <Modal
          open
          title={`订单单条号码 · ${single.tel}`}
          onOpenChange={(open) => {
            if (!open) setSingle(null)
          }}
          footer={
            <div className="flex gap-2">
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(single.tel)
                    .then(() => toast.ok('号码已复制'))
                }
              >
                复制号码
              </Button>
              <Button
                size="xsmall"
                onClick={() => {
                  setSingle(null)
                  onRead(single)
                }}
              >
                读取短信
              </Button>
            </div>
          }
        >
          {shortTime(single.endTime)} 到期
        </Modal>
      )}
    </div>
  )
}

function FilterTab({ disabled }: { disabled: boolean }) {
  const [apps, setApps] = useState<FilterAppItem[]>([])
  const [appId, setAppId] = useState('')
  const [code, setCode] = useState('US')
  const [numbers, setNumbers] = useState('')
  const [orderId, setOrderId] = useState('')
  const [detail, setDetail] = useState<FilterDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!disabled && isNativeRaccoon())
      void sim8Api.filterApps().then(
        (result) => {
          setApps(result.items)
          setAppId(String(result.items[0]?.id ?? ''))
        },
        (cause) => setError(message(cause)),
      )
  }, [disabled])
  const list = numbers
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  const app = apps.find((item) => String(item.id) === appId)
  async function inspect(id: number) {
    setBusy(true)
    setError(null)
    try {
      setDetail(await sim8Api.filterDetail(id))
      setOrderId(String(id))
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  async function submit() {
    if (!app || !list.length) {
      setError('选择检测项目并填写至少一个号码')
      return
    }
    setBusy(true)
    setError(null)
    setDetail(null)
    try {
      const result = await sim8Api.createFilter({
        appId: app.id,
        code: code.trim().toUpperCase(),
        numbers: list,
      })
      setOrderId(String(result.orderId))
      toast.ok(`筛选订单已提交 · ${result.count} 个号码`)
      await inspect(result.orderId)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  const id = Number(orderId.trim())
  return (
    <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,.75fr)]">
      <section className="flex min-w-0 flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            className="[&>[role=combobox]]:border [&>[role=combobox]]:border-stroke-soft-200"
            label="检测项目"
            size="xsmall"
            value={appId}
            onChange={setAppId}
            options={apps.map((item) => ({
              value: String(item.id),
              label: `${item.name} · ${formatMoney(item.price)}`,
            }))}
          />
          <Input
            className="border border-stroke-soft-200"
            inputSize="xsmall"
            label="地区代码"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        {app && (
          <p className="m-0 text-secondary text-text-sub-600">
            数量范围 {app.min ?? '—'} – {app.max ?? '—'} · 每个号码{' '}
            {formatMoney(app.price)}
          </p>
        )}
        <Textarea
          className="border border-stroke-soft-200"
          label="号码列表"
          rows={8}
          placeholder="每行一个号码，需包含国家区号"
          value={numbers}
          onChange={(event) => setNumbers(event.target.value)}
          hint={`已识别 ${list.length} 个号码`}
        />
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        <Button
          size="xsmall"
          disabled={busy || disabled || !app || !list.length}
          onClick={() => void submit()}
        >
          提交筛选检测
        </Button>
      </section>
      <div className="flex min-w-0 flex-col gap-3">
        <PluginFilterRow label="查找检测订单">
          <Input
            className="border border-stroke-soft-200"
            inputSize="xsmall"
            wrapperClassName="min-w-[144px] flex-1"
            label="检测订单 ID"
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
          />
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={busy || !Number.isSafeInteger(id) || id < 1}
            onClick={() => void inspect(id)}
          >
            查详情
          </Button>
        </PluginFilterRow>
        {detail && (
          <section className="rounded-control bg-bg-weak-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="m-0 text-panel-title text-text-strong-950">
                检测订单 {detail.orderId}
              </h2>
              <span className="text-secondary text-text-sub-600">
                {filterStatusLabel(detail.status)}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-secondary">
              <dt>项目</dt>
              <dd className="m-0 text-text-strong-950">{detail.name || '—'}</dd>
              <dt>地区</dt>
              <dd className="m-0 text-text-strong-950">
                {detail.country || '—'} {detail.countryCode}
              </dd>
              <dt>提交 / 有效</dt>
              <dd className="m-0 tabular-nums text-text-strong-950">
                {detail.num ?? '—'} / {detail.valid ?? '—'}
              </dd>
              <dt>消费</dt>
              <dd className="m-0 tabular-nums text-text-strong-950">
                {formatMoney(detail.money)}
              </dd>
              <dt>时间</dt>
              <dd className="m-0 text-text-strong-950">
                {shortTime(detail.createTime)} · {shortTime(detail.updateTime)}
              </dd>
            </dl>
            {detail.taskRemark && (
              <p className="text-secondary text-text-sub-600">{detail.taskRemark}</p>
            )}
            {detail.taskFileUrl && (
              <p className="break-all text-secondary text-text-sub-600">
                结果文件 · {detail.taskFileUrl}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function ExpiryTab({
  value,
  setValue,
  dismiss,
  disabled,
}: {
  value: {
    items: ExpiryReminder[]
    pendingTels: string[]
    failed: number
    storageDurable: boolean
  } | null
  setValue: (value: {
    items: ExpiryReminder[]
    pendingTels: string[]
    failed: number
    storageDurable: boolean
  }) => void
  dismiss: (value: ExpiryReminder) => void
  disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    if (disabled || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const before = await sim8Api.expiryList()
      if (before.pendingTels.length) await sim8Api.expiryRefresh(before.pendingTels)
      setValue(await sim8Api.expiryList())
    } catch (cause) {
      setError(message(cause))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [disabled, setValue])
  useEffect(() => {
    if (!disabled && isNativeRaccoon()) void refresh()
  }, [disabled, refresh])
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="m-0 text-panel-title text-text-strong-950">号码到期提醒</h2>
          <p className="mb-0 mt-1 text-secondary text-text-soft-400">
            显示未来七天内号码，提醒关闭按当天本机日期保存
          </p>
        </div>
        <Button
          size="xsmall"
          mode="ghost"
          variant="neutral"
          disabled={busy || disabled}
          leftIcon={<RefreshIcon className="size-3.5" />}
          onClick={() => void refresh()}
        >
          {busy ? '检查中…' : '刷新提醒'}
        </Button>
      </div>
      {error && (
        <Alert status="error" variant="lighter">
          {error}
        </Alert>
      )}
      {value?.storageDurable === false && (
        <Alert status="warning" variant="lighter">
          插件存储目录不可持久化，当天关闭提醒仅在当前运行有效。
        </Alert>
      )}
      {value?.failed ? (
        <Alert status="warning" variant="lighter">
          {value.failed} 个号码读取失败，已保留原到期记录，可稍后重试。
        </Alert>
      ) : null}
      {value?.pendingTels.length ? (
        <p className="m-0 text-secondary text-text-soft-400">
          待检查 {value.pendingTels.length} 个号码
        </p>
      ) : null}
      <ul className="m-0 flex max-h-[min(48vh,420px)] list-none flex-col overflow-auto p-0">
        {value?.items.map((item) => (
          <li
            key={`${item.tel}:${item.expiresAt}`}
            className="flex flex-wrap items-center justify-between gap-2 border-b border-stroke-soft-200 py-3"
          >
            <span className="flex min-w-0 flex-col gap-1">
              <strong className="font-mono text-text-strong-950">{item.tel}</strong>
              <span className="text-secondary text-text-sub-600">
                {shortTime(item.expiresAt)} 到期 ·{' '}
                {Math.max(
                  1,
                  Math.ceil((Date.parse(item.expiresAt) - Date.now()) / 86_400_000),
                )}{' '}
                天内
              </span>
            </span>
            <Button
              size="3xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy || disabled}
              onClick={() => dismiss(item)}
            >
              今天不再提醒
            </Button>
          </li>
        ))}
      </ul>
      {value?.items.length === 0 && (
        <EmptyState
          title="暂无待提醒号码"
          hint="已读取所有可检查号码，未发现七天内到期的记录。"
        />
      )}
    </section>
  )
}

function SettingsTab({
  config,
  onSaved,
  disabled,
}: {
  config: Sim8Config | null
  onSaved: (config: Sim8Config) => void
  disabled: boolean
}) {
  const [url, setUrl] = useState(config?.baseUrl ?? 'https://api.cc')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setUrl(config?.baseUrl ?? 'https://api.cc')
  }, [config?.baseUrl])
  async function save(clear = false) {
    setBusy(true)
    setError(null)
    try {
      onSaved(
        await sim8Api.saveConfig({
          baseUrl: url.trim(),
          ...(clear ? { token: null } : token.trim() ? { token: token.trim() } : {}),
        }),
      )
      setToken('')
      toast.saved(clear ? 'SIM8 Token 已清除' : 'SIM8 配置已保存')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  async function refreshProfile() {
    setBusy(true)
    setError(null)
    try {
      const profile = await sim8Api.profile()
      if (config)
        onSaved({ ...config, profile: profile.profile, profileAt: profile.profileAt })
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,.75fr)]">
        <section className="flex min-w-0 flex-col gap-3">
          <h2 className="m-0 text-panel-title text-text-strong-950">SIM8 接口</h2>
          <Input
            className="border border-stroke-soft-200"
            inputSize="xsmall"
            label="接口地址"
            technical
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://api.cc"
          />
          <Input
            className="border border-stroke-soft-200"
            inputSize="xsmall"
            label="API Token"
            secret
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={config?.hasToken ? '已保存；留空不修改' : '粘贴后台的 API Token'}
            hint="Token 不会回显；提交前会先验证后保存。"
          />
          {error && (
            <Alert status="error" variant="lighter">
              {error}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xsmall"
              disabled={disabled || busy || !url.trim()}
              onClick={() => void save()}
            >
              {busy ? '验证并保存中…' : '验证并保存'}
            </Button>
            {config?.hasToken && (
              <Button
                size="xsmall"
                mode="ghost"
                variant="error"
                disabled={disabled || busy}
                onClick={() => setConfirmClear(true)}
              >
                清除 Token
              </Button>
            )}
            {config?.hasToken && (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={disabled || busy}
                onClick={() => void refreshProfile()}
              >
                刷新账号余额
              </Button>
            )}
          </div>
        </section>
        <section className="rounded-control bg-bg-weak-50 p-3">
          <h2 className="m-0 text-panel-title text-text-strong-950">账号状态</h2>
          {config?.profile ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-secondary">
              <dt>账号</dt>
              <dd className="m-0 text-text-strong-950">
                {config.profile.nickname || config.profile.username || '—'}
              </dd>
              <dt>余额</dt>
              <dd className="m-0 tabular-nums text-text-strong-950">
                {formatMoney(config.profile.money)}
              </dd>
              <dt>更新于</dt>
              <dd className="m-0 text-text-strong-950">
                {shortTime(config.profileAt ?? '')}
              </dd>
            </dl>
          ) : (
            <p className="text-secondary text-text-sub-600">
              {config?.hasToken ? '尚未读取账号信息' : '尚未配置 Token'}
            </p>
          )}
          <p className="text-secondary text-text-soft-400">
            本机号码记录 {config?.records ?? 0} 个 ·{' '}
            {config?.storageDurable ? '插件存储已持久化' : '插件存储不持久化'}
          </p>
        </section>
      </div>
      <AlertModal
        open={confirmClear}
        status="warning"
        title="清除 SIM8 Token"
        description="清除后需要重新验证 Token 才能购买和读取订单。"
        confirmLabel="清除 Token"
        isLoading={busy}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmClear(false)
        }}
        onConfirm={() => {
          setConfirmClear(false)
          void save(true)
        }}
      />
    </>
  )
}

function AccountLinkDialog({
  record,
  busy,
  save,
}: {
  record: SmsRecord
  busy: boolean
  save: (account: Sim8AccountTarget, record: SmsRecord) => Promise<void>
}) {
  const [items, setItems] = useState<Sim8AccountTarget[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void accountBridge.list().then(
      (value) => {
        if (active) setItems(value)
      },
      (cause) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [])
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Alert status="error" variant="lighter">
          {error}
        </Alert>
      )}
      {items === null ? (
        <p className="text-secondary text-text-sub-600">正在读取账号…</p>
      ) : items.length === 0 ? (
        <EmptyState title="账号池为空" hint="先在 Vinted 账号池创建账号。" />
      ) : (
        <ul className="m-0 flex max-h-72 list-none flex-col overflow-auto p-0">
          {items.map((account) => (
            <li
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-stroke-soft-200 py-2"
            >
              <span className="flex min-w-0 flex-col">
                <strong className="truncate text-text-strong-950">
                  {account.account}
                </strong>
                <span className="text-micro text-text-soft-400">
                  {account.phone ? `原号码 ${account.phone}` : '尚未填写手机号'} ·{' '}
                  {account.smsOtpUrl ? '已有接码链接' : '无接码链接'}
                </span>
              </span>
              <Button
                size="3xsmall"
                disabled={busy}
                onClick={() => void save(account, record)}
              >
                写入号码
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 break-all text-secondary text-text-soft-400">
        写入 {record.tel} · 链接 {record.api ? '已包含' : '不可用'}
      </p>
    </div>
  )
}
