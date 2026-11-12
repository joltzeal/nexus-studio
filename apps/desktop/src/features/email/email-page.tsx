import { useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload,
} from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from '@/components/ui/toast'
import { PluginGate } from '@/features/plugins/plugin-gate'
import type { PluginView } from '@/lib/platform/native-plugins'
import { cn } from '@/lib/utils'
import { listMailboxes, queueRefresh } from './api'
import { EmailResource } from './async-state'
import { useEmailAction, useEmailResource } from './hooks'
import { emailProcessIdentity } from './identity'
import { ImportMailboxesDialog } from './import-dialog'
import { MailboxEditor } from './mailbox-editor'
import { MailReader } from './mail-reader'
import { RemoveMailboxDialog } from './remove-mailbox-dialog'
import { RefreshSettingsDialog } from './settings-dialog'
import {
  formatMailTime,
  MAILBOX_STATUSES,
  STATUS_LABELS,
  type MailboxQuery,
  type MailboxView,
} from './types'

export interface EmailPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
}

export function EmailPage({ plugin, hostAvailable }: EmailPageProps) {
  const identity = emailProcessIdentity(plugin, hostAvailable)
  if (identity === null) {
    return (
      <section className="collection-page page-reveal" aria-labelledby="email-heading">
        <div className="section-intro">
          <h1 className="page-heading" id="email-heading">
            邮箱
          </h1>
        </div>
        <PluginGate label="邮箱" plugin={plugin} hostAvailable={hostAvailable} />
      </section>
    )
  }
  // A process replacement unmounts every read/write scope, including open dialogs.
  return <EmailWorkspace key={identity} />
}

