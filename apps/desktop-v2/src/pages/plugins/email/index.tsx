import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertModal,
  Button,
  DataList,
  DialogModal,
  EmptyState,
  Input,
  Modal,
  Select,
  Textarea,
  type DataListColumn,
} from '@proxyshard/shardx-ui-kit'
import { PageHeader } from '../../../widgets/PageHeader/PageHeader'
import { PluginFilterRow, PluginSearch } from '../PluginFilterRow'
import { PluginWorkspace } from '../PluginWorkspace'
import { ListColumn } from '../../../shared/ui/ListColumn'
import {
  DeleteIcon,
  EditIcon,
  CheckCircleIcon,
  KeyIcon,
  ReadMailIcon,
  ReceiveMailIcon,
  RefreshIcon,
  SyncIcon,
} from '../../../shared/icons'
import { PluginRowAction } from '../PluginRowAction'
import { toast } from '../../../shared/model/toast'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import {
  EMAIL_PLUGIN_ID,
  type MailboxPageSize,
  type MailboxView,
  type MailboxInput,
  type MailboxStatus,
  type MailboxIdentity,
} from '../../../raccoon/plugins/email/model'
import { readMailboxImportFile } from '../../../raccoon/plugins/email/bulk'
import { emailApi, supportsEmailBase } from '../../../raccoon/plugins/email/api'
import { mailboxUnread } from '../../../raccoon/plugins/email/graph-read-state'
import { markAllMailboxRead } from '../../../raccoon/plugins/email/mark-all-read'
import { formatMailTime, STATUS_LABELS } from '../../../raccoon/plugins/email/model'
import { MailboxForm } from './MailboxForm'
import { AuthorizationDialog } from './AuthorizationDialog'
import { MailReader } from './MailReader'
import { EmailSettings } from './EmailSettings'
import { BulkAccountsDialog } from './BulkAccountsDialog'
import { MailboxRelationDialog } from '../vinted-accounts/MailboxRelationDialog'
import {
  supportsAccountBase,
  supportsAccountOptional,
} from '../../../raccoon/plugins/vinted-accounts/api'
import { usePluginTask } from '../usePluginTask'

