import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import { listProxies, removeProxy, saveProxy, setDefaultProxy } from './api'
import { message, type MonitorProxy, type ProxyInput, type ProxyList } from './types'

const APP_NETWORK = '__application__'
const SCHEMES = ['http', 'https', 'socks5', 'socks5h'] as const
export const PROXY_SETTINGS_CHANGED = 'nexus:vinted-proxies-changed'
type PasswordMode = 'keep' | 'replace' | 'clear'

export interface ProxyFormValues {
  id?: string
  name: string
  scheme: MonitorProxy['scheme']
  host: string
  port: string
  username: string
  password: string
  passwordMode: PasswordMode
  hasPassword: boolean
  enabled: boolean
}

function emptyForm(): ProxyFormValues {
  return {
    name: '',
    scheme: 'http',
    host: '',
    port: '8080',
    username: '',
    password: '',
    passwordMode: 'replace',
    hasPassword: false,
    enabled: true,
  }
}

function formOf(proxy: MonitorProxy): ProxyFormValues {
  return { ...proxy, port: String(proxy.port), password: '', passwordMode: 'keep' }
}

function normalizedHost(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('[') || trimmed.endsWith(']')) &&
    !/^\[[a-f\d:.]*:[a-f\d:.]*\]$/i.test(trimmed)
  ) {
    throw new Error('方括号内需填写有效的 IPv6 地址。')
  }
  const host = trimmed.replace(/^\[([^\]]+)\]$/, '$1')
  if (host.includes(':')) {
    try {
      if (!/^[a-f\d:.]+$/i.test(host)) throw new Error('Invalid IPv6')
      return new URL(`http://[${host}]:1`).hostname.slice(1, -1)
    } catch {
      throw new Error('请填写有效的 IPv6 地址。')
    }
  }
  if (
    host.length === 0 ||
    host.length > 253 ||
    !host
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    (/^[\d.]+$/.test(host) &&
      !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host)) ||
    (/^[\d.]+$/.test(host) && host.split('.').some((part) => Number(part) > 255))
  )
    throw new Error('主机地址需为有效域名或 IP，不包含协议、端口或路径。')
  return host.toLowerCase()
}

function portNumber(raw: string): number {
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error('端口需为 1–65535 的整数。')
  }
  return Number(raw)
}

function validateCredentials(
  scheme: MonitorProxy['scheme'],
  username: string,
  password?: string,
) {
  const hasControl = Array.from(username + (password ?? '')).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (username.length > 128 || (password?.length ?? 0) > 512 || hasControl) {
    throw new Error('认证信息过长或包含控制字符，请重新填写。')
  }
  if (scheme === 'socks5' || scheme === 'socks5h') {
    const encoder = new TextEncoder()
    if (
      encoder.encode(username).length > 255 ||
      encoder.encode(password ?? '').length > 255
    ) {
      throw new Error('SOCKS5 认证信息编码后不能超过 255 字节。')
    }
    if (password && username === '') throw new Error('使用 SOCKS5 密码时也需填写用户名。')
  }
}