function EmailWorkspace() {
  const [resource] = useState(
    () =>
      new EmailResource<MailboxQuery, Awaited<ReturnType<typeof listMailboxes>>>(
        { page: 1, pageSize: 20 },
        listMailboxes,
        '邮箱列表读取失败，请重试。上次成功读取的资料已保留。',
      ),
  )
  const state = useEmailResource(resource, 5_000)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<{ account: MailboxView | null } | null>(null)
  const [importing, setImporting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [removing, setRemoving] = useState<MailboxView | null>(null)
  const [reading, setReading] = useState<MailboxView | null>(null)
  const refresh = useEmailAction('刷新任务排队失败，请重试。')
  const data = state.value
  const items = data?.items ?? []
  const selected = items.filter((account) => selectedIds.has(account.id))
  const allSelected = items.length > 0 && selected.length === items.length
  const page = data?.page ?? state.params.page
  const pageSize = state.params.pageSize
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))
  const currentReader = reading
    ? (items.find((account) => account.id === reading.id) ?? reading)
    : null

  function selectPage(patch: Partial<MailboxQuery>, resetStatus = false) {
    setSelectedIds(new Set())
    const params = { ...resource.getSnapshot().params, ...patch }
    if (resetStatus) delete params.status
    resource.select(params)
  }

  function changed() {
    setSelectedIds(new Set())
    resource.invalidate()
  }

  function requestRefresh(ids: string[]) {
    void refresh.action.run(
      () => queueRefresh(ids),
      (result) => {
        resource.invalidate()
        toast.success(`已排队 ${result.queued} 个邮箱，跳过 ${result.skipped} 个`)
      },
    )
  }

  return (
    <section
      className="collection-page page-reveal flex min-w-0 flex-col gap-3"
      aria-labelledby="email-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-heading" id="email-heading">
          邮箱
        </h1>
        <div className="section-actions">
          <Button variant="ghost" disabled={state.loading} onClick={resource.refresh}>
            <RefreshCw
              data-icon="inline-start"
              className={cn(state.loading && 'animate-spin')}
            />
            刷新列表
          </Button>
          <Button variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings2 data-icon="inline-start" />
            刷新设置
          </Button>
          <Button variant="outline" onClick={() => setImporting(true)}>
            <Upload data-icon="inline-start" />
            批量导入
          </Button>
          <Button onClick={() => setEditing({ account: null })}>
            <Plus data-icon="inline-start" />
            新增邮箱
          </Button>
        </div>
      </div>

      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {refresh.error ? <FieldError>{refresh.error}</FieldError> : null}
      {data && !data.storageDurable ? (
        <Alert variant="destructive">
          <AlertDescription>
            插件未确认资料已持久保存，请检查插件存储状态。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="search-field min-w-48 flex-1">
          <Search aria-hidden="true" />
          <Input
            aria-label="搜索邮箱"
            placeholder="搜索邮箱或备注"
            maxLength={254}
            value={state.params.query ?? ''}
            onChange={(event) => selectPage({ query: event.target.value, page: 1 })}
          />
        </div>
        <LabeledSelect
          ariaLabel="筛选邮箱状态"
          value={state.params.status ?? 'all'}
          options={[
            { value: 'all', label: '全部状态' },
            ...MAILBOX_STATUSES.map((value) => ({
              value,
              label: STATUS_LABELS[value],
            })),
          ]}
          onValueChange={(value) => {
            if (value === 'all') selectPage({ page: 1 }, true)
            else {
              const status = MAILBOX_STATUSES.find((status) => status === value)
              if (status) selectPage({ status, page: 1 })
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!selected.length || refresh.busy}
          onClick={() => requestRefresh(selected.map((account) => account.id))}
        >
          <RefreshCw data-icon="inline-start" />
          {refresh.busy ? '排队中…' : '刷新所选 token'}
        </Button>
        <span className="text-xs text-muted-foreground">已选 {selected.length}</span>
        {selected.length ? (
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            清空选择
          </Button>
        ) : null}
      </div>

      <div className="space-table-panel min-w-0" aria-busy={state.loading}>
        <Table aria-label="邮箱列表">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="全选当前页邮箱"
                  disabled={!items.length}
                  checked={allSelected ? true : selected.length ? 'indeterminate' : false}
                  onCheckedChange={(checked) =>
                    setSelectedIds(
                      checked === true
                        ? new Set(items.map((account) => account.id))
                        : new Set(),
                    )
                  }
                />
              </TableHead>
              <TableHead>邮箱 / 备注</TableHead>
              <TableHead>通道</TableHead>
              <TableHead>刷新状态</TableHead>
              <TableHead>最近成功刷新</TableHead>
              <TableHead>Token 到期</TableHead>
              <TableHead>下次刷新</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((account) => (
              <TableRow
                key={account.id}
                data-state={selectedIds.has(account.id) ? 'selected' : undefined}
              >
                <TableCell>
                  <Checkbox
                    aria-label={`选择邮箱 ${account.email}`}
                    checked={selectedIds.has(account.id)}
                    onCheckedChange={(checked) =>
                      setSelectedIds((current) => {
                        const next = new Set(current)
                        if (checked === true) next.add(account.id)
                        else next.delete(account.id)
                        return next
                      })
                    }
                  />
                </TableCell>
                <TableCell>
                  <span
                    className="block max-w-64 truncate font-medium"
                    title={account.email}
                  >
                    {account.email}
                  </span>
                  {account.note ? (
                    <span
                      className="block max-w-64 truncate text-xs text-muted-foreground"
                      title={account.note}
                    >
                      {account.note}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {account.transport === 'graph' ? 'Graph' : 'IMAP'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      account.status === 'error' || account.status === 'reauth-required'
                        ? 'destructive'
                        : 'secondary'
                    }
                  >
                    {account.refreshing ? '刷新中' : STATUS_LABELS[account.status]}
                  </Badge>
                  {account.lastError ? (
                    <span
                      className="block max-w-48 truncate text-xs text-destructive"
                      title={account.lastError}
                    >
                      {account.lastError}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {formatMailTime(account.lastRefreshedAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {formatMailTime(account.accessExpiresAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {formatMailTime(account.nextRefreshAt)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`读取 ${account.email} 的邮件`}
                      disabled={!account.enabled}
                      onClick={() => setReading(account)}
                    >
                      <Mail />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`刷新 ${account.email} 的 token`}
                      disabled={refresh.busy || account.refreshing || !account.enabled}
                      onClick={() => requestRefresh([account.id])}
                    >
                      <RefreshCw />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`编辑邮箱 ${account.email}`}
                      onClick={() => {
                        setReading(null)
                        setEditing({ account })
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`删除邮箱 ${account.email}`}
                      onClick={() => {
                        setReading(null)
                        setRemoving(account)
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!items.length ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <Empty className="p-4">
                    <EmptyHeader>
                      <EmptyTitle>
                        {state.loading
                          ? '正在读取邮箱…'
                          : state.error && !data
                            ? '列表尚未加载'
                            : state.params.query || state.params.status
                              ? '没有匹配的邮箱'
                              : '还没有邮箱'}
                      </EmptyTitle>
                      <EmptyDescription>
                        {state.error && !data
                          ? '请点击刷新列表重试。'
                          : '可新增邮箱或批量导入微软邮箱资料。'}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          共 {data?.total ?? '—'} 个邮箱 · 第 {page} / {pages} 页 · 状态每 5 秒更新
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <LabeledSelect
            ariaLabel="每页邮箱数"
            value={String(pageSize)}
            options={[
              { value: '20', label: '20 条 / 页' },
              { value: '50', label: '50 条 / 页' },
            ]}
            onValueChange={(value) => {
              if (value === '20' || value === '50')
                selectPage({ pageSize: Number(value) as 20 | 50, page: 1 })
            }}
          />
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="上一页邮箱"
            disabled={state.loading || page <= 1}
            onClick={() => selectPage({ page: page - 1 })}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="下一页邮箱"
            disabled={state.loading || !data || page >= pages}
            onClick={() => selectPage({ page: page + 1 })}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      {editing ? (
        <MailboxEditor
          account={editing.account}
          onClose={() => setEditing(null)}
          onSaved={changed}
        />
      ) : null}
      {importing ? (
        <ImportMailboxesDialog onClose={() => setImporting(false)} onImported={changed} />
      ) : null}
      {settingsOpen ? (
        <RefreshSettingsDialog
          onClose={() => setSettingsOpen(false)}
          onSaved={() => resource.invalidate()}
        />
      ) : null}
      {removing ? (
        <RemoveMailboxDialog
          account={removing}
          onClose={() => setRemoving(null)}
          onRemoved={changed}
        />
      ) : null}
      {currentReader ? (
        <MailReader
          key={JSON.stringify([
            currentReader.id,
            currentReader.email,
            currentReader.transport,
            currentReader.clientId,
          ])}
          account={currentReader}
          onClose={() => setReading(null)}
        />
      ) : null}
    </section>
  )
}