export function EmailPage({ onManage }: { onManage: () => void }) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === EMAIL_PLUGIN_ID),
  )
  const compatible = supportsEmailBase(plugin) && isNativeRaccoon()
  const accountPlugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.vinted-accounts'),
  )
  const canAssociate =
    supportsAccountBase(accountPlugin) &&
    supportsAccountOptional(accountPlugin, 'mailbox')
  const canCreateAccounts =
    canAssociate && supportsAccountOptional(accountPlugin, 'mailboxImport')
  const canExport = emailApi.supports(plugin, 'export')
  const [linking, setLinking] = useState<MailboxView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [durable, setDurable] = useState(true)
  const task = usePluginTask()
  const reads = useRef(0)
  const [items, setItems] = useState<MailboxView[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<MailboxPageSize>(20)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<MailboxStatus | 'all'>('all')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selectionRows = useRef(new Map<string, MailboxIdentity>())
  const [exporting, setExporting] = useState<MailboxIdentity[] | null>(null)
  const exportIdentity = useRef<string | null>(null)
  const [creatingAccounts, setCreatingAccounts] = useState<MailboxIdentity[] | null>(null)
  const importRead = useRef(0)
  const importFileBusy = useRef(false)
  const [readingFile, setReadingFile] = useState(false)
  const [editing, setEditing] = useState<MailboxView | null | undefined>(undefined)
  const [removing, setRemoving] = useState<MailboxView | null>(null)
  const [reader, setReader] = useState<MailboxView | null>(null)
  const [authorizing, setAuthorizing] = useState<MailboxView | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importTransport, setImportTransport] = useState<'graph' | 'imap'>('graph')
  const [notice, setNotice] = useState<string | null>(null)
  const filters = useRef({ query, status, page, pageSize })
  useEffect(() => {
    filters.current = { query, status, page, pageSize }
  }, [query, status, page, pageSize])

  const refresh = useCallback(
    async (nextPage?: number) => {
      if (!compatible) return
      const latest = filters.current
      const request = ++reads.current
      const token = task.begin()
      setBusy(true)
      setError(null)
      try {
        const result = await emailApi.listMailboxes({
          query: latest.query,
          ...(latest.status === 'all' ? {} : { status: latest.status }),
          page: nextPage ?? latest.page,
          pageSize: latest.pageSize,
        })
        if (!task.current(token) || request !== reads.current) return
        setItems(result.items)
        setHasLoaded(true)
        setDurable(result.storageDurable)
        setTotal(result.total)
        setPage(result.page)
      } catch (cause) {
        if (task.current(token) && request === reads.current)
          setError(cause instanceof Error ? cause.message : '邮箱列表读取失败')
      } finally {
        if (task.current(token) && request === reads.current) setBusy(false)
      }
    },
    [compatible, page, pageSize, query, status],
  )
  useEffect(() => {
    void refresh(1)
    return () => {
      reads.current++
    }
  }, [query, status, pageSize, compatible])
  useEffect(() => {
    setPage(1)
  }, [query, status, pageSize])
  useEffect(() => {
    if (!compatible) return
    const timer = window.setInterval(() => {
      if (
        !document.hidden &&
        !busy &&
        !editing &&
        !importOpen &&
        !reader &&
        !authorizing &&
        !removing &&
        !linking &&
        !exporting &&
        !creatingAccounts
      )
        void refresh()
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [
    compatible,
    busy,
    editing,
    importOpen,
    reader,
    authorizing,
    removing,
    linking,
    exporting,
    creatingAccounts,
    refresh,
  ])
  const pages = Math.max(1, Math.ceil(total / pageSize))

  async function markAllRead(row: MailboxView) {
    if (!row.enabled || !task.acquire()) return
    const token = task.begin()
    reads.current++
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await markAllMailboxRead(row, emailApi, () => task.current(token))
      if (!result) return
      await refresh()
      if (!task.current(token)) return
      setNotice(`${row.email} · 已标记 ${result.updated} 封为已读${row.transport === 'graph' ? '（本机）' : ''}`)
      if (result.failed || result.incomplete.length) {
        const problems = [
          ...(result.failed ? [`${result.failed} 封未更新`] : []),
          ...result.incomplete,
        ]
        setError((previous) => [previous, ...problems].filter(Boolean).join('；'))
      }
    } catch (cause) {
      if (task.current(token))
        setError(cause instanceof Error ? cause.message : '全部已读操作失败')
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  const columns: DataListColumn<MailboxView>[] = [
    {
      id: 'email',
      header: '邮箱',
      width: 'minmax(190px,1.2fr)',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-1">
          <strong className="truncate font-medium text-text-strong-950">
            {row.email}
          </strong>
          <span className="text-micro text-text-soft-400">
            {row.transport === 'graph' ? 'Microsoft Graph' : 'OAuth IMAP'} ·{' '}
            {row.note || '无备注'}
          </span>
        </span>
      ),
    },
    {
      id: 'status',
      header: '状态',
      width: 'minmax(150px,1fr)',
      cell: (row) => (
        <span className="flex flex-col gap-1">
          <span className="text-secondary text-text-sub-600">
            {STATUS_LABELS[row.status]}
          </span>
          <span className="text-micro text-text-soft-400">
            {row.lastError ??
              row.reception.lastError ??
              (row.enabled ? '已启用' : '已暂停')}
          </span>
        </span>
      ),
    },
    {
      id: 'counts',
      header: '未读',
      width: 'minmax(110px,.8fr)',
      cell: (row) => (
        <span className="text-secondary tabular-nums text-text-sub-600">
          收件箱 {mailboxUnread(row, 'inbox') ?? '—'} · 垃圾箱{' '}
          {mailboxUnread(row, 'junkemail') ?? '—'}
        </span>
      ),
    },
    {
      id: 'checked',
      header: '最近检查',
      width: 'minmax(140px,.9fr)',
      cell: (row) => (
        <span className="flex flex-col text-secondary text-text-sub-600">
          <span>{formatMailTime(row.reception.lastCheckedAt)}</span>
          <span className="text-micro text-text-soft-400">
            下次 {formatMailTime(row.reception.nextCheckAt)}
          </span>
        </span>
      ),
    },
    {
      id: 'actions',
      header: '操作',
      width: '200px',
      cell: (row) => (
        <div className="flex items-center gap-1">
          <PluginRowAction
            label="刷新 Token"
            icon={<RefreshIcon className="size-3.5" />}
            disabled={!row.enabled || busy}
            onClick={() => void queueSelected('refresh', [row.id])}
          />
          <PluginRowAction
            label="收取新邮件"
            icon={<ReceiveMailIcon className="size-3.5" />}
            disabled={!row.enabled || busy}
            onClick={() => void queueSelected('receive', [row.id])}
          />
          <PluginRowAction
            label="读取邮件"
            icon={<ReadMailIcon className="size-3.5" />}
            disabled={!row.enabled}
            onClick={() => setReader(row)}
          />
          <PluginRowAction
            label="全部标记为已读"
            icon={<CheckCircleIcon className="size-3.5" />}
            disabled={!row.enabled || busy}
            onClick={() => void markAllRead(row)}
          />
          {canAssociate && (
            <PluginRowAction
              label="关联 Vinted 账号"
              icon={<SyncIcon className="size-3.5" />}
              disabled={busy}
              onClick={() => setLinking(row)}
            />
          )}
          {row.transport === 'graph' && (
            <PluginRowAction
              label="授权邮箱"
              icon={<KeyIcon className="size-3.5" />}
              onClick={() => setAuthorizing(row)}
            />
          )}
          <PluginRowAction
            label="编辑邮箱"
            icon={<EditIcon className="size-3.5" />}
            onClick={() => setEditing(row)}
          />
          <PluginRowAction
            label="删除邮箱"
            icon={<DeleteIcon className="size-3.5" />}
            variant="error"
            onClick={() => setRemoving(row)}
          />
        </div>
      ),
    },
  ]
  async function save(input: MailboxInput) {
    if (!task.acquire()) return
    const token = task.begin()
    reads.current++
    setBusy(true)
    setError(null)
    try {
      await emailApi.saveMailbox(input)
      if (!task.current(token)) return
      toast.saved('邮箱已保存')
      setEditing(undefined)
      await refresh()
    } catch (cause) {
      if (task.current(token))
        setError(cause instanceof Error ? cause.message : '邮箱保存失败')
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  async function remove() {
    if (!removing || !task.acquire()) return
    const token = task.begin()
    reads.current++
    setBusy(true)
    setError(null)
    try {
      await emailApi.removeMailbox(removing.id)
      if (!task.current(token)) return
      selectionRows.current.delete(removing.id)
      setSelected(new Set(selectionRows.current.keys()))
      toast.ok('邮箱已删除')
      setRemoving(null)
      await refresh()
    } catch (cause) {
      if (task.current(token))
        setError(cause instanceof Error ? cause.message : '邮箱删除失败')
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  async function importRows() {
    if (importFileBusy.current || !task.acquire()) return
    const token = task.begin()
    reads.current++
    setBusy(true)
    setError(null)
    try {
      const result = await emailApi.importMailboxes(importText, importTransport)
      if (!task.current(token)) return
      setNotice(
        `导入 ${result.total} 行 · 新增 ${result.inserted} · 跳过 ${result.skipped} · 问题明细 ${result.errors.length}${result.errors.length === 50 ? '（最多显示 50 条）' : ''}`,
      )
      setImportText('')
      setImportOpen(false)
      await refresh(1)
      if (result.errors.length)
        setError(
          result.errors.map((item) => `第 ${item.row} 行：${item.message}`).join('；'),
        )
    } catch (cause) {
      if (task.current(token))
        setError(cause instanceof Error ? cause.message : '邮箱导入失败')
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  async function queueSelected(kind: 'refresh' | 'receive', ids = [...selected]) {
    if (!ids.length || !task.acquire()) return
    const token = task.begin()
    reads.current++
    setBusy(true)
    try {
      const result =
        kind === 'refresh'
          ? await emailApi.queueRefresh(ids)
          : await emailApi.queueReceive(ids)
      if (!task.current(token)) return
      setNotice(`已排队 ${result.queued} 个，跳过 ${result.skipped} 个`)
      setSelected(new Set())
      selectionRows.current.clear()
      await refresh()
    } catch (cause) {
      if (task.current(token))
        setError(cause instanceof Error ? cause.message : '任务排队失败')
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }

  async function chooseImportFile(file: File | undefined) {
    if (!file || busy) return
    const request = ++importRead.current
    const token = task.begin()
    importFileBusy.current = true
    setReadingFile(true)
    setError(null)
    try {
      const text = await readMailboxImportFile(file)
      if (task.current(token) && request === importRead.current) setImportText(text)
    } catch (cause) {
      if (task.current(token) && request === importRead.current)
        setError(cause instanceof Error ? cause.message : '文件读取失败')
    } finally {
      if (request === importRead.current) {
        importFileBusy.current = false
        if (task.current(token)) setReadingFile(false)
      }
    }
  }
  async function exportSelected() {
    if (!exporting || !canExport || !task.acquire()) return
    const token = task.begin()
    const identity = exportIdentity.current
    const isCurrent = () => {
      const current = usePluginCatalog
        .getState()
        .plugins.find((item) => item.id === EMAIL_PLUGIN_ID)
      return (
        task.current(token) &&
        supportsEmailBase(current) &&
        emailApi.supports(current, 'export') &&
        `${current?.version}:${current?.installation}:${current?.runtimeGeneration}` ===
          identity
      )
    }
    setBusy(true)
    setError(null)
    try {
      if (!isCurrent()) throw new Error('邮箱插件已变化，请关闭后重新确认导出')
      const result = await emailApi.exportMailboxes(exporting)
      if (!isCurrent()) throw new Error('邮箱插件已变化，请关闭后重新确认导出')
      for (const file of result.files) {
        const url = URL.createObjectURL(
          new Blob([file.text], { type: 'text/plain;charset=utf-8' }),
        )
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = file.filename
        try {
          anchor.click()
        } finally {
          window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        }
      }
      setExporting(null)
      setNotice(
        `已发起 ${result.total} 个邮箱的文本下载，请检查下载结果。Graph 与 IMAP 分文件保存。`,
      )
    } catch (cause) {
      if (task.current(token))
        setError(
          cause instanceof Error ? cause.message : '邮箱导出失败，请保留选择后重试',
        )
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }

  if (!compatible)
    return (
      <>
        <PageHeader
          title="邮箱管理"
          actions={
            <Button size="xsmall" mode="stroke" variant="neutral" onClick={onManage}>
              管理插件
            </Button>
          }
        />
        <PluginWorkspace>
          <EmptyState
            title={
              !isNativeRaccoon()
                ? '桌面应用中使用邮箱管理'
                : plugin?.state === 'unlicensed'
                  ? '邮箱插件需要激活'
                  : '邮箱插件尚未就绪'
            }
            hint="检查插件安装、授权、运行状态和 email.provider 方法版本"
            action={{ label: '前往插件中心', onClick: onManage }}
          />
        </PluginWorkspace>
      </>
    )
  return (
    <>
      <PageHeader
        title="邮箱管理"
        count={{ shown: items.length, total }}
        actions={
          <>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              onClick={() => setSettingsOpen(true)}
            >
              收信设置
            </Button>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy}
              leftIcon={<RefreshIcon className="size-3.5" />}
              onClick={() => void refresh()}
            >
              刷新列表
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => setImportOpen(true)}
            >
              批量导入
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => setEditing(null)}
            >
              添加邮箱
            </Button>
          </>
        }
      />
      <PluginWorkspace>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {!durable && (
            <Alert status="warning" variant="lighter">
              邮箱插件存储当前未持久化。
            </Alert>
          )}
          <PluginFilterRow label="邮箱筛选">
            <PluginSearch
              pageShortcut
              label="搜索邮箱"
              placeholder="邮箱地址或备注"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select
              className="w-[144px]!"
              label="邮箱状态"
              size="xsmall"
              value={status}
              onChange={(value) => setStatus(value as MailboxStatus | 'all')}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'active', label: '正常' },
                { value: 'pending', label: '待刷新' },
                { value: 'reauth-required', label: '需重新授权' },
                { value: 'error', label: '失败' },
                { value: 'paused', label: '已暂停' },
              ]}
            />
            <Select
              className="w-[128px]!"
              label="每页数量"
              size="xsmall"
              value={String(pageSize)}
              disabled={busy}
              onChange={(value) => {
                if (value === '20' || value === '50') setPageSize(Number(value) as MailboxPageSize)
              }}
              options={[20, 50].map((size) => ({ value: String(size), label: `${size} 条/页` }))}
            />
          </PluginFilterRow>
          <div className="flex flex-wrap items-center gap-2">
            {selected.size > 0 && (
              <>
                <span className="text-secondary text-text-soft-400">
                  已选 {selected.size} 个邮箱（跨页保留）
                </span>
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  disabled={busy}
                  onClick={() => {
                    selectionRows.current.clear()
                    setSelected(new Set())
                  }}
                >
                  清空选择
                </Button>
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  disabled={busy || !canExport || selected.size > 100}
                  onClick={() => {
                    setError(null)
                    exportIdentity.current = `${plugin?.version}:${plugin?.installation}:${plugin?.runtimeGeneration}`
                    setExporting([...selectionRows.current.values()])
                  }}
                >
                  批量导出
                </Button>
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  disabled={busy || !canCreateAccounts || selected.size > 100}
                  onClick={() => {
                    setError(null)
                    setCreatingAccounts([...selectionRows.current.values()])
                  }}
                >
                  创建 Vinted 账号
                </Button>
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  disabled={busy || selected.size > 100}
                  onClick={() => void queueSelected('refresh')}
                >
                  刷新 token
                </Button>
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  disabled={busy || selected.size > 100}
                  onClick={() => void queueSelected('receive')}
                >
                  收信
                </Button>
                {(selected.size > 100 || !canExport || !canCreateAccounts) && (
                  <span className="w-full text-secondary text-text-soft-400">
                    {selected.size > 100 && '每批最多操作 100 个邮箱，请调整选择。'}
                    {!canExport && '批量导出需要更新邮箱插件以启用导出方法。'}
                    {!canCreateAccounts &&
                      '创建账号需要已运行并授权邮箱导入方法的 Vinted 账号池插件。'}
                  </span>
                )}
              </>
            )}
          </div>
          {error && (
            <Alert status="error" variant="lighter" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {notice && (
            <Alert status="information" variant="lighter" onClose={() => setNotice(null)}>
              {notice}
            </Alert>
          )}
          <ListColumn>
            <DataList<MailboxView>
              aria-label="邮箱列表"
              items={items}
              columns={columns}
              rowHeight={60}
              getId={(row) => row.id}
              getName={(row) => row.email}
              labels={{
                selectAll: '选择当前页邮箱',
                select: (email) => `选择 ${email}`,
                more: '更多邮箱操作',
                actions: '操作',
              }}
              status={busy && !hasLoaded ? 'loading' : 'ready'}
              selected={selected}
              onSelectedChange={(ids) => {
                if (busy) return
                for (const row of items) {
                  if (ids.has(row.id))
                    selectionRows.current.set(row.id, {
                      id: row.id,
                      email: row.email,
                      enabled: row.enabled,
                    })
                  else selectionRows.current.delete(row.id)
                }
                setSelected(new Set(selectionRows.current.keys()))
              }}
              empty={
                <EmptyState title="邮箱列表为空" hint="添加邮箱或按四段资料批量导入。" />
              }
            />
          </ListColumn>
          <div className="flex items-center justify-end gap-2 text-secondary text-text-soft-400">
            <span>
              第 {page} / {pages} 页
            </span>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              disabled={busy || page <= 1}
              onClick={() => void refresh(page - 1)}
            >
              上一页
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              disabled={busy || page >= pages}
              onClick={() => void refresh(page + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      </PluginWorkspace>
      {editing !== undefined && (
        <MailboxForm
          mailbox={editing}
          busy={busy}
          error={error}
          onClose={() => setEditing(undefined)}
          onSave={(input) => void save(input)}
        />
      )}
      {removing && (
        <AlertModal
          open
          status="error"
          title="删除邮箱资料"
          description={`删除 ${removing.email} 的本机凭据并停止它的刷新、收信和阅读任务。不会从 Microsoft 远端删除邮箱。${error ? `\n${error}` : ''}`}
          confirmLabel="删除邮箱"
          isLoading={busy}
          onOpenChange={(open) => {
            if (!open && !busy) setRemoving(null)
          }}
          onConfirm={() => void remove()}
        />
      )}
      {importOpen && (
        <DialogModal
          open
          title="批量导入 Microsoft 邮箱"
          subtitle="每行格式：邮箱----密码----client_id----refresh_token。密码仅作为资料保存，不用于登录。"
          size="lg"
          isLoading={busy || readingFile}
          isDisabled={!importText.trim() || readingFile}
          confirmLabel="导入邮箱"
          onConfirm={() => void importRows()}
          onCancel={() => {
            if (!busy && !readingFile) {
              importRead.current++
              setImportOpen(false)
            }
          }}
          onOpenChange={(open) => {
            if (!open && !busy && !readingFile) {
              importRead.current++
              setImportOpen(false)
            }
          }}
        >
          <div className="flex flex-col gap-3 py-inset">
            {error && (
              <Alert status="error" variant="lighter">
                {error}
              </Alert>
            )}
            <Select
              label="收信方式"
              size="xsmall"
              value={importTransport}
              disabled={busy || readingFile}
              onChange={(value) => setImportTransport(value as 'graph' | 'imap')}
              options={[
                { value: 'graph', label: 'Microsoft Graph' },
                { value: 'imap', label: 'OAuth IMAP' },
              ]}
            />
            <Input
              inputSize="xsmall"
              label="选择 UTF-8 TXT 文件"
              type="file"
              accept=".txt,text/plain"
              disabled={busy || readingFile}
              onChange={(event) => void chooseImportFile(event.target.files?.[0])}
            />
            <Textarea
              label="四段资料"
              rows={12}
              value={importText}
              disabled={busy || readingFile}
              onChange={(event) => {
                importRead.current++
                setImportText(event.target.value)
              }}
              hint="支持换行分隔，每批最多 500 行 / 512 KiB"
            />
          </div>
        </DialogModal>
      )}
      {exporting && (
        <AlertModal
          open
          status="warning"
          title="导出邮箱凭据"
          description={`将下载明确选中的 ${exporting.length} 个邮箱的四段文本，包含邮箱密码、Client ID 和当前 Refresh token。请妥善保管下载文件。Graph 与 IMAP 分文件保存。${exporting.map((item) => `\n${item.email}`).join('')}${error ? `\n${error}` : ''}`}
          confirmLabel="确认下载含凭据文本"
          isLoading={busy}
          onConfirm={() => void exportSelected()}
          onOpenChange={(open) => {
            if (!open && !busy) setExporting(null)
          }}
        />
      )}
      {creatingAccounts && (
        <BulkAccountsDialog
          mailboxes={creatingAccounts}
          onClose={() => setCreatingAccounts(null)}
          onSuccess={(message) => {
            setNotice(message)
            setCreatingAccounts(null)
          }}
        />
      )}
      {reader && (
        <MailReader
          mailbox={reader}
          onClose={() => {
            setReader(null)
            void refresh()
          }}
        />
      )}
      {settingsOpen && (
        <Modal
          open
          title="收信与刷新设置"
          onOpenChange={(open) => {
            if (!open) setSettingsOpen(false)
          }}
        >
          <EmailSettings disabled={!compatible} />
        </Modal>
      )}
      {linking && canAssociate && (
        <MailboxRelationDialog
          mailbox={{ id: linking.id, email: linking.email, enabled: linking.enabled }}
          onClose={() => setLinking(null)}
          onSaved={() => toast.saved('账号邮箱关系已保存')}
        />
      )}
      {authorizing && (
        <AuthorizationDialog
          mailboxId={authorizing.id}
          email={authorizing.email}
          onClose={() => setAuthorizing(null)}
          onAuthorized={() => {
            setAuthorizing(null)
            void refresh()
          }}
        />
      )}
    </>
  )
}