/** Explicit ports and credentials are parsed without making a network request. */
// eslint-disable-next-line react-refresh/only-export-components
export function parseMonitorProxyUrl(
  raw: string,
): Pick<ProxyInput, 'scheme' | 'host' | 'port' | 'username'> & { password: string } {
  const text = raw.trim()
  if (text.length > 4096 || /[\s\\]/.test(text)) throw new Error('代理链接格式无效。')
  const match = /^(https?|socks5h?):\/\/([^/?#]+)\/?$/i.exec(text)
  if (!match)
    throw new Error(
      '请使用 HTTP、HTTPS、SOCKS5 或 SOCKS5H 链接，且不带路径、查询或片段。',
    )
  const scheme = SCHEMES.find((entry) => entry === match[1]?.toLowerCase())
  const authority = match[2]
  if (!scheme || !authority) throw new Error('代理链接格式无效。')
  const parts = authority.split('@')
  if (parts.length > 2) throw new Error('认证信息中的 @ 需使用百分号编码。')
  const address = parts[parts.length - 1] ?? ''
  const hostPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(address)
  const host = hostPort?.[1]
  const port = hostPort?.[2]
  if (!host || !port)
    throw new Error('代理链接需明确填写主机与端口，IPv6 地址需使用方括号。')
  let username = ''
  let password = ''
  if (parts.length === 2) {
    const credentials = parts[0] ?? ''
    const separator = credentials.indexOf(':')
    try {
      username = decodeURIComponent(
        separator < 0 ? credentials : credentials.slice(0, separator),
      )
      password = separator < 0 ? '' : decodeURIComponent(credentials.slice(separator + 1))
    } catch {
      throw new Error('认证信息的百分号编码无效。')
    }
  }
  validateCredentials(scheme, username, password)
  return {
    scheme,
    host: normalizedHost(host),
    port: portNumber(port),
    username,
    password,
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function proxyInputFromForm(form: ProxyFormValues): ProxyInput {
  const name = form.name.trim()
  if (!name || name.length > 64) throw new Error('请填写 1–64 字的代理名称。')
  if (!SCHEMES.includes(form.scheme)) throw new Error('请选择支持的代理协议。')
  const password =
    form.id && form.passwordMode === 'keep'
      ? undefined
      : form.passwordMode === 'clear'
        ? ''
        : form.password
  if (form.id && form.passwordMode === 'replace' && !password) {
    throw new Error('请输入新密码，或选择清除密码。')
  }
  validateCredentials(form.scheme, form.username, password)
  if (
    (form.scheme === 'socks5' || form.scheme === 'socks5h') &&
    form.username === '' &&
    form.passwordMode === 'keep' &&
    form.hasPassword
  ) {
    throw new Error('保留 SOCKS5 密码时需填写用户名，或明确清除密码。')
  }
  return {
    ...(form.id ? { id: form.id } : {}),
    name,
    scheme: form.scheme,
    host: normalizedHost(form.host),
    port: portNumber(form.port),
    username: form.username,
    ...(password === undefined ? {} : { password }),
    enabled: form.enabled,
  }
}

function safeError(cause: unknown, secrets: string[] = []): string {
  let text = message(cause).replace(
    /((?:https?|socks5h?):\/\/)[^\s/@]+@/gi,
    '$1[认证信息]@',
  )
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join('[认证信息]')
      text = text.split(encodeURIComponent(secret)).join('[认证信息]')
    }
  }
  return text
}

export interface ProxySettingsSheetProps {
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

export function ProxySettingsSheet({ onOpenChange, onChanged }: ProxySettingsSheetProps) {
  const [revision, setRevision] = useState(0)
  const [load, setLoad] = useState<{
    revision: number
    data: ProxyList | null
    error: string | null
  }>({
    revision: -1,
    data: null,
    error: null,
  })
  const [form, setForm] = useState<ProxyFormValues>(emptyForm)
  const [link, setLink] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<'save' | 'default' | 'delete' | null>(null)
  const [defaultDraft, setDefaultDraft] = useState<string | undefined>()
  const [defaultError, setDefaultError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<MonitorProxy | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const alive = useRef(true)
  const formElement = useRef<HTMLFormElement>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void listProxies().then(
      (data) => {
        if (active) setLoad({ revision, data, error: null })
      },
      (cause: unknown) => {
        if (active)
          setLoad((current) => ({ ...current, revision, error: safeError(cause) }))
      },
    )
    return () => {
      active = false
    }
  }, [revision])

  const data = load.data
  const loading = load.revision !== revision
  const busy = pending !== null
  const unavailable = busy || loading || data === null || load.error !== null
  const defaultValue = defaultDraft ?? data?.defaultProxyId ?? APP_NETWORK
  const selectedDefault = data?.items.find((proxy) => proxy.id === defaultValue)
  const defaultLabel =
    defaultValue === APP_NETWORK
      ? '不设默认代理（跟随应用网络）'
      : selectedDefault
        ? `${selectedDefault.name}${selectedDefault.enabled ? '' : ' · 已停用'}`
        : '默认代理已删除'
  const invalidDefault = defaultValue !== APP_NETWORK && !selectedDefault?.enabled

  function update<K extends keyof ProxyFormValues>(key: K, value: ProxyFormValues[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function edit(proxy?: MonitorProxy) {
    setForm(proxy ? formOf(proxy) : emptyForm())
    setLink('')
    setLinkError(null)
    setError(null)
    formElement.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  function importLink() {
    try {
      const parsed = parseMonitorProxyUrl(link)
      setForm((current) => ({
        ...current,
        ...parsed,
        port: String(parsed.port),
        passwordMode: parsed.password === '' ? 'clear' : 'replace',
      }))
      setLink('')
      setLinkError(null)
      setError(null)
    } catch (cause) {
      setLinkError(safeError(cause))
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (unavailable) return
    let input: ProxyInput
    try {
      input = proxyInputFromForm(form)
    } catch (cause) {
      setError(safeError(cause))
      return
    }
    setPending('save')
    setError(null)
    try {
      const saved = await saveProxy(input)
      if (!alive.current) return
      setLoad((current) => ({
        ...current,
        data: current.data && {
          ...current.data,
          items: [
            ...current.data.items.filter((proxy) => proxy.id !== saved.item.id),
            saved.item,
          ],
        },
      }))
      setForm(formOf(saved.item))
      setLink('')
      setLinkError(null)
      toast.success(saved.created ? '代理已添加' : '代理已保存')
      window.dispatchEvent(new Event(PROXY_SETTINGS_CHANGED))
      onChanged()
      setRevision((current) => current + 1)
    } catch (cause) {
      if (alive.current) setError(safeError(cause, [form.password, form.username]))
    } finally {
      if (alive.current) setPending(null)
    }
  }

  async function saveDefault() {
    if (unavailable || invalidDefault) return
    setPending('default')
    setDefaultError(null)
    try {
      const result = await setDefaultProxy(
        defaultValue === APP_NETWORK ? null : defaultValue,
      )
      if (!alive.current) return
      setLoad((current) => ({
        ...current,
        data: current.data && { ...current.data, defaultProxyId: result.defaultProxyId },
      }))
      setDefaultDraft(undefined)
      toast.success('插件默认代理已保存')
      window.dispatchEvent(new Event(PROXY_SETTINGS_CHANGED))
      onChanged()
    } catch (cause) {
      if (alive.current) setDefaultError(safeError(cause))
    } finally {
      if (alive.current) setPending(null)
    }
  }

  async function confirmRemove() {
    if (pending || !removing) return
    setPending('delete')
    setDeleteError(null)
    try {
      const result = await removeProxy(removing.id)
      if (!alive.current) return
      setLoad((current) => ({
        ...current,
        data: current.data && {
          ...current.data,
          items: current.data.items.filter((proxy) => proxy.id !== removing.id),
        },
      }))
      if (form.id === removing.id) edit()
      setRemoving(null)
      toast.success(result.removed ? '代理已删除' : '代理已不存在，列表已更新')
      window.dispatchEvent(new Event(PROXY_SETTINGS_CHANGED))
      onChanged()
      setRevision((current) => current + 1)
    } catch (cause) {
      if (alive.current) setDeleteError(safeError(cause, [removing.username]))
    } finally {
      if (alive.current) setPending(null)
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!busy) onOpenChange(open)
      }}
    >
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Vinted 代理设置</SheetTitle>
          <SheetDescription>
            为商品采集、卖家资料与商品图片配置独立代理。
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <p className="text-xs text-muted-foreground">
            采集代理不可用时暂停请求。AI 模型请求沿用原网络设置。
          </p>
          {data?.storageDurable === false ? (
            <Alert>
              <AlertTitle>仅本次运行有效</AlertTitle>
              <AlertDescription>
                宿主未提供持久化目录，代理与默认选择只保留在内存，重启后失效。
              </AlertDescription>
            </Alert>
          ) : null}
          <section
            aria-label="插件代理列表"
            className="flex flex-col gap-3"
            aria-busy={loading}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                已配置代理{data ? ` · ${String(data.items.length)}` : ''}
              </h3>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => edit()}
                >
                  <Plus data-icon="inline-start" />
                  新增代理
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || loading}
                  onClick={() => setRevision((current) => current + 1)}
                >
                  <RefreshCw
                    data-icon="inline-start"
                    className={loading ? 'animate-spin' : undefined}
                  />
                  {loading ? '加载中…' : '刷新'}
                </Button>
              </div>
            </div>
            {loading && !data ? (
              <p role="status" className="text-sm text-muted-foreground">
                正在加载代理配置…
              </p>
            ) : null}
            {load.error ? (
              <Alert variant="destructive">
                <AlertTitle>代理配置加载失败</AlertTitle>
                <AlertDescription>
                  {load.error}
                  {data ? ' 当前展示上次读取的数据。' : ''}
                </AlertDescription>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2 w-fit"
                  disabled={busy || loading}
                  onClick={() => setRevision((current) => current + 1)}
                >
                  重试
                </Button>
              </Alert>
            ) : null}
            {data?.items.length === 0 && !loading && !load.error ? (
              <Empty className="p-4">
                <EmptyHeader>
                  <EmptyTitle>还没有插件代理</EmptyTitle>
                  <EmptyDescription>
                    在下方添加代理；未设默认代理的监控将跟随应用网络。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {data?.items.map((proxy) => (
              <div
                key={proxy.id}
                className="flex flex-wrap items-center gap-3 border-b py-2 last:border-0"
              >
                <div className="min-w-0 flex-1 basis-48">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all text-sm font-medium">{proxy.name}</span>
                    <Badge variant={proxy.enabled ? 'secondary' : 'outline'}>
                      {proxy.enabled ? '启用' : '停用'}
                    </Badge>
                    {proxy.id === data.defaultProxyId ? (
                      <Badge variant="outline">插件默认</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {proxy.scheme.toUpperCase()} ·{' '}
                    {proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host}:
                    {proxy.port}
                    {' · '}
                    {proxy.username || proxy.hasPassword ? '已配置认证' : '无认证'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={unavailable}
                    aria-label={`编辑 ${proxy.name}`}
                    onClick={() => edit(proxy)}
                  >
                    <Pencil data-icon="inline-start" />
                    编辑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={unavailable}
                    aria-label={`删除 ${proxy.name}`}
                    onClick={() => {
                      setRemoving(proxy)
                      setDeleteError(null)
                    }}
                  >
                    <Trash2 data-icon="inline-start" />
                  </Button>
                </div>
              </div>
            ))}
          </section>
          <FieldGroup>
            <Field data-invalid={invalidDefault || defaultError !== null}>
              <FieldLabel htmlFor="vinted-default-proxy">插件默认代理</FieldLabel>
              <div className="flex flex-wrap gap-2">
                <Select
                  value={defaultValue}
                  disabled={unavailable}
                  onValueChange={setDefaultDraft}
                >
                  <SelectTrigger
                    id="vinted-default-proxy"
                    className="min-w-0 flex-1"
                    aria-invalid={invalidDefault}
                  >
                    <SelectValue>{data ? defaultLabel : '等待代理配置…'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={APP_NETWORK}>
                        不设默认代理（跟随应用网络）
                      </SelectItem>
                      {defaultValue !== APP_NETWORK && !selectedDefault ? (
                        <SelectItem value={defaultValue} disabled>
                          默认代理已删除
                        </SelectItem>
                      ) : null}
                      {data?.items.map((proxy) => (
                        <SelectItem
                          key={proxy.id}
                          value={proxy.id}
                          disabled={!proxy.enabled}
                        >
                          {proxy.name}
                          {proxy.enabled ? '' : ' · 已停用'}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  disabled={unavailable || invalidDefault || defaultDraft === undefined}
                  onClick={() => void saveDefault()}
                >
                  {pending === 'default' ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : null}
                  保存默认
                </Button>
              </div>
              <FieldDescription>
                仅影响选择“继承插件默认”的监控，单独指定代理的监控继续使用原选择。
              </FieldDescription>
              {invalidDefault ? (
                <FieldError>
                  默认代理已删除或停用，请明确选择可用代理或跟随应用网络。
                </FieldError>
              ) : null}
              {defaultError ? <FieldError>{defaultError}</FieldError> : null}
            </Field>
          </FieldGroup>
          <Separator />
          <form id="vinted-proxy-form" ref={formElement} onSubmit={submit}>
            <FieldGroup>
              <FieldSet disabled={busy}>
                <FieldLegend variant="label">
                  {form.id ? '编辑代理' : '新增代理'}
                </FieldLegend>
                <FieldGroup>
                  <Field data-invalid={linkError !== null}>
                    <FieldLabel htmlFor="vinted-proxy-link">
                      粘贴代理链接（可选）
                    </FieldLabel>
                    <div className="flex gap-2">
                      <Input
                        id="vinted-proxy-link"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={4096}
                        placeholder="socks5://127.0.0.1:7890"
                        value={link}
                        aria-invalid={linkError !== null}
                        onChange={(event) => {
                          setLink(event.target.value)
                          setLinkError(null)
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy || !link.trim()}
                        onClick={importLink}
                      >
                        填入表单
                      </Button>
                    </div>
                    <FieldDescription>
                      仅解析主机、端口和认证信息；点击保存后生效。无密码链接会选择清除密码。
                    </FieldDescription>
                    {linkError ? <FieldError>{linkError}</FieldError> : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="vinted-proxy-name">名称</FieldLabel>
                    <Input
                      id="vinted-proxy-name"
                      required
                      maxLength={64}
                      value={form.name}
                      onChange={(event) => update('name', event.target.value)}
                    />
                  </Field>
                  <FieldGroup className="grid grid-cols-2 gap-4">
                    <Field>
                      <FieldLabel htmlFor="vinted-proxy-scheme">协议</FieldLabel>
                      <LabeledSelect
                        id="vinted-proxy-scheme"
                        ariaLabel="代理协议"
                        value={form.scheme}
                        disabled={busy}
                        options={SCHEMES.map((scheme) => ({
                          value: scheme,
                          label: scheme.toUpperCase(),
                        }))}
                        onValueChange={(value) => {
                          const scheme = SCHEMES.find((entry) => entry === value)
                          if (scheme) update('scheme', scheme)
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="vinted-proxy-port">端口</FieldLabel>
                      <Input
                        id="vinted-proxy-port"
                        required
                        type="number"
                        min={1}
                        max={65535}
                        step={1}
                        value={form.port}
                        onChange={(event) => update('port', event.target.value)}
                      />
                    </Field>
                  </FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="vinted-proxy-host">主机地址</FieldLabel>
                    <Input
                      id="vinted-proxy-host"
                      required
                      maxLength={253}
                      spellCheck={false}
                      placeholder="127.0.0.1"
                      value={form.host}
                      onChange={(event) => update('host', event.target.value)}
                    />
                    <FieldDescription>
                      域名或 IP，不含协议与端口。SOCKS5 由本机解析域名，SOCKS5H
                      由代理解析。
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </FieldSet>
              <FieldSet disabled={busy}>
                <FieldLegend variant="label">认证与状态</FieldLegend>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="vinted-proxy-username">
                      用户名（可选）
                    </FieldLabel>
                    <Input
                      id="vinted-proxy-username"
                      maxLength={128}
                      autoComplete="off"
                      spellCheck={false}
                      value={form.username}
                      onChange={(event) => update('username', event.target.value)}
                    />
                  </Field>
                  {form.id ? (
                    <Field>
                      <FieldLabel htmlFor="vinted-proxy-password-mode">
                        密码处理
                      </FieldLabel>
                      <LabeledSelect
                        id="vinted-proxy-password-mode"
                        ariaLabel="密码处理"
                        value={form.passwordMode}
                        disabled={busy}
                        options={[
                          { value: 'keep', label: '保留现有密码' },
                          { value: 'replace', label: '替换密码' },
                          { value: 'clear', label: '清除密码' },
                        ]}
                        onValueChange={(value) => {
                          if (
                            value === 'keep' ||
                            value === 'replace' ||
                            value === 'clear'
                          )
                            update('passwordMode', value)
                        }}
                      />
                      <FieldDescription>
                        {form.hasPassword
                          ? '已保存密码，保留时无需重新输入。'
                          : '当前未保存密码。'}
                      </FieldDescription>
                    </Field>
                  ) : null}
                  {!form.id || form.passwordMode === 'replace' ? (
                    <Field>
                      <FieldLabel htmlFor="vinted-proxy-password">
                        {form.id ? '新密码' : '密码（可选）'}
                      </FieldLabel>
                      <Input
                        id="vinted-proxy-password"
                        type="password"
                        autoComplete="new-password"
                        maxLength={512}
                        required={!!form.id && form.passwordMode === 'replace'}
                        value={form.password}
                        onChange={(event) => {
                          setForm((current) => ({
                            ...current,
                            password: event.target.value,
                            passwordMode: 'replace',
                          }))
                        }}
                      />
                    </Field>
                  ) : null}
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="vinted-proxy-enabled">启用代理</FieldLabel>
                      <FieldDescription>
                        停用后无法用于采集；已有引用不会自动切换其他网络。
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id="vinted-proxy-enabled"
                      checked={form.enabled}
                      disabled={busy}
                      onCheckedChange={(checked) => update('enabled', checked)}
                    />
                  </Field>
                </FieldGroup>
              </FieldSet>
              {error ? <FieldError>{error}</FieldError> : null}
            </FieldGroup>
          </form>
        </SheetBody>
        <SheetFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
          <Button type="submit" form="vinted-proxy-form" disabled={unavailable}>
            {pending === 'save' ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : null}
            {pending === 'save' ? '保存中…' : '保存代理'}
          </Button>
        </SheetFooter>
      </SheetContent>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除代理</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除「{removing?.name}
              」？代理及认证信息将从插件配置中移除。被监控或默认设置引用时，需先解除关联。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <FieldError>{deleteError}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void confirmRemove()
              }}
            >
              {pending === 'delete' ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : null}
              {pending === 'delete' ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
