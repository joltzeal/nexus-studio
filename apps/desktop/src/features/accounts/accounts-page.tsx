import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Mail,
  PanelsTopLeft,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Trash2,
  Unlink,
  Upload,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
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
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import {
  listPlugins,
  pluginHostAvailable,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { PluginGate } from '@/features/plugins/plugin-gate'
import { updateContact } from '@/features/sim8/accounts-bridge'
import { BatchWindowDialog } from '@/features/spaces/batch-window-dialog'
import { MAX_BATCH_WINDOWS, type BatchAccount } from '@/features/spaces/window-batch'
import { toggleSelection } from '@/features/spaces/transfer-state'
import { nativeProfilesAvailable } from '@/lib/platform/native-profiles'
import { AccountEditor } from './account-editor'
import {
  ACCOUNT_PAGE_SIZES,
  EMPTY_ACCOUNT_FILTERS,
  filterAccounts,
  formatAccountCreatedAt,
  paginateAccounts,
  type AccountFilters,
  type AccountPageSize,
} from './account-table'
import {
  downloadTemplate,
  importAccounts,
  listAccounts,
  readOtp,
  removeAccount,
  saveAccount,
} from './api'
import {
  ACCOUNTS_PLUGIN_ID,
  ACCOUNT_STATUSES,
  LOGIN_METHODS,
  LOGIN_METHOD_LABELS,
  STATUS_LABELS,
  message,
  statusVariant,
  windowCountText,
  type Account,
  type AccountList,
  type ImportReport,
  type OtpResult,
} from './types'

/** Mirrors the host's 1 MiB message cap; a spreadsheet beyond this needs a split. */
const MAX_IMPORT_BYTES = 512 * 1024

export interface AccountsPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
}

