import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Select } from '@proxyshard/shardx-ui-kit'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import {
  ACCOUNT_PLUGIN_ID,
  type Account,
} from '../../../raccoon/plugins/vinted-accounts/model'
import {
  accountsApi,
  supportsAccountOptional,
} from '../../../raccoon/plugins/vinted-accounts/api'
import {
  OrderWatchSession,
  orderWatchHttpUrl,
  type CurrentOrderWatchTask,
} from '../../../raccoon/plugins/vinted-accounts/order-watch-session'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { useWorkspace } from '../../../raccoon/store'

const formatTime = (value: string | null, empty = '尚无记录') =>
  value ? new Date(value).toLocaleString() : empty

export function OrderWatch({
  accounts,
  onClose,
}: {
  accounts: Pick<Account, 'id' | 'account'>[]
  onClose: () => void
}) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === ACCOUNT_PLUGIN_ID),
  )
  const workspace = useWorkspace()
  const available = supportsAccountOptional(plugin, 'orderWatch') && isNativeRaccoon()
  const identity = available
    ? JSON.stringify([
        workspace.connectionId,
        plugin?.installation,
        plugin?.runtimeGeneration,
        plugin?.source,
        plugin?.sourceDirectory,
        plugin?.version,
      ])
    : null
  const identityRef = useRef(identity)
  identityRef.current = identity
  const [session] = useState(() => new OrderWatchSession(() => identityRef.current))
  const [settings, setSettings] = useState<{
    intervalMinutes: number
    bark: { baseUrl: string; deviceKey: string; enabled: boolean }
  } | null>(null)
  const [items, setItems] = useState<
    {
      accountId: string
      homepageUrl: string
      enabled: boolean
      running: boolean
      lastCompleteAt: string | null
      lastItemCount: number | null
      lastError: string | null
      nextRunAt: string | null
      pendingCount: number
      soldCount: number
    }[]
  >([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const settingsRevision = useRef(0)
  const historyAccount = useRef<string | null>(null)
  const detailRequest = useRef(0)
  const [history, setHistory] = useState<Awaited<
    ReturnType<typeof accountsApi.orderWatchHistory>
  > | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [detail, setDetail] = useState<{
    id: string
    page: number
    items: { id: string; url: string; title: string; imageUrl: string | null }[]
    total: number
    lastError: string | null
    lastCompleteAt: string | null
  } | null>(null)
  const runTask = useCallback(
    async (operation: (current: CurrentOrderWatchTask) => Promise<void>) => {
      await session.run(async (current) => {
        setBusy(true)
        setError(null)
        try {
          await operation(current)
        } catch (cause) {
          if (current())
            setError(cause instanceof Error ? cause.message : '商品监控操作失败')
        } finally {
          if (current()) setBusy(false)
        }
      })
    },
    [session],
  )
  const readWatchState = useCallback(async (current: CurrentOrderWatchTask) => {
    const accountId = historyAccount.current
    const [summaries, records] = await Promise.allSettled([
      accountsApi.orderWatches(),
      accountId ? accountsApi.orderWatchHistory(accountId) : Promise.resolve(null),
    ])
    if (!current()) return
    if (summaries.status === 'fulfilled') setItems(summaries.value.items)
    if (
      records.status === 'fulfilled' &&
      accountId &&
      historyAccount.current === accountId &&
      records.value
    ) {
      const values = records.value
      setHistory(values)
      setHistoryPage((page) => Math.min(page, Math.max(1, Math.ceil(values.length / 10))))
    }
    if (summaries.status === 'rejected') throw summaries.reason
    if (records.status === 'rejected') throw records.reason
  }, [])
  useEffect(() => {
    session.start()
    setSettings(null)
    setItems([])
    setHistory(null)
    setHistoryPage(1)
    setDetail(null)
    setError(null)
    setBusy(false)
    settingsRevision.current = 0
    historyAccount.current = null
    if (!identity) return () => session.stop()
    void runTask(async (current) => {
      const revision = settingsRevision.current
      const [nextSettings, state] = await Promise.allSettled([
        accountsApi.orderWatchSettings(),
        readWatchState(current),
      ])
      if (!current()) return
      if (nextSettings.status === 'fulfilled' && settingsRevision.current === revision)
        setSettings(nextSettings.value)
      if (nextSettings.status === 'rejected') throw nextSettings.reason
      if (state.status === 'rejected') throw state.reason
    })
    const timer = window.setInterval(() => void runTask(readWatchState), 5000)
    return () => {
      window.clearInterval(timer)
      session.stop()
    }
  }, [identity, readWatchState, runTask, session])
  function changeSettings(next: NonNullable<typeof settings>) {
    settingsRevision.current++
    setSettings(next)
  }
  async function save() {
    if (!settings) return
    const input = { ...settings, bark: { ...settings.bark } }
    const revision = settingsRevision.current
    await runTask(async (current) => {
      const result = await accountsApi.saveOrderWatchSettings(input)
      if (current() && settingsRevision.current === revision) setSettings(result)
    })
  }
  const refresh = () => runTask(readWatchState)
  const action = (operation: () => Promise<unknown>) =>
    runTask(async (current) => {
      await operation()
      if (current()) await readWatchState(current)
    })
  async function loadItems(id: string, page: number) {
    await runTask(async (current) => {
      const request = ++detailRequest.current
      const result = await accountsApi.orderWatchItems(id, page)
      if (current() && detailRequest.current === request)
        setDetail({
          id,
          page,
          items: result.items,
          total: result.total,
          lastError: result.lastError,
          lastCompleteAt: result.lastCompleteAt,
        })
    })
  }
  async function loadHistory(id: string) {
    await runTask(async (current) => {
      historyAccount.current = id
      setHistory(null)
      setHistoryPage(1)
      const result = await accountsApi.orderWatchHistory(id)
      if (current() && historyAccount.current === id) {
        setHistory(result)
      }
    })
  }
  const locked = busy || !available
  return (
    <Modal
      open
      title="Vinted 商品监控"
      description="调度在账号池插件中运行，与此页面是否打开无关。"
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      footer={
        <Button size="xsmall" mode="stroke" variant="neutral" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {!available && (
          <Alert status="information" variant="lighter">
            账号池插件当前不可用，监控页面已停止刷新。
          </Alert>
        )}
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {settings && (
          <section className="flex flex-col gap-3 rounded-control bg-bg-weak-50 p-3">
            <h2 className="m-0 text-panel-title text-text-strong-950">调度与通知</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                inputSize="xsmall"
                label="检查间隔（分钟）"
                inputMode="numeric"
                disabled={locked}
                value={String(settings.intervalMinutes)}
                onChange={(event) =>
                  changeSettings({
                    ...settings,
                    intervalMinutes: Number(event.target.value),
                  })
                }
              />
              <Select
                label="Bark 提醒"
                size="xsmall"
                disabled={locked}
                value={String(settings.bark.enabled)}
                onChange={(value) =>
                  changeSettings({
                    ...settings,
                    bark: { ...settings.bark, enabled: value === 'true' },
                  })
                }
                options={[
                  { value: 'false', label: '关闭' },
                  { value: 'true', label: '开启' },
                ]}
              />
              <Input
                inputSize="xsmall"
                label="Bark 服务地址"
                disabled={locked}
                value={settings.bark.baseUrl}
                onChange={(event) =>
                  changeSettings({
                    ...settings,
                    bark: { ...settings.bark, baseUrl: event.target.value },
                  })
                }
              />
              <Input
                inputSize="xsmall"
                secret
                label="设备 Key"
                type="password"
                disabled={locked}
                value={settings.bark.deviceKey}
                onChange={(event) =>
                  changeSettings({
                    ...settings,
                    bark: { ...settings.bark, deviceKey: event.target.value },
                  })
                }
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={locked}
                onClick={() => void refresh()}
              >
                刷新监控状态
              </Button>
              <Button size="xsmall" disabled={locked} onClick={() => void save()}>
                保存设置
              </Button>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={locked}
                onClick={() => void action(() => accountsApi.testOrderWatchBark())}
              >
                测试 Bark
              </Button>
            </div>
          </section>
        )}
        <div className="flex flex-col gap-2">
          {items.map((item) => {
            const account = accounts.find((row) => row.id === item.accountId)
            const homepageUrl = orderWatchHttpUrl(item.homepageUrl)
            return (
              <div
                key={item.accountId}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-stroke-soft-200 py-2"
              >
                <div className="min-w-0">
                  <strong className="text-text-strong-950">
                    {account?.account ?? item.accountId}
                  </strong>
                  <p className="m-0 text-secondary text-text-soft-400">
                    {item.soldCount} 已售 · {item.pendingCount} 待确认 ·{' '}
                    {item.running ? '检查中' : item.enabled ? '已启用' : '已暂停'}
                  </p>
                  <dl className="mb-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-micro text-text-soft-400">
                    <dt>最近完整扫描</dt>
                    <dd className="m-0">
                      {formatTime(item.lastCompleteAt, '尚未完整扫描')}
                    </dd>
                    <dt>最近商品数</dt>
                    <dd className="m-0">
                      {item.lastItemCount === null
                        ? '尚无记录'
                        : `${item.lastItemCount} 件`}
                    </dd>
                    <dt>下次检查</dt>
                    <dd className="m-0">{formatTime(item.nextRunAt, '尚未调度')}</dd>
                  </dl>
                  {item.lastError && (
                    <p className="mb-0 mt-2 text-secondary text-error-text">
                      {item.lastError}
                    </p>
                  )}
                  {homepageUrl && (
                    <a
                      className="mt-2 inline-block text-secondary text-text-sub-600 underline"
                      href={homepageUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开主页
                    </a>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button
                    size="3xsmall"
                    mode="ghost"
                    variant="neutral"
                    disabled={locked}
                    onClick={() => void loadHistory(item.accountId)}
                  >
                    核查记录
                  </Button>
                  <Button
                    size="3xsmall"
                    mode="ghost"
                    variant="neutral"
                    disabled={locked}
                    onClick={() =>
                      void action(() =>
                        accountsApi.setOrderWatchEnabled(item.accountId, !item.enabled),
                      )
                    }
                  >
                    {item.enabled ? '暂停' : '启用'}
                  </Button>
                  <Button
                    size="3xsmall"
                    mode="ghost"
                    variant="neutral"
                    disabled={locked || item.running || !item.enabled}
                    onClick={() =>
                      void action(() => accountsApi.runOrderWatch(item.accountId))
                    }
                  >
                    立即检查
                  </Button>
                  <Button
                    size="3xsmall"
                    mode="stroke"
                    variant="neutral"
                    disabled={locked}
                    onClick={() => void loadItems(item.accountId, 1)}
                  >
                    查看商品
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
        {detail && (
          <section className="max-h-52 overflow-y-auto rounded-control bg-bg-weak-50 p-3">
            <div className="flex justify-between">
              <strong>监控商品 · {detail.total}</strong>
              <Button
                size="3xsmall"
                mode="ghost"
                variant="neutral"
                onClick={() => {
                  detailRequest.current++
                  setDetail(null)
                }}
              >
                关闭
              </Button>
            </div>
            <p className="mb-1 mt-2 text-micro text-text-soft-400">
              最近完整扫描 · {formatTime(detail.lastCompleteAt, '尚未完整扫描')}
            </p>
            {detail.items.map((item) => {
              const url = orderWatchHttpUrl(item.url)
              return (
                <p key={item.id} className="mb-1 mt-2 text-secondary">
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer">
                      {item.title || item.id}
                    </a>
                  ) : (
                    item.title || item.id
                  )}
                </p>
              )
            })}
            {detail.lastError && <p className="text-error-text">{detail.lastError}</p>}
            <div className="mt-3 flex items-center justify-end gap-2">
              <span className="text-secondary text-text-soft-400">
                第 {detail.page} / {Math.max(1, Math.ceil(detail.total / 10))} 页
              </span>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={locked || detail.page <= 1}
                onClick={() => void loadItems(detail.id, detail.page - 1)}
              >
                上一页
              </Button>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={locked || detail.page * 10 >= detail.total}
                onClick={() => void loadItems(detail.id, detail.page + 1)}
              >
                下一页
              </Button>
            </div>
          </section>
        )}
        {history && (
          <section className="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-control bg-bg-weak-50 p-3">
            <div className="flex items-center justify-between">
              <strong>最近核查记录（最多 100 条）</strong>
              <Button
                size="3xsmall"
                mode="ghost"
                variant="neutral"
                onClick={() => {
                  historyAccount.current = null
                  setHistory(null)
                }}
              >
                关闭记录
              </Button>
            </div>
            {!history.length && (
              <p className="m-0 text-secondary text-text-soft-400">暂无核查记录</p>
            )}
            {history.slice((historyPage - 1) * 10, historyPage * 10).map((item) => {
              const url = orderWatchHttpUrl(item.itemUrl)
              return (
                <div key={item.id} className="border-b border-stroke-soft-200 py-2">
                  <strong className="block text-secondary text-text-strong-950">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        {item.title || item.itemId}
                      </a>
                    ) : (
                      item.title || item.itemId
                    )}{' '}
                    ·{' '}
                    {
                      { pending: '待确认', sold: '已售', reappeared: '重新出现' }[
                        item.status
                      ]
                    }
                  </strong>
                  <dl className="mb-1 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-micro text-text-soft-400">
                    <dt>最后可见</dt>
                    <dd className="m-0">{formatTime(item.lastSeenAt)}</dd>
                    <dt>首次消失</dt>
                    <dd className="m-0">{formatTime(item.missingAt)}</dd>
                  </dl>
                  <p className="m-0 text-secondary text-text-sub-600">
                    核查 ·{' '}
                    {item.checkedAt
                      ? new Date(item.checkedAt).toLocaleString()
                      : '尚未核查'}
                    {item.checkError ? `；${item.checkError}` : ''}
                  </p>
                  <p className="m-0 text-secondary text-text-soft-400">
                    Bark ·{' '}
                    {item.notifiedAt
                      ? new Date(item.notifiedAt).toLocaleString()
                      : '未发送'}
                    {item.notifyError ? `；${item.notifyError}` : ''}
                  </p>
                </div>
              )
            })}
            <div className="flex items-center justify-end gap-2">
              <span className="text-secondary text-text-soft-400">
                第 {historyPage} / {Math.max(1, Math.ceil(history.length / 10))} 页
              </span>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={historyPage <= 1}
                onClick={() => setHistoryPage(historyPage - 1)}
              >
                上一页
              </Button>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={historyPage * 10 >= history.length}
                onClick={() => setHistoryPage(historyPage + 1)}
              >
                下一页
              </Button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}
