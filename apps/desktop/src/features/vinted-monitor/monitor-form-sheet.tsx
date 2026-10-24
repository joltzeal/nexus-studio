import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CheckCircle2, Loader2, RefreshCw, Settings2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { inspectUrl, listProxies, saveMonitor } from './api'
import { PROXY_SETTINGS_CHANGED } from './proxy-settings-sheet'
import {
  DEFAULT_MONITOR,
  kindText,
  message,
  type Monitor,
  type MonitorInput,
  type ProxyList,
} from './types'

const INHERIT_PROXY = '__inherit__'

export interface MonitorFormSheetProps {
  /** `null` creates a new monitor. */
  monitor: Monitor | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  onConfigureProxies?: () => void
}

function initial(monitor: Monitor | null): MonitorInput {
  if (monitor === null) return { ...DEFAULT_MONITOR }
  return {
    id: monitor.id,
    name: monitor.name,
    searchUrl: monitor.searchUrl,
    proxyId: monitor.proxyId ?? null,
    intervalMinutes: monitor.intervalMinutes,
    maxPages: monitor.maxPages,
    perPage: monitor.perPage,
    enabled: monitor.enabled,
  }
}

// Kept beside the form so validation and its focused tests share the same boundary.
// eslint-disable-next-line react-refresh/only-export-components
export function monitorProxyError(
  form: Pick<MonitorInput, 'proxyId' | 'enabled'>,
  proxies: ProxyList,
): string | null {
  const id = form.proxyId ?? proxies.defaultProxyId
  if (id === null) return null
  const proxy = proxies.items.find((item) => item.id === id)
  if (!proxy)
    return form.proxyId === null
      ? '插件默认代理已删除，请重新配置默认代理。'
      : '原代理已删除，请明确选择其他代理或继承插件默认。'
  if (!proxy.enabled && form.enabled)
    return form.proxyId === null
      ? '插件默认代理已停用，请先启用代理、选择其他代理或停用此监控。'
      : '所选代理已停用；仅停用的监控可以保留此选择。'
  return null
}

/** A URL hint only; the plugin remains responsible for URL validation. */
// eslint-disable-next-line react-refresh/only-export-components
export function memberIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return null
    if (!/^(?:www\.)?vinted\.(?:[a-z]{2,3}|co\.uk|com\.au)$/i.test(url.hostname))
      return null
    return /^\/member\/(\d+)(?:-[^/]*)?\/?$/.exec(url.pathname)?.[1] ?? null
  } catch {
    return null
  }
}

export function MonitorFormSheet(props: MonitorFormSheetProps) {
  return <MonitorForm key={props.monitor?.id ?? 'new'} {...props} />
}