export function AccountsPage({ plugin, hostAvailable }: AccountsPageProps) {
  const running = hostAvailable && plugin !== null && plugin.state === 'running'
  const [data, setData] = useState<AccountList | null>(null)
  const [filters, setFilters] = useState<AccountFilters>({ ...EMPTY_ACCOUNT_FILTERS })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<AccountPageSize>(20)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchAccounts, setBatchAccounts] = useState<BatchAccount[] | null>(null)
  const [editing, setEditing] = useState<{ account: Account | null } | null>(null)
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState<Account | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unlinkingPhones, setUnlinkingPhones] = useState<Set<string>>(() => new Set())
  const phoneUnlinkRequests = useRef(new Set<string>())
  const listReadSequence = useRef(0)
  const contactRevision = useRef(0)
  const contactSnapshots = useRef(
    new Map<string, { revision: number; account: Account }>(),
  )
  // Codes live for a few minutes; keeping the last read on screen beats a toast
  // that disappears before the user has typed the digits into Vinted.
  const [codes, setCodes] = useState<Record<string, OtpResult>>({})
  const [otpBusy, setOtpBusy] = useState<string | null>(null)
  const otpRequest = useRef<{ key: string } | null>(null)
  const [otpView, setOtpView] = useState<{
    account: Account
    result: OtpResult
  } | null>(null)

  const applyList = useCallback((result: AccountList, contactsAtStart: number) => {
    const items = result.items.map((account) => {
      const saved = contactSnapshots.current.get(account.id)
      return saved && saved.revision > contactsAtStart ? saved.account : account
    })
    // Preserve the full list's deletions, additions and bindings while applying
    // contact saves that completed during this read. Never reinsert absent rows.
    setData({ ...result, items })
    const available = new Set(items.map((account) => account.id))
    setSelectedIds((current) => new Set([...current].filter((id) => available.has(id))))
    // Older reads are superseded; future reads start after these successful saves.
    contactSnapshots.current.clear()
  }, [])

  const load = useCallback(async () => {
    const sequence = ++listReadSequence.current
    const contactsAtStart = contactRevision.current
    const result = await listAccounts()
    if (sequence !== listReadSequence.current) return
    applyList(result, contactsAtStart)
  }, [applyList])

  useEffect(() => {
    if (!running) return
    let active = true
    const sequence = ++listReadSequence.current
    const contactsAtStart = contactRevision.current
    void listAccounts().then(
      (result) => {
        if (active && sequence === listReadSequence.current) {
          applyList(result, contactsAtStart)
          setError(null)
        }
      },
      (cause: unknown) => {
        if (active && sequence === listReadSequence.current) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running, applyList])

  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      await load()
      setError(null)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setRefreshing(false)
    }
  }

  const accounts = data?.items ?? []
  const bindings = data?.bindings ?? []
  const visible = filterAccounts(accounts, bindings, filters)
  const pagination = paginateAccounts(visible, page, pageSize)
  if (pagination.page !== page) setPage(pagination.page)
  const selected = accounts.filter((account) => selectedIds.has(account.id))
  const allPageSelected =
    pagination.items.length > 0 &&
    pagination.items.every((account) => selectedIds.has(account.id))
  const somePageSelected = pagination.items.some((account) => selectedIds.has(account.id))
  // The column only exists when at least one account can actually fetch a code.
  const hasOtpLinks = accounts.some(
    (account) => account.emailOtpUrl !== '' || account.smsOtpUrl !== '',
  )

  function patchFilters(patch: Partial<AccountFilters>) {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(1)
  }

  async function unlinkPhone(accountId: string) {
    if (
      !running ||
      phoneUnlinkRequests.current.has(accountId) ||
      editing?.account?.id === accountId ||
      removing?.id === accountId
    )
      return
    phoneUnlinkRequests.current.add(accountId)
    setUnlinkingPhones(new Set(phoneUnlinkRequests.current))
    // Invalidate the request identity, so a late response or finally handler
    // cannot restore the old SMS code/dialog or clear a newer request's busy state.
    if (otpRequest.current?.key === `${accountId}:sms`) {
      otpRequest.current = null
      setOtpBusy(null)
    }
    setOtpView((current) =>
      current?.account.id === accountId && current.result.channel === 'sms'
        ? null
        : current,
    )
    try {
      const saved = await updateContact(accountId, { phone: '', smsOtpUrl: '' })
      contactSnapshots.current.set(saved.id, {
        revision: ++contactRevision.current,
        account: saved,
      })
      setData((current) =>
        current
          ? {
              ...current,
              items: current.items.map((account) =>
                account.id === saved.id ? saved : account,
              ),
            }
          : current,
      )
      setCodes((current) => {
        if (current[accountId]?.channel !== 'sms') return current
        const next = { ...current }
        delete next[accountId]
        return next
      })
      toast.success('手机号与短信接码链接已解绑')
    } catch (cause) {
      toast.error(`解绑手机号失败：${message(cause)}`)
    } finally {
      phoneUnlinkRequests.current.delete(accountId)
      setUnlinkingPhones(new Set(phoneUnlinkRequests.current))
    }
  }

  async function fetchCode(account: Account, channel: 'email' | 'sms') {
    if (
      !running ||
      otpRequest.current ||
      (channel === 'sms' && phoneUnlinkRequests.current.has(account.id))
    )
      return
    const key = `${account.id}:${channel}`
    const request = { key }
    otpRequest.current = request
    setOtpBusy(key)
    try {
      const result = await readOtp(account.id, channel)
      if (otpRequest.current !== request) return
      setCodes((current) => ({ ...current, [account.id]: result }))
      // The dialog is the answer to the click, whether or not a code was found:
      // it shows the digits or the reason there are none, plus the raw body.
      setOtpView({ account, result })
    } catch (cause) {
      if (otpRequest.current === request) toast.error(message(cause))
    } finally {
      if (otpRequest.current === request) {
        otpRequest.current = null
        setOtpBusy(null)
      }
    }
  }

  return (
    <section className="collection-page page-reveal" aria-labelledby="accounts-heading">
      <div className="section-intro">
        <h1 className="page-heading" id="accounts-heading">
          Vinted 账号
        </h1>
        <div className="section-actions">
          <Button
            variant="ghost"
            disabled={!running || refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw
              data-icon="inline-start"
              className={refreshing ? 'animate-spin' : undefined}
            />
            刷新
          </Button>
          <Button
            variant="outline"
            disabled={!running}
            onClick={() => setImporting(true)}
          >
            <Upload data-icon="inline-start" />
            导入
          </Button>
          <Button
            disabled={!running}
            onClick={() => {
              setError(null)
              setEditing({ account: null })
            }}
          >
            <Plus data-icon="inline-start" />
            新增账号
          </Button>
        </div>
      </div>

      {error === null ? null : <FieldError role="alert">{error}</FieldError>}

      {!running ? (
        <PluginGate label="Vinted 账号" hostAvailable={hostAvailable} plugin={plugin} />
      ) : (
        <>
          <div className="collection-toolbar accounts-toolbar">
            <span className="result-count">{visible.length} 个账号</span>
            <span className="result-count">已选 {selected.length}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!nativeProfilesAvailable() || !selected.length}
              onClick={() => {
                if (selected.length > MAX_BATCH_WINDOWS) {
                  toast.error(`每批最多选择 ${MAX_BATCH_WINDOWS} 个账号。`)
                  return
                }
                setBatchAccounts(
                  selected.map((account) => ({
                    id: account.id,
                    label: account.account,
                  })),
                )
              }}
            >
              <PanelsTopLeft data-icon="inline-start" />
              批量创建窗口
            </Button>
            {selected.length ? (
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                清空选择
              </Button>
            ) : null}
          </div>
          <div className="accounts-filters">
            <div className="search-field">
              <Search aria-hidden="true" />
              <Input
                aria-label="搜索账号"
                placeholder="搜索账号、手机号或备注"
                value={filters.query}
                onChange={(event) => patchFilters({ query: event.target.value })}
              />
            </div>
            <LabeledSelect
              ariaLabel="筛选账号状态"
              value={filters.status}
              options={[
                { value: 'all', label: '全部状态' },
                ...ACCOUNT_STATUSES.map((status) => ({
                  value: status,
                  label: STATUS_LABELS[status],
                })),
              ]}
              onValueChange={(status) => {
                if (
                  status === 'all' ||
                  ACCOUNT_STATUSES.some((value) => value === status)
                ) {
                  patchFilters({ status: status as AccountFilters['status'] })
                }
              }}
            />
            <LabeledSelect
              ariaLabel="筛选登录方式"
              value={filters.loginMethod}
              options={[
                { value: 'all', label: '全部登录方式' },
                ...LOGIN_METHODS.map((loginMethod) => ({
                  value: loginMethod,
                  label: LOGIN_METHOD_LABELS[loginMethod],
                })),
              ]}
              onValueChange={(loginMethod) => {
                if (
                  loginMethod === 'all' ||
                  LOGIN_METHODS.some((value) => value === loginMethod)
                ) {
                  patchFilters({
                    loginMethod: loginMethod as AccountFilters['loginMethod'],
                  })
                }
              }}
            />
            <LabeledSelect
              ariaLabel="筛选手机号"
              value={filters.phone}
              options={[
                { value: 'all', label: '全部手机号' },
                { value: 'with', label: '有手机号' },
                { value: 'without', label: '无手机号' },
              ]}
              onValueChange={(phone) => {
                if (phone === 'all' || phone === 'with' || phone === 'without') {
                  patchFilters({ phone })
                }
              }}
            />
            <LabeledSelect
              ariaLabel="筛选窗口关联"
              value={filters.binding}
              options={[
                { value: 'all', label: '全部关联状态' },
                { value: 'bound', label: '已关联窗口' },
                { value: 'unbound', label: '未关联窗口' },
              ]}
              onValueChange={(binding) => {
                if (binding === 'all' || binding === 'bound' || binding === 'unbound') {
                  patchFilters({ binding })
                }
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters({ ...EMPTY_ACCOUNT_FILTERS })
                setPage(1)
              }}
            >
              重置筛选
            </Button>
          </div>
          <div className="space-table-panel">
            <div className="panel-heading">
              <h2>账号池</h2>
              <Badge variant="secondary">{accounts.length}</Badge>
              <span>{bindings.length} 个窗口已关联</span>
            </div>
            <Table aria-label="账号列表">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="全选当前页账号"
                      disabled={!pagination.items.length}
                      checked={
                        allPageSelected
                          ? true
                          : somePageSelected
                            ? 'indeterminate'
                            : false
                      }
                      onCheckedChange={(checked) =>
                        setSelectedIds((current) =>
                          toggleSelection(
                            current,
                            pagination.items.map((account) => account.id),
                            checked === true,
                          ),
                        )
                      }
                    />
                  </TableHead>
                  <TableHead>账号</TableHead>
                  <TableHead>登录方式</TableHead>
                  <TableHead>手机号</TableHead>
                  {hasOtpLinks ? <TableHead>验证码</TableHead> : null}
                  <TableHead>状态</TableHead>
                  <TableHead>关联窗口</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagination.items.map((account) => (
                  <TableRow
                    key={account.id}
                    data-state={selectedIds.has(account.id) ? 'selected' : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        aria-label={`选择账号 ${account.account}`}
                        checked={selectedIds.has(account.id)}
                        onCheckedChange={(checked) =>
                          setSelectedIds((current) =>
                            toggleSelection(current, [account.id], checked === true),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <span className="account-identity">
                        <strong
                          className={cn(
                            account.status === 'blocked' && 'text-destructive',
                          )}
                        >
                          {account.account}
                        </strong>
                        <CopyButton
                          value={account.account}
                          label={`复制 ${account.account}`}
                          done="账号已复制"
                        />
                      </span>
                      <small className="block text-muted-foreground">
                        {account.note || account.homepageUrl || '—'}
                      </small>
                    </TableCell>
                    <TableCell>{LOGIN_METHOD_LABELS[account.loginMethod]}</TableCell>
                    <TableCell>
                      {account.phone.trim() === '' ? (
                        '—'
                      ) : (
                        <span className="account-identity">
                          <span>{account.phone}</span>
                          <CopyButton
                            value={account.phone}
                            label={`复制 ${account.account} 的手机号`}
                            done="手机号已复制"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`解绑 ${account.account} 的手机号`}
                            aria-busy={unlinkingPhones.has(account.id)}
                            title="清空此账号的手机号和短信接码链接，同步所有关联窗口；保留 SIM8 号码池"
                            disabled={!running || unlinkingPhones.has(account.id)}
                            onClick={() => void unlinkPhone(account.id)}
                          >
                            {unlinkingPhones.has(account.id) ? (
                              <Loader2 className="animate-spin" aria-hidden="true" />
                            ) : (
                              <Unlink aria-hidden="true" />
                            )}
                          </Button>
                        </span>
                      )}
                    </TableCell>
                    {hasOtpLinks ? (
                      <TableCell>
                        <OtpCell
                          account={account}
                          state={codes[account.id] ?? null}
                          busy={otpBusy}
                          smsDisabled={unlinkingPhones.has(account.id)}
                          onFetch={(channel) => void fetchCode(account, channel)}
                        />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <Badge variant={statusVariant(account.status)}>
                        {STATUS_LABELS[account.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>{windowCountText(bindings, account.id)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatAccountCreatedAt(account.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="table-actions">
                        <CopyButton
                          value={account.password}
                          label={`复制 ${account.account} 的密码`}
                          done="密码已复制"
                          size="icon"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`编辑 ${account.account}`}
                          disabled={unlinkingPhones.has(account.id)}
                          onClick={() => {
                            if (!phoneUnlinkRequests.current.has(account.id)) {
                              setEditing({ account })
                            }
                          }}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`删除 ${account.account}`}
                          disabled={unlinkingPhones.has(account.id)}
                          onClick={() => {
                            if (!phoneUnlinkRequests.current.has(account.id)) {
                              setRemoving(account)
                            }
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {visible.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>
                    {accounts.length ? '没有找到账号' : '还没有账号'}
                  </EmptyTitle>
                  <EmptyDescription>
                    {accounts.length
                      ? '调整搜索或筛选条件。'
                      : '新增单个账号，或从表格文件导入。'}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            <div className="accounts-pagination">
              <span className="result-count" role="status" aria-live="polite">
                共 {pagination.total} 个账号 · 第 {pagination.page} /{' '}
                {pagination.pageCount} 页
              </span>
              <div className="accounts-pagination-controls">
                <LabeledSelect
                  ariaLabel="每页账号数"
                  value={String(pageSize)}
                  options={ACCOUNT_PAGE_SIZES.map((size) => ({
                    value: String(size),
                    label: `每页 ${size}`,
                  }))}
                  onValueChange={(value) => {
                    const size = ACCOUNT_PAGE_SIZES.find(
                      (entry) => String(entry) === value,
                    )
                    if (size === undefined) return
                    setPageSize(size)
                    setPage(1)
                  }}
                />
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="上一页"
                  disabled={pagination.page === 1}
                  onClick={() => setPage(Math.max(1, pagination.page - 1))}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="下一页"
                  disabled={pagination.page === pagination.pageCount}
                  onClick={() =>
                    setPage(Math.min(pagination.pageCount, pagination.page + 1))
                  }
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {batchAccounts ? (
        <BatchWindowDialog
          accounts={batchAccounts}
          onClose={() => setBatchAccounts(null)}
          onSettled={async (items) => {
            const completedIds = new Set(
              items.flatMap((item) =>
                item.status === 'complete' && item.account ? [item.account.id] : [],
              ),
            )
            setSelectedIds(
              (current) => new Set([...current].filter((id) => !completedIds.has(id))),
            )
            await load()
          }}
        />
      ) : null}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        {editing !== null ? (
          <AccountEditor
            key={editing.account?.id ?? 'new'}
            account={editing.account}
            ready={running && !unlinkingPhones.has(editing.account?.id ?? '')}
            onSave={async (input) => {
              if (input.id && phoneUnlinkRequests.current.has(input.id)) {
                throw new Error('正在解绑手机号，请稍后重试。')
              }
              await saveAccount(input)
              await load()
              toast.success(editing.account ? '账号已保存' : '账号已添加')
              setEditing(null)
            }}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={importing}
        onOpenChange={(open) => {
          if (!open) setImporting(false)
        }}
      >
        {importing ? (
          <ImportDialog
            onImported={async () => {
              await load()
            }}
            onClose={() => setImporting(false)}
          />
        ) : null}
      </Dialog>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        {removing !== null ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除账号「{removing.account}」？</AlertDialogTitle>
              <AlertDialogDescription>
                该账号与它关联的窗口会一起解除关联，删除后无法撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={unlinkingPhones.has(removing.id)}
                onClick={(event) => {
                  event.preventDefault()
                  const target = removing
                  if (phoneUnlinkRequests.current.has(target.id)) return
                  setRemoving(null)
                  void removeAccount(target.id)
                    .then(load)
                    .then(() => toast.success('账号已删除'))
                    .catch((cause: unknown) => setError(message(cause)))
                }}
              >
                删除账号
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <Dialog
        open={otpView !== null}
        onOpenChange={(open) => {
          if (!open) setOtpView(null)
        }}
      >
        {otpView === null ? null : (
          <OtpDialog
            account={otpView.account}
            result={otpView.result}
            onClose={() => setOtpView(null)}
          />
        )}
      </Dialog>
    </section>
  )
}

/**
 * One value, one click. `copyText` returns false when the clipboard is denied,
 * which is worth saying out loud rather than failing silently.
 */
function CopyButton({
  value,
  label,
  done,
  size = 'icon-xs',
}: {
  value: string
  label: string
  done: string
  /** Match the neighbours: table actions use the larger icon button. */
  size?: 'icon-xs' | 'icon'
}) {
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={label}
      title={label}
      disabled={value === ''}
      onClick={() => {
        void copyText(value).then((copied) => {
          if (copied) toast.success(done)
          else toast.error('复制失败，请检查剪贴板权限后重试。')
        })
      }}
    >
      <Copy />
    </Button>
  )
}

function readableTime(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * The click answer. A code is shown large enough to read across the room; a
 * body without one says so instead of pretending the fetch failed, and the raw
 * response is one button away because that is what makes a bad link debuggable.
 */
function OtpDialog({
  account,
  result,
  onClose,
}: {
  account: Account
  result: OtpResult
  onClose: () => void
}) {
  const [raw, setRaw] = useState(false)
  const channel = result.channel === 'email' ? '邮箱验证码' : '手机验证码'

  async function copy() {
    if (result.code === null) return
    if (await copyText(result.code)) toast.success('验证码已复制')
    else toast.error('复制失败，请检查剪贴板权限后重试。')
  }

  return (
    <DialogContent className="otp-dialog">
      <DialogHeader>
        <DialogTitle>{channel}</DialogTitle>
        <DialogDescription>
          {account.account} · {readableTime(result.fetchedAt)}
        </DialogDescription>
      </DialogHeader>
      {raw ? (
        <div className="otp-raw-wrap">
          <pre className="otp-raw">
            {result.body.trim() === '' ? '（响应体为空）' : result.body}
          </pre>
          {result.truncated ? (
            <p className="otp-hint">响应体较长，这里只显示前 64 KB。</p>
          ) : null}
        </div>
      ) : result.code === null ? (
        <div className="otp-verdict" data-tone="empty">
          <strong>还没有验证码</strong>
          <p>
            响应里没有唯一的 4 位或 6
            位数字。可能邮件或短信还没到，稍等几秒再读一次；也可以查看原文，确认这个链接到底返回了什么。
          </p>
        </div>
      ) : (
        <div className="otp-verdict" data-tone="found">
          <span className="otp-digits">{result.code}</span>
          <Button onClick={() => void copy()}>
            <Copy data-icon="inline-start" />
            复制验证码
          </Button>
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={() => setRaw((current) => !current)}>
          {raw ? '收起原文' : '查看原文'}
        </Button>
        <Button onClick={onClose}>关闭</Button>
      </DialogFooter>
    </DialogContent>
  )
}

/**
 * One cell, one or two buttons: the column only exists because an account has a
 * mailbox or phone link, so "nothing to fetch" never reaches this component.
 */
function OtpCell({
  account,
  state,
  busy,
  smsDisabled,
  onFetch,
}: {
  account: Account
  state: OtpResult | null
  busy: string | null
  smsDisabled: boolean
  onFetch: (channel: 'email' | 'sms') => void
}) {
  const channels = [
    ...(account.emailOtpUrl === ''
      ? []
      : [{ channel: 'email' as const, label: '邮箱验证码', Icon: Mail }]),
    ...(account.smsOtpUrl === ''
      ? []
      : [{ channel: 'sms' as const, label: '手机验证码', Icon: Smartphone }]),
  ]

  async function copy() {
    if (state === null || state.code === null) return
    if (state.channel === 'sms' && smsDisabled) return
    if (await copyText(state.code)) toast.success('验证码已复制')
    else toast.error('复制失败，请检查剪贴板权限后重试。')
  }

  return (
    <div className="otp-cell">
      {state === null ? null : state.code === null ? (
        <span className="otp-code" data-empty="true">
          暂无验证码
        </span>
      ) : (
        <span className="otp-code">
          <strong>{state.code}</strong>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="复制验证码"
            disabled={state.channel === 'sms' && smsDisabled}
            onClick={() => void copy()}
          >
            <Copy />
          </Button>
        </span>
      )}
      <div className="otp-actions">
        {channels.map(({ channel, label, Icon }) => {
          const pending = busy === `${account.id}:${channel}`
          return (
            <Button
              key={channel}
              variant="outline"
              size="xs"
              disabled={busy !== null || (channel === 'sms' && smsDisabled)}
              title={`从${channel === 'email' ? '邮箱' : '手机'}验证码链接读取最新验证码`}
              onClick={() => onFetch(channel)}
            >
              {pending ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Icon data-icon="inline-start" />
              )}
              {label}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function ImportDialog({
  onImported,
  onClose,
}: {
  onImported: () => Promise<void>
  onClose: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    if (file === null) {
      setError('请选择要导入的文件。')
      return
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setError(`文件超过 ${String(MAX_IMPORT_BYTES / 1024)} KB，请拆分后再导入。`)
      return
    }
    setPending(true)
    setError(null)
    try {
      const text = await file.text()
      const binary = /\.(csv|txt)$/i.test(file.name)
      const result = binary
        ? await importAccounts(file.name, { text })
        : await importAccounts(file.name, {
            base64: toBase64(new Uint8Array(await file.arrayBuffer())),
          })
      setReport(result)
      await onImported()
      toast.success(`导入完成：新增 ${String(result.inserted)} 个`)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  async function download(format: 'csv' | 'xlsx') {
    setError(null)
    try {
      const template = await downloadTemplate(format)
      saveFile(template.filename, template.mimeType, template.base64)
    } catch (cause) {
      setError(message(cause))
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>导入账号</DialogTitle>
        <DialogDescription>
          支持 CSV 与 XLSX，表头可以是中文或英文。登录方式、账号、密码为必填列。
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <Field>
          <FieldLabel htmlFor="account-file">表格文件</FieldLabel>
          <Input
            id="account-file"
            type="file"
            accept=".csv,.xlsx,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={pending}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null)
              setReport(null)
              setError(null)
            }}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void download('csv')}
          >
            <Download data-icon="inline-start" />
            下载 CSV 模板
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void download('xlsx')}
          >
            <Download data-icon="inline-start" />
            下载 XLSX 模板
          </Button>
        </div>
        {report === null ? null : (
          <div className="import-report" role="status">
            <p>
              共 {report.total} 行 · 新增 {report.inserted} · 更新 {report.updated} · 跳过{' '}
              {report.skipped}
            </p>
            {report.errors.length === 0 ? null : (
              <ul>
                {report.errors.map((entry) => (
                  <li key={`${String(entry.row)}-${entry.message}`}>
                    第 {entry.row} 行：{entry.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error ? <FieldError role="alert">{error}</FieldError> : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          关闭
        </Button>
        <Button disabled={pending || file === null} onClick={() => void run()}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : null}
          {pending ? '正在导入…' : '开始导入'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function saveFile(filename: string, mimeType: string, base64: string): void {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function AccountsRoute() {
  const hostAvailable = pluginHostAvailable()
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!hostAvailable) return
    try {
      const catalog = await listPlugins()
      setPlugin(catalog.find((entry) => entry.id === ACCOUNTS_PLUGIN_ID) ?? null)
    } catch (cause) {
      setError(message(cause))
    }
  }, [hostAvailable])

  useEffect(() => {
    if (!hostAvailable) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) {
          setPlugin(catalog.find((entry) => entry.id === ACCOUNTS_PLUGIN_ID) ?? null)
        }
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [hostAvailable])

  // The host has no push channel: keep looking while the process is coming up.
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
      <AccountsPage plugin={plugin} hostAvailable={hostAvailable} />
    </>
  )
}
