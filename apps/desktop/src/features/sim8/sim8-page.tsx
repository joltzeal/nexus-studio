import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Settings2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toast'
import { PluginGate } from '@/features/plugins/plugin-gate'
import {
  listPlugins,
  pluginHostAvailable,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { listAccountTargets, type AccountTarget } from './accounts-bridge'
import { getConfig, listRecords, readSms } from './api'
import { BuyPanel } from './buy-panel'
import { FilterPanel } from './filter-panel'
import { LinkAccountDialog } from './link-account-dialog'
import { OrdersPanel } from './orders-panel'
import { RecordsPanel } from './records-panel'
import { SettingsPanel } from './settings-panel'
import { SmsCodeDialog } from './sms-code-dialog'
import {
  SIM8_PLUGIN_ID,
  formatMoney,
  message,
  type Sim8Config,
  type SmsRead,
  type SmsRecord,
} from './types'

const TABS = [
  { value: 'records', label: '号码池' },
  { value: 'buy', label: '买号' },
  { value: 'orders', label: '订单' },
  { value: 'filter', label: '筛选检测' },
  { value: 'settings', label: '设置' },
] as const

type TabValue = (typeof TABS)[number]['value']

export interface Sim8PageProps {
  plugin: PluginView | null
  hostAvailable: boolean
}

export function Sim8Page({ plugin, hostAvailable }: Sim8PageProps) {
  const running = plugin !== null && plugin.state === 'running'
  const [config, setConfig] = useState<Sim8Config | null>(null)
  const [records, setRecords] = useState<SmsRecord[]>([])
  const [total, setTotal] = useState(0)
  const [accounts, setAccounts] = useState<AccountTarget[]>([])
  const [accountsError, setAccountsError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabValue>('records')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [otp, setOtp] = useState<{ tel: string; result: SmsRead } | null>(null)
  const [link, setLink] = useState<SmsRecord | null>(null)

  const loadRecords = useCallback(async () => {
    const result = await listRecords()
    setRecords(result.items)
    setTotal(result.total)
  }, [])

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await listAccountTargets())
      setAccountsError(null)
    } catch (cause) {
      // The accounts plugin is optional: without it everything except 写入账号
      // still works, so this is a note rather than a page-level failure.
      setAccounts([])
      setAccountsError(message(cause))
    }
  }, [])

  const reload = useCallback(async () => {
    await Promise.all([loadRecords(), loadAccounts()])
    setConfig(await getConfig())
  }, [loadRecords, loadAccounts])

  useEffect(() => {
    if (!running) return
    let active = true
    void (async () => {
      try {
        const [nextConfig, list] = await Promise.all([
          getConfig(),
          listRecords(),
          loadAccounts(),
        ])
        if (!active) return
        setConfig(nextConfig)
        setRecords(list.items)
        setTotal(list.total)
        setError(null)
      } catch (cause) {
        if (active) setError(message(cause))
      }
    })()
    return () => {
      active = false
    }
  }, [running, loadAccounts])

  async function refresh() {
    if (busy) return
    setBusy(true)
    try {
      await reload()
      setError(null)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  async function readCode(record: SmsRecord) {
    setBusy(true)
    try {
      const result = await readSms(record.tel)
      setOtp({ tel: record.tel, result: result.result })
      await loadRecords()
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusy(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const visible =
    needle === ''
      ? records
      : records.filter((record) =>
          `${record.tel} ${record.ordernum} ${record.remark}`
            .toLowerCase()
            .includes(needle),
        )

  return (
    <section className="collection-page page-reveal" aria-labelledby="sim8-heading">
      <div className="section-intro">
        <h1 className="page-heading" id="sim8-heading">
          SIM8 接码
        </h1>
        <div className="section-actions">
          {config === null ? null : config.hasToken ? (
            <Badge variant="secondary">
              余额 {formatMoney(config.profile?.money ?? 0)}
            </Badge>
          ) : (
            <Badge variant="outline">未配置</Badge>
          )}
          <Button
            variant="ghost"
            disabled={!running || busy}
            onClick={() => void refresh()}
          >
            <RefreshCw
              data-icon="inline-start"
              className={busy ? 'animate-spin' : undefined}
            />
            刷新
          </Button>
          <Button
            variant="outline"
            disabled={!running}
            onClick={() => setTab('settings')}
          >
            <Settings2 data-icon="inline-start" />
            设置
          </Button>
        </div>
      </div>

      {error === null ? null : <FieldError role="alert">{error}</FieldError>}

      {!running ? (
        <PluginGate label="SIM8 接码" hostAvailable={hostAvailable} plugin={plugin} />
      ) : config === null ? (
        <div className="shell-loading" aria-label="正在读取配置" role="status">
          <Skeleton className="h-44 w-full max-w-lg" />
        </div>
      ) : !config.hasToken ? (
        <div className="sim8-setup">
          <p className="sim8-muted">
            先填好接口地址和 API Token，之后才能买号、取码。Token
            保存在插件自己的私有目录里。
          </p>
          <SettingsPanel config={config} onSaved={setConfig} />
        </div>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as TabValue)}
          className="sim8-tabs"
        >
          <TabsList variant="line">
            {TABS.map((entry) => (
              <TabsTrigger key={entry.value} value={entry.value}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {accountsError === null ? null : (
            <p className="sim8-hint">
              账号池插件不可用，暂时不能把号码写进 Vinted 账号：{accountsError}
            </p>
          )}

          <TabsContent value="records">
            <RecordsPanel
              records={visible}
              total={total}
              query={query}
              busy={busy}
              accounts={accounts}
              onQueryChange={setQuery}
              onRefresh={() => void refresh()}
              onChanged={reload}
              onRead={(record) => void readCode(record)}
              onLink={setLink}
            />
          </TabsContent>

          <TabsContent value="buy">
            <BuyPanel
              accounts={accounts}
              onPurchased={reload}
              onRead={(record) => void readCode(record)}
              onLink={setLink}
            />
          </TabsContent>

          <TabsContent value="orders">
            <OrdersPanel
              accounts={accounts}
              onSynced={reload}
              onRead={(record) => void readCode(record)}
              onLink={setLink}
            />
          </TabsContent>

          <TabsContent value="filter">
            <FilterPanel />
          </TabsContent>

          <TabsContent value="settings">
            <SettingsPanel config={config} onSaved={setConfig} />
          </TabsContent>
        </Tabs>
      )}

      <Dialog
        open={otp !== null}
        onOpenChange={(open) => {
          if (!open) setOtp(null)
        }}
      >
        {otp === null ? null : (
          <SmsCodeDialog tel={otp.tel} result={otp.result} onClose={() => setOtp(null)} />
        )}
      </Dialog>

      <Dialog
        open={link !== null}
        onOpenChange={(open) => {
          if (!open) setLink(null)
        }}
      >
        {link === null ? null : (
          <LinkAccountDialog
            record={link}
            accounts={accounts}
            onDone={() => {
              void reload()
            }}
            onClose={() => setLink(null)}
          />
        )}
      </Dialog>
    </section>
  )
}

/**
 * The host has no push channel, so the page polls the catalog while the plugin
 * process is coming up — the same contract the other plugin pages follow.
 */
export function Sim8Route() {
  const hostAvailable = pluginHostAvailable()
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applyCatalog = useCallback((catalog: PluginView[]) => {
    setPlugin(catalog.find((entry) => entry.id === SIM8_PLUGIN_ID) ?? null)
  }, [])

  const refresh = useCallback(async () => {
    if (!hostAvailable) return
    try {
      applyCatalog(await listPlugins())
    } catch (cause) {
      setError(message(cause))
    }
  }, [hostAvailable, applyCatalog])

  useEffect(() => {
    if (!hostAvailable) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) applyCatalog(catalog)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [hostAvailable, applyCatalog])

  const pending = plugin === null || plugin.state !== 'running'
  useEffect(() => {
    if (!hostAvailable || !pending) return
    const timer = setInterval(() => {
      void refresh()
    }, 2000)
    return () => clearInterval(timer)
  }, [hostAvailable, pending, refresh])

  return (
    <>
      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      <Sim8Page plugin={plugin} hostAvailable={hostAvailable} />
    </>
  )
}
