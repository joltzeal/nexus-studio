import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  Copy,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Trash2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import {
  listPlugins,
  pluginHostAvailable,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { PluginGate } from '@/features/plugins/plugin-gate'
import { NumberPoolPicker } from '@/features/sim8/number-picker'
import {
  downloadTemplate,
  importAccounts,
  listAccounts,
  readOtp,
  removeAccount,
  saveAccount,
} from './api'
import {
  ACCOUNT_STATUSES,
  ACCOUNTS_PLUGIN_ID,
  EMPTY_ACCOUNT,
  LOGIN_METHODS,
  LOGIN_METHOD_LABELS,
  STATUS_LABELS,
  message,
  statusVariant,
  windowCountText,
  type Account,
  type AccountInput,
  type AccountList,
  type ImportReport,
  type LoginMethod,
  type OtpResult,
} from './types'

/** Mirrors the host's 1 MiB message cap; a spreadsheet beyond this needs a split. */
const MAX_IMPORT_BYTES = 512 * 1024

export interface AccountsPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
}

export function AccountsPage({ plugin, hostAvailable }: AccountsPageProps) {
  const running = plugin !== null && plugin.state === 'running'
  const [data, setData] = useState<AccountList | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ account: Account | null } | null>(null)
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState<Account | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Codes live for a few minutes; keeping the last read on screen beats a toast
  // that disappears before the user has typed the digits into Vinted.
  const [codes, setCodes] = useState<Record<string, OtpResult>>({})
  const [otpBusy, setOtpBusy] = useState<string | null>(null)
  const [otpView, setOtpView] = useState<{
    account: Account
    result: OtpResult
  } | null>(null)

  const load = useCallback(async () => {
    const result = await listAccounts()
    setData(result)
  }, [])

  useEffect(() => {
    if (!running) return
    let active = true
    void listAccounts().then(
      (result) => {
        if (active) {
          setData(result)
          setError(null)
        }
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running])

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
  const visible = accounts.filter((account) =>
    `${account.account} ${account.note} ${account.phone}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  // The column only exists when at least one account can actually fetch a code.
  const hasOtpLinks = accounts.some(
    (account) => account.emailOtpUrl !== '' || account.smsOtpUrl !== '',
  )

  async function fetchCode(account: Account, channel: 'email' | 'sms') {
    const key = `${account.id}:${channel}`
    setOtpBusy(key)
    try {
      const result = await readOtp(account.id, channel)
      setCodes((current) => ({ ...current, [account.id]: result }))
      // The dialog is the answer to the click, whether or not a code was found:
      // it shows the digits or the reason there are none, plus the raw body.
      setOtpView({ account, result })
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setOtpBusy(null)
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
          <div className="collection-toolbar">
            <span className="result-count">{visible.length} 个账号</span>
            <div className="search-field">
              <Search aria-hidden="true" />
              <Input
                aria-label="搜索账号"
                placeholder="搜索账号、手机号或备注"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
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
                  <TableHead>账号</TableHead>
                  <TableHead>登录方式</TableHead>
                  <TableHead>手机号</TableHead>
                  {hasOtpLinks ? <TableHead>验证码</TableHead> : null}
                  <TableHead>状态</TableHead>
                  <TableHead>关联窗口</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell>
                      <span className="account-identity">
                        <strong>{account.account}</strong>
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
                      {account.phone === '' ? (
                        '—'
                      ) : (
                        <span className="account-identity">
                          <span>{account.phone}</span>
                          <CopyButton
                            value={account.phone}
                            label={`复制 ${account.account} 的手机号`}
                            done="手机号已复制"
                          />
                        </span>
                      )}
                    </TableCell>
                    {hasOtpLinks ? (
                      <TableCell>
                        <OtpCell
                          account={account}
                          state={codes[account.id] ?? null}
                          busy={otpBusy}
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
                          onClick={() => setEditing({ account })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`删除 ${account.account}`}
                          onClick={() => setRemoving(account)}
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
                      ? '调整搜索条件。'
                      : '新增单个账号，或从表格文件导入。'}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
          </div>
        </>
      )}

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
            onSave={async (input) => {
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
                onClick={(event) => {
                  event.preventDefault()
                  const target = removing
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
  onFetch,
}: {
  account: Account
  state: OtpResult | null
  busy: string | null
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
              disabled={busy !== null}
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

function AccountEditor({
  account,
  onSave,
  onCancel,
}: {
  account: Account | null
  onSave: (input: AccountInput) => Promise<void>
  onCancel: () => void
}) {
  const [input, setInput] = useState<AccountInput>(() =>
    account === null
      ? { ...EMPTY_ACCOUNT }
      : {
          id: account.id,
          loginMethod: account.loginMethod,
          account: account.account,
          password: account.password,
          phone: account.phone,
          emailOtpUrl: account.emailOtpUrl,
          smsOtpUrl: account.smsOtpUrl,
          note: account.note,
          status: account.status,
          homepageUrl: account.homepageUrl,
        },
  )
  const [revealed, setRevealed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function patch(changes: Partial<AccountInput>) {
    setInput((current) => ({ ...current, ...changes }))
    setError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (input.account.trim() === '') {
      setError('请填写账号。')
      return
    }
    if (input.password === '') {
      setError('请填写密码。')
      return
    }
    setPending(true)
    setError(null)
    try {
      await onSave({ ...input, account: input.account.trim() })
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <DialogContent className="window-editor">
      <DialogHeader>
        <DialogTitle>{account ? '编辑账号' : '新增账号'}</DialogTitle>
        <DialogDescription>
          {account
            ? '登录方式与账密是必填项。'
            : '登录方式与账密是必填项，其余可以留空。'}
        </DialogDescription>
      </DialogHeader>
      <form
        id="account-form"
        className="window-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="grid gap-3">
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="account-method">登录方式</FieldLabel>
              <Select
                value={input.loginMethod}
                disabled={pending}
                onValueChange={(value) => {
                  if (LOGIN_METHODS.includes(value as LoginMethod)) {
                    patch({ loginMethod: value as LoginMethod })
                  }
                }}
              >
                <SelectTrigger id="account-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOGIN_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {LOGIN_METHOD_LABELS[method]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="account-status">账号状态</FieldLabel>
              <Select
                value={input.status}
                disabled={pending}
                onValueChange={(value) => {
                  if (ACCOUNT_STATUSES.includes(value as Account['status'])) {
                    patch({ status: value as Account['status'] })
                  }
                }}
              >
                <SelectTrigger id="account-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="account-name">账号</FieldLabel>
            <Input
              id="account-name"
              autoFocus
              maxLength={190}
              disabled={pending}
              placeholder="邮箱或用户名"
              value={input.account}
              onChange={(event) => patch({ account: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="account-password">密码</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="account-password"
                type={revealed ? 'text' : 'password'}
                maxLength={190}
                autoComplete="off"
                disabled={pending}
                value={input.password}
                onChange={(event) => patch({ password: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={revealed ? '隐藏密码' : '显示密码'}
                onClick={() => setRevealed((current) => !current)}
              >
                {revealed ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </Field>
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="account-phone">手机号</FieldLabel>
              <div className="sim8-phone-field">
                <Input
                  id="account-phone"
                  maxLength={40}
                  disabled={pending}
                  value={input.phone}
                  onChange={(event) => patch({ phone: event.target.value })}
                />
                <NumberPoolPicker
                  disabled={pending}
                  ariaLabel="从号码池选择手机号和接码链接"
                  onPick={(number) => patch({ phone: number.tel, smsOtpUrl: number.api })}
                />
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="account-homepage">主页链接</FieldLabel>
              <Input
                id="account-homepage"
                maxLength={2048}
                disabled={pending}
                placeholder="https://www.vinted.fr/member/…"
                value={input.homepageUrl}
                onChange={(event) => patch({ homepageUrl: event.target.value })}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="account-email-otp">邮箱接码地址</FieldLabel>
            <Input
              id="account-email-otp"
              maxLength={2048}
              disabled={pending}
              placeholder="接收邮箱验证码的接口地址"
              value={input.emailOtpUrl}
              onChange={(event) => patch({ emailOtpUrl: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="account-sms-otp">手机接码地址</FieldLabel>
            <Input
              id="account-sms-otp"
              maxLength={2048}
              disabled={pending}
              placeholder="接收短信验证码的接口地址"
              value={input.smsOtpUrl}
              onChange={(event) => patch({ smsOtpUrl: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="account-note">备注</FieldLabel>
            <Input
              id="account-note"
              maxLength={200}
              disabled={pending}
              value={input.note}
              onChange={(event) => patch({ note: event.target.value })}
            />
          </Field>
          {error ? <FieldError role="alert">{error}</FieldError> : null}
        </div>
      </form>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" form="account-form" disabled={pending}>
          {pending ? '正在保存…' : '保存账号'}
        </Button>
      </DialogFooter>
    </DialogContent>
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