function MonitorForm({
  monitor,
  onOpenChange,
  onSaved,
  onConfigureProxies,
}: MonitorFormSheetProps) {
  const [form, setForm] = useState<MonitorInput>(() => initial(monitor))
  const [numbers, setNumbers] = useState(() => ({
    intervalMinutes: String(form.intervalMinutes),
    maxPages: String(form.maxPages),
    perPage: String(form.perPage),
  }))
  const [inspection, setInspection] = useState<Awaited<
    ReturnType<typeof inspectUrl>
  > | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [proxyLoad, setProxyLoad] = useState<{
    revision: number
    data: ProxyList | null
    error: string | null
  }>({
    revision: -1,
    data: null,
    error: null,
  })
  const urlRequest = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      urlRequest.current += 1
    }
  }, [])

  useEffect(() => {
    let active = true
    void listProxies().then(
      (data) => {
        if (active) setProxyLoad({ revision, data, error: null })
      },
      (cause: unknown) => {
        if (active) setProxyLoad({ revision, data: null, error: message(cause) })
      },
    )
    return () => {
      active = false
    }
  }, [revision])

  useEffect(() => {
    const refresh = () => setRevision((current) => current + 1)
    window.addEventListener('focus', refresh)
    window.addEventListener(PROXY_SETTINGS_CHANGED, refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener(PROXY_SETTINGS_CHANGED, refresh)
    }
  }, [])

  const proxiesLoading = proxyLoad.revision !== revision
  const proxies = proxyLoad.data
  const proxyError = proxies === null ? null : monitorProxyError(form, proxies)
  const selectedProxy = proxies?.items.find((proxy) => proxy.id === form.proxyId)
  const defaultProxy = proxies?.items.find((proxy) => proxy.id === proxies.defaultProxyId)
  const defaultLabel =
    proxies?.defaultProxyId == null
      ? '继承插件默认（跟随应用网络）'
      : `继承插件默认（${defaultProxy?.name ?? '已删除'}${defaultProxy && !defaultProxy.enabled ? ' · 已停用' : ''}）`
  const selectedLabel =
    form.proxyId === null
      ? defaultLabel
      : selectedProxy
        ? `${selectedProxy.name}${selectedProxy.enabled ? '' : ' · 已停用'}`
        : proxiesLoading || proxies === null
          ? '正在确认原代理…'
          : '原代理已删除'
  const userId = memberIdFromUrl(form.searchUrl)
  const scanCount = Number(numbers.maxPages) * Number(numbers.perPage)
  const validScanCount =
    /^\d+$/.test(numbers.maxPages) &&
    /^\d+$/.test(numbers.perPage) &&
    Number(numbers.maxPages) >= 1 &&
    Number(numbers.maxPages) <= 20 &&
    Number(numbers.perPage) >= 1 &&
    Number(numbers.perPage) <= 96

  function update<K extends keyof MonitorInput>(key: K, value: MonitorInput[K]) {
    setForm((current) => ({ ...current, [key]: value }))
    if (key === 'searchUrl') {
      urlRequest.current += 1
      setInspection(null)
      setUrlError(null)
      setChecking(false)
    }
  }

  async function checkUrl() {
    const request = ++urlRequest.current
    const url = form.searchUrl.trim()
    if (url === '') return
    setChecking(true)
    setUrlError(null)
    try {
      const result = await inspectUrl(url)
      if (!alive.current || request !== urlRequest.current) return
      setInspection(result)
    } catch (cause) {
      if (!alive.current || request !== urlRequest.current) return
      setInspection(null)
      setUrlError(message(cause))
    } finally {
      if (alive.current && request === urlRequest.current) setChecking(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || proxiesLoading || proxyLoad.error || proxies === null) return
    if (proxyError) {
      setError(proxyError)
      return
    }
    if (form.name.trim() === '' || form.searchUrl.trim() === '') {
      setError('请填写监控名称和 Vinted 监控 URL')
      return
    }
    const intervalMinutes = Number(numbers.intervalMinutes)
    if (
      !/^\d+$/.test(numbers.intervalMinutes) ||
      intervalMinutes < 1 ||
      intervalMinutes > 1440 ||
      !validScanCount
    ) {
      setError('间隔需为 1–1440 的整数，页数为 1–20，每页商品数为 1–96。')
      return
    }
    setPending(true)
    setError(null)
    try {
      await saveMonitor({
        ...form,
        name: form.name.trim(),
        searchUrl: form.searchUrl.trim(),
        intervalMinutes,
        maxPages: Number(numbers.maxPages),
        perPage: Number(numbers.perPage),
      })
      if (!alive.current) return
      toast.success(monitor === null ? '监控已创建' : '监控已更新')
      onSaved()
      onOpenChange(false)
    } catch (cause) {
      if (alive.current) setError(message(cause))
    } finally {
      if (alive.current) setPending(false)
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open)
      }}
    >
      <SheetContent side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{monitor === null ? '新增监控' : '编辑监控'}</SheetTitle>
          <SheetDescription>配置 Vinted 监控网址、请求代理与采集策略。</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form id="vinted-monitor-form" onSubmit={submit}>
            <FieldGroup>
              <FieldSet disabled={pending}>
                <FieldLegend variant="label">监控配置</FieldLegend>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="vinted-monitor-name">名称</FieldLabel>
                    <Input
                      id="vinted-monitor-name"
                      required
                      maxLength={64}
                      placeholder="例如 Nike 女装新品"
                      value={form.name}
                      onChange={(event) => update('name', event.target.value)}
                    />
                  </Field>
                  <Field data-invalid={urlError !== null}>
                    <FieldLabel htmlFor="vinted-monitor-url">监控 URL</FieldLabel>
                    <Input
                      id="vinted-monitor-url"
                      required
                      type="url"
                      maxLength={4096}
                      spellCheck={false}
                      placeholder="https://www.vinted.fr/member/123456"
                      aria-invalid={urlError !== null}
                      aria-describedby="vinted-monitor-url-hint vinted-monitor-url-feedback"
                      value={form.searchUrl}
                      onChange={(event) => update('searchUrl', event.target.value)}
                      onBlur={() => void checkUrl()}
                    />
                    <FieldDescription id="vinted-monitor-url-hint">
                      支持搜索、分类、品牌筛选网址，以及 /member/用户ID
                      衣柜网址；保存时由插件校验。
                    </FieldDescription>
                    {userId ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">用户商品监控</Badge>
                        <span className="text-xs text-muted-foreground">
                          自动识别用户 {userId}，按衣柜分页采集。
                        </span>
                      </div>
                    ) : null}
                    {/* Blur validation must not move the next pointer target. */}
                    <div
                      id="vinted-monitor-url-feedback"
                      className="h-10 shrink-0 overflow-y-auto break-words"
                      tabIndex={urlError ? 0 : undefined}
                    >
                      {checking ? (
                        <p className="text-xs text-muted-foreground" role="status">
                          正在校验 URL…
                        </p>
                      ) : urlError ? (
                        <FieldError>{urlError}</FieldError>
                      ) : inspection ? (
                        <p
                          className="flex items-center gap-2 text-xs text-muted-foreground"
                          role="status"
                        >
                          <CheckCircle2
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          URL 校验通过 · {kindText(inspection.kind)} · {inspection.host}
                        </p>
                      ) : null}
                    </div>
                  </Field>
                  <Field data-invalid={proxyError !== null || proxyLoad.error !== null}>
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel htmlFor="vinted-monitor-proxy">采集代理</FieldLabel>
                      <div className="flex items-center gap-1">
                        {onConfigureProxies ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={onConfigureProxies}
                          >
                            <Settings2 data-icon="inline-start" />
                            代理设置
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="刷新代理列表"
                          disabled={pending || proxiesLoading}
                          onClick={() => setRevision((current) => current + 1)}
                        >
                          <RefreshCw data-icon="inline-start" />
                        </Button>
                      </div>
                    </div>
                    <Select
                      value={form.proxyId ?? INHERIT_PROXY}
                      disabled={pending || proxiesLoading || proxyLoad.error !== null}
                      onValueChange={(value) =>
                        update('proxyId', value === INHERIT_PROXY ? null : value)
                      }
                    >
                      <SelectTrigger
                        id="vinted-monitor-proxy"
                        className="w-full"
                        aria-invalid={proxyError !== null}
                        aria-describedby="vinted-monitor-proxy-hint"
                      >
                        <SelectValue>
                          {proxiesLoading
                            ? '正在加载代理…'
                            : proxyLoad.error
                              ? '代理配置未加载'
                              : selectedLabel}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={INHERIT_PROXY}>{defaultLabel}</SelectItem>
                          {form.proxyId !== null && !selectedProxy ? (
                            <SelectItem value={form.proxyId} disabled>
                              原代理已删除
                            </SelectItem>
                          ) : null}
                          {proxies?.items.map((proxy) => (
                            <SelectItem
                              key={proxy.id}
                              value={proxy.id}
                              disabled={
                                !proxy.enabled &&
                                (form.enabled || proxy.id !== form.proxyId)
                              }
                            >
                              {proxy.name} · {proxy.host}:{proxy.port}
                              {proxy.enabled ? '' : ' · 已停用'}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription id="vinted-monitor-proxy-hint">
                      未指定时继承插件默认代理；插件未设默认时跟随应用网络。已配置代理失败时不会回退直连。
                    </FieldDescription>
                    {proxyLoad.error ? (
                      <FieldError>
                        {proxyLoad.error}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="ml-2"
                          disabled={proxiesLoading}
                          onClick={() => setRevision((current) => current + 1)}
                        >
                          重试
                        </Button>
                      </FieldError>
                    ) : proxyError ? (
                      <FieldError>{proxyError}</FieldError>
                    ) : null}
                    {proxies?.storageDurable === false ? (
                      <FieldDescription>
                        代理配置仅在本次运行中有效，重启后失效。
                      </FieldDescription>
                    ) : null}
                  </Field>
                </FieldGroup>
              </FieldSet>
              <Separator />
              <FieldSet disabled={pending}>
                <FieldLegend variant="label">采集策略</FieldLegend>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="vinted-monitor-interval">
                      执行间隔（分钟）
                    </FieldLabel>
                    <Input
                      id="vinted-monitor-interval"
                      required
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      value={numbers.intervalMinutes}
                      onChange={(event) =>
                        setNumbers((current) => ({
                          ...current,
                          intervalMinutes: event.target.value,
                        }))
                      }
                    />
                    <FieldDescription>
                      应用运行时按此间隔采集；关闭应用后暂停。
                    </FieldDescription>
                  </Field>
                  <FieldGroup className="grid grid-cols-2 gap-4">
                    <Field>
                      <FieldLabel htmlFor="vinted-monitor-pages">最多页数</FieldLabel>
                      <Input
                        id="vinted-monitor-pages"
                        required
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        value={numbers.maxPages}
                        onChange={(event) =>
                          setNumbers((current) => ({
                            ...current,
                            maxPages: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="vinted-monitor-per-page">
                        每页商品数
                      </FieldLabel>
                      <Input
                        id="vinted-monitor-per-page"
                        required
                        type="number"
                        min={1}
                        max={96}
                        step={1}
                        value={numbers.perPage}
                        onChange={(event) =>
                          setNumbers((current) => ({
                            ...current,
                            perPage: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </FieldGroup>
                  {userId ? (
                    <Field>
                      <FieldDescription>
                        衣柜按分页结束；推荐最多 20 页、每页 96
                        件，商品较多时仍可能达到上限。
                      </FieldDescription>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() =>
                          setNumbers((current) => ({
                            ...current,
                            maxPages: '20',
                            perPage: '96',
                          }))
                        }
                      >
                        推荐分页 · 20 × 96
                      </Button>
                    </Field>
                  ) : null}
                  <FieldDescription>
                    {validScanCount
                      ? `每轮最多扫描 ${String(scanCount)} 件商品。`
                      : '请填写有效的页数与每页商品数。'}
                    达到分页上限表示扫描不完整，不代表已发现全部商品。
                  </FieldDescription>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="vinted-monitor-enabled">启用监控</FieldLabel>
                      <FieldDescription>
                        停用后暂停所有采集；手动执行前也需先启用监控。
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id="vinted-monitor-enabled"
                      checked={form.enabled}
                      disabled={pending}
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
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="submit"
            form="vinted-monitor-form"
            disabled={
              pending ||
              proxiesLoading ||
              proxyLoad.error !== null ||
              proxies === null ||
              proxyError !== null
            }
          >
            {pending ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : null}
            {pending ? '保存中…' : '保存监控'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
