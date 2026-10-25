import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Check, Dices, Loader2, Search, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
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
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import { parseWindowConfig, type WindowConfig } from '@/demo/model'
import { getConfig, listProxies } from '@/features/proxy/api'
import { ProxyCheckSummary } from '@/features/proxy/proxy-check-summary'
import {
  EMPTY_QUERY,
  flagOf,
  type CheckResult,
  type ProxyRow,
} from '@/features/proxy/types'
import type { WindowGroup } from '@/lib/platform/native-groups'
import {
  getKernelStatus,
  type InstalledKernel,
  type KernelSelection,
} from '@/lib/platform/native-kernels'
import type { LicenseStatus } from '@/lib/platform/native-license'
import { listProxyProviders, type PluginView } from '@/lib/platform/native-plugins'
import {
  nativeProfilesAvailable,
  type NativeProfile,
  type WindowSettings,
} from '@/lib/platform/native-profiles'
import { randomFingerprintSeed, randomWindowName } from '@/lib/random-name'
import { configOf } from './window-config'
import { WindowKernelPicker } from './window-kernel-picker'
import { checkWindowProxy } from './window-proxy'
import { MAX_BATCH_WINDOWS } from './window-batch'

export type SaveWindow = (
  name: string,
  proxy: string | null,
  proxyPlugin: string | null,
  proxyEndpoint: number | null,
  settings: WindowSettings,
  kernel: KernelSelection,
  groupId?: string | null,
) => Promise<void>

function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '操作失败，请重试。'
}

export function WindowEditor({
  window,
  groups,
  takenNames,
  licenseStatus,
  batch,
  onSave,
  onCancel,
}: {
  window: NativeProfile | null
  groups: WindowGroup[]
  takenNames: string[]
  licenseStatus: LicenseStatus | null
  batch?: {
    count: number
    onCountChange?: (count: number) => void
    fromAccounts?: boolean
    fields?: ReactNode
  }
  onSave: SaveWindow
  onCancel: () => void
}) {
  const [name, setName] = useState(window?.name ?? '')
  const [kernel, setKernel] = useState<KernelSelection>({ kind: 'base' })
  const [installedKernels, setInstalledKernels] = useState<InstalledKernel[]>([])
  const [kernelsLoading, setKernelsLoading] = useState(window === null)
  const [kernelsError, setKernelsError] = useState<string | null>(null)
  const [platform, setPlatform] = useState<WindowSettings['platform']>(
    window?.settings.platform ?? 'Vinted',
  )
  const [note, setNote] = useState(window?.settings.note ?? '')
  const [groupId, setGroupId] = useState(window?.groupId ?? 'ungrouped')
  const [config, setConfig] = useState<WindowConfig>(() => configOf(window))
  const [proxySource, setProxySource] = useState<'direct' | 'manual' | 'plugin'>(
    window?.proxyPlugin ? 'plugin' : window?.proxy ? 'manual' : 'direct',
  )
  const [proxyPlugin, setProxyPlugin] = useState<string | null>(
    window?.proxyPlugin ?? null,
  )
  const [endpointId, setEndpointId] = useState<number | null>(
    window?.proxyEndpoint ?? null,
  )
  const [providers, setProviders] = useState<PluginView[]>([])
  const [proxies, setProxies] = useState<ProxyRow[] | null>(null)
  const [defaultProxyId, setDefaultProxyId] = useState<string | null>(null)
  const [proxyLoadError, setProxyLoadError] = useState<string | null>(null)
  const [proxyQuery, setProxyQuery] = useState('')
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null)
  const [checkNote, setCheckNote] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (window !== null || !nativeProfilesAvailable()) return
    let active = true
    void getKernelStatus(true).then(
      (status) => {
        if (!active) return
        setInstalledKernels(status.installed)
        setKernelsLoading(false)
      },
      () => {
        if (!active) return
        setKernelsError('本地版本暂时无法读取')
        setKernelsLoading(false)
      },
    )
    return () => {
      active = false
    }
  }, [window])

  useEffect(() => {
    if (!nativeProfilesAvailable()) return
    let active = true
    void listProxyProviders().then(
      (list) => {
        if (active) {
          setProviders(list.filter((entry) => entry.state === 'running'))
        }
      },
      () => {
        // Without a running provider the editor simply offers the other sources.
      },
    )
    return () => {
      active = false
    }
  }, [])

  // The picker reads the pool itself: a window pins one row, not the default.
  useEffect(() => {
    if (proxySource !== 'plugin' || providers.length === 0) return
    let active = true
    void Promise.all([listProxies({ ...EMPTY_QUERY, limit: 500 }), getConfig()]).then(
      ([result, poolConfig]) => {
        if (active) {
          setProxies(result.items)
          setDefaultProxyId(poolConfig.defaultEndpointId)
          setProxyLoadError(null)
        }
      },
      (cause: unknown) => {
        if (active) {
          setProxies([])
          setProxyLoadError(message(cause))
        }
      },
    )
    return () => {
      active = false
    }
  }, [proxySource, providers.length])

  function patch(changes: Partial<WindowConfig>) {
    setConfig((current) => ({ ...current, ...changes }))
    setError(null)
  }

  const visibleProxies = useMemo(() => {
    if (proxies === null) return []
    const keyword = proxyQuery.trim().toLowerCase()
    if (keyword === '') return proxies
    return proxies.filter((row) =>
      `${row.name} ${row.host}:${row.port}`.toLowerCase().includes(keyword),
    )
  }, [proxies, proxyQuery])

  async function runCheck() {
    setChecking(true)
    setCheckResult(null)
    setCheckNote(null)
    const outcome = await checkWindowProxy(
      proxySource === 'manual'
        ? { proxy: config.proxy.server.trim(), proxyPlugin: null, proxyEndpoint: null }
        : { proxy: null, proxyPlugin, proxyEndpoint: endpointId },
    )
    if (outcome.kind === 'checked') {
      setCheckResult(outcome.result)
      if (outcome.result.ok) toast.success('代理可用')
      else toast.error(outcome.result.error ?? '代理不可用')
    } else {
      setCheckNote(outcome.reason)
      toast.error(outcome.reason)
    }
    setChecking(false)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    if (Array.from(name.trim()).length > 40 || Array.from(note.trim()).length > 120) {
      setError('窗口名称最多 40 个字符，备注最多 120 个字符。')
      return
    }
    if (
      batch &&
      (!Number.isInteger(batch.count) ||
        batch.count < 1 ||
        batch.count > MAX_BATCH_WINDOWS)
    ) {
      setError(`每批可创建 1–${MAX_BATCH_WINDOWS} 个窗口。`)
      return
    }
    const browserVersion = kernel.version?.trim() ?? ''
    if (browserVersion && !/^\d+(?:\.\d+){3,4}$/.test(browserVersion)) {
      setError('内核版本需要是完整的数字版本号，例如 155.0.1.2。')
      return
    }
    submitting.current = true
    setPending(true)
    setError(null)
    try {
      const checked = parseWindowConfig(config)
      const settings: WindowSettings = {
        platform,
        note: note.trim(),
        geoip: checked.geoip,
        timezone: checked.timezone,
        locale: checked.locale,
        viewport: checked.viewport,
        fingerprintSeed: batch
          ? null
          : (checked.fingerprintSeed ??
            (window === null ? randomFingerprintSeed() : null)),
        startUrl: checked.startUrl,
      }
      if (proxySource === 'plugin' && proxyPlugin === null) {
        setError('请选择一个已启用的代理插件。')
        return
      }
      let selectedEndpoint = endpointId
      if (proxySource === 'plugin' && selectedEndpoint === null) {
        setPending(true)
        setError(null)
        const poolConfig = await getConfig()
        if (poolConfig.defaultEndpointId === null) {
          setError('请从代理池选择一条代理；当前未设置默认代理。')
          return
        }
        if (batch) {
          selectedEndpoint = Number(poolConfig.defaultEndpointId)
          if (!Number.isSafeInteger(selectedEndpoint) || selectedEndpoint < 1) {
            throw new Error('默认代理不可用，请从代理池选择一条代理。')
          }
        }
      }
      if (proxySource === 'manual' && checked.proxy.protocol !== 'direct') {
        if (checked.proxy.server.trim() === '') {
          setError('请填写代理地址，或把代理来源改为直连。')
          return
        }
      }
      setPending(true)
      setError(null)
      await onSave(
        // An unnamed window still needs a label: one English word will do.
        batch
          ? name.trim()
          : name.trim() === ''
            ? randomWindowName(takenNames)
            : name.trim(),
        proxySource === 'manual' && checked.proxy.protocol !== 'direct'
          ? checked.proxy.server
          : null,
        proxySource === 'plugin' ? proxyPlugin : null,
        proxySource === 'plugin' ? selectedEndpoint : null,
        settings,
        { kind: kernel.kind, ...(browserVersion ? { version: browserVersion } : {}) },
        groupId === 'ungrouped' ? null : groupId,
      )
    } catch (cause) {
      setError(message(cause))
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <DialogContent
      className="window-editor"
      showCloseButton={!pending}
      onEscapeKeyDown={(event) => {
        if (submitting.current) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (submitting.current) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {batch ? '批量创建窗口' : window ? '编辑窗口' : '创建窗口'}
        </DialogTitle>
        <DialogDescription className={window ? 'sr-only' : undefined}>
          {batch
            ? batch.fromAccounts
              ? `为 ${batch.count} 个账号各创建一个窗口，共用以下配置，每个窗口使用独立随机种子。`
              : '统一设置代理和浏览器配置，每个窗口使用独立随机种子。'
            : window
              ? `编辑窗口「${window.name}」的设置。`
              : '创建独立浏览器环境。可先在设置的「浏览器内核」中下载所需内核。'}
        </DialogDescription>
      </DialogHeader>
      <form
        id="window-form"
        className="window-form"
        onSubmit={(event) => void submit(event)}
      >
        <FieldGroup>
          {batch?.onCountChange ? (
            <Field>
              <FieldLabel htmlFor="window-count">创建数量</FieldLabel>
              <Input
                id="window-count"
                type="number"
                min={1}
                max={MAX_BATCH_WINDOWS}
                step={1}
                required
                disabled={pending}
                value={
                  Number.isFinite(batch.count) && batch.count !== 0 ? batch.count : ''
                }
                onChange={(event) => batch.onCountChange?.(Number(event.target.value))}
              />
              <FieldDescription>每批最多 {MAX_BATCH_WINDOWS} 个窗口。</FieldDescription>
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor="window-name">
              {batch ? '名称前缀' : '窗口名称'}
            </FieldLabel>
            <Input
              id="window-name"
              autoFocus={!batch?.onCountChange}
              maxLength={batch ? 36 : 40}
              disabled={pending}
              placeholder={
                batch
                  ? batch.fromAccounts
                    ? '留空使用账号名；填写后按 前缀-01 编号'
                    : '留空随机命名；填写后按 前缀-01 编号'
                  : '留空自动生成，例如 meadow'
              }
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {batch?.fields ? <fieldset disabled={pending}>{batch.fields}</fieldset> : null}
          {!window ? (
            <WindowKernelPicker
              value={kernel}
              onChange={(selection) => {
                setKernel(selection)
                setError(null)
              }}
              license={licenseStatus}
              installed={installedKernels}
              loading={kernelsLoading}
              error={kernelsError}
              disabled={pending}
            />
          ) : null}
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="window-platform">平台</FieldLabel>
              <Select
                value={platform}
                disabled={pending || batch?.fromAccounts}
                onValueChange={(value) => {
                  if (value === 'Vinted' || value === 'Poshmark' || value === '其他') {
                    setPlatform(value)
                  }
                }}
              >
                <SelectTrigger id="window-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="Vinted">Vinted</SelectItem>
                    <SelectItem value="Poshmark">Poshmark</SelectItem>
                    <SelectItem value="其他">其他</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="window-note">备注</FieldLabel>
              <Input
                id="window-note"
                maxLength={120}
                disabled={pending}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="window-group">分组</FieldLabel>
            <Select value={groupId} disabled={pending} onValueChange={setGroupId}>
              <SelectTrigger id="window-group">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ungrouped">未分组</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <h3>连接与地域</h3>
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="window-proxy-source">代理来源</FieldLabel>
              <Select
                value={proxySource}
                disabled={pending}
                onValueChange={(value) => {
                  if (value !== 'direct' && value !== 'manual' && value !== 'plugin')
                    return
                  setProxySource(value)
                  setCheckResult(null)
                  setCheckNote(null)
                  if (value === 'direct') {
                    setProxyPlugin(null)
                    setEndpointId(null)
                    patch({ proxy: { protocol: 'direct', server: '' } })
                  } else if (value === 'manual') {
                    setProxyPlugin(null)
                    setEndpointId(null)
                    patch({ proxy: { protocol: 'http', server: '' } })
                  } else {
                    setProxyPlugin(providers[0]?.id ?? null)
                    setEndpointId(null)
                    patch({ proxy: { protocol: 'direct', server: '' } })
                  }
                }}
              >
                <SelectTrigger id="window-proxy-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="direct">直连</SelectItem>
                    <SelectItem value="manual">手动填写</SelectItem>
                    <SelectItem value="plugin">代理池</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {proxySource === 'manual' ? (
              <>
                <Field>
                  <FieldLabel htmlFor="window-protocol">协议</FieldLabel>
                  <Select
                    value={config.proxy.protocol === 'socks5' ? 'socks5' : 'http'}
                    disabled={pending}
                    onValueChange={(value) => {
                      if (value === 'http' || value === 'socks5') {
                        patch({ proxy: { protocol: value, server: config.proxy.server } })
                        setCheckResult(null)
                      }
                    }}
                  >
                    <SelectTrigger id="window-protocol">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="http">HTTP</SelectItem>
                        <SelectItem value="socks5">SOCKS5</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="window-proxy">代理地址</FieldLabel>
                  <Input
                    id="window-proxy"
                    maxLength={200}
                    disabled={pending}
                    placeholder={`${config.proxy.protocol}://host:port`}
                    value={config.proxy.server}
                    onChange={(event) => {
                      patch({ proxy: { ...config.proxy, server: event.target.value } })
                      setCheckResult(null)
                    }}
                  />
                </Field>
              </>
            ) : null}
            {proxySource === 'plugin' ? (
              <Field className="window-proxy-plugin-field">
                <FieldLabel htmlFor="window-proxy-plugin">代理插件</FieldLabel>
                {providers.length === 0 ? (
                  <p className="window-plugin-hint">
                    没有运行中的代理插件。先到「插件中心 → 代理池」启用并添加代理。
                  </p>
                ) : (
                  <Select
                    value={proxyPlugin ?? ''}
                    disabled={pending}
                    onValueChange={(value) => {
                      setProxyPlugin(value)
                      setEndpointId(null)
                      setCheckResult(null)
                    }}
                  >
                    <SelectTrigger id="window-proxy-plugin">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {providers.map((entry) => (
                          <SelectItem key={entry.id} value={entry.id}>
                            {entry.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              </Field>
            ) : null}
          </div>

          {proxySource === 'plugin' && providers.length > 0 ? (
            <div className="proxy-picker">
              <div className="proxy-picker-head">
                <span>从代理池选择</span>
                <small>{proxies === null ? '加载中…' : `${proxies.length} 条`}</small>
              </div>
              <div className="search-field">
                <Search aria-hidden="true" />
                <Input
                  aria-label="搜索代理"
                  placeholder="搜索名称、主机或端口"
                  value={proxyQuery}
                  onChange={(event) => setProxyQuery(event.target.value)}
                />
              </div>
              <div className="account-picker" role="listbox" aria-label="代理池代理">
                <button
                  type="button"
                  role="option"
                  aria-selected={endpointId === null && defaultProxyId !== null}
                  className="account-option"
                  data-selected={
                    endpointId === null && defaultProxyId !== null ? 'true' : undefined
                  }
                  disabled={pending || proxies === null || defaultProxyId === null}
                  onClick={() => {
                    setEndpointId(null)
                    setCheckResult(null)
                    setError(null)
                  }}
                >
                  <span>
                    <strong>{batch ? '使用当前默认代理' : '使用插件默认代理'}</strong>
                    <small>
                      {proxies === null
                        ? '正在读取默认项…'
                        : defaultProxyId === null
                          ? '尚未设置，请选择下方的具体代理'
                          : batch
                            ? `本批次固定使用默认代理 #${defaultProxyId}`
                            : `跟随默认代理 #${defaultProxyId}`}
                    </small>
                  </span>
                  {endpointId === null && defaultProxyId !== null ? (
                    <Check aria-hidden="true" />
                  ) : null}
                </button>
                {visibleProxies.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    aria-selected={endpointId === Number(row.id)}
                    className="account-option"
                    data-selected={endpointId === Number(row.id) ? 'true' : undefined}
                    disabled={pending || !row.enabled}
                    onClick={() => {
                      setEndpointId(Number(row.id))
                      setCheckResult(null)
                      setError(null)
                    }}
                  >
                    <span>
                      <strong>
                        {flagOf(row.geo?.countryCode ?? null)} {row.name}
                      </strong>
                      <small>
                        {row.schemes.map((scheme) => scheme.toUpperCase()).join(' / ')} ·{' '}
                        {row.host}:{row.port}
                        {!row.enabled ? ' · 已停用' : ''}
                        {row.checkStatus === 'ok' ? ' · 上次检测通过' : ''}
                      </small>
                    </span>
                    {endpointId === Number(row.id) ? <Check aria-hidden="true" /> : null}
                  </button>
                ))}
                {proxies !== null && visibleProxies.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {proxyLoadError
                      ? `代理池读取失败：${proxyLoadError}`
                      : proxyQuery.trim()
                        ? '没有匹配的代理。'
                        : '代理池还没有代理。'}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {proxySource !== 'direct' ? (
            <div className="proxy-check-block">
              <div className="proxy-check-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    pending ||
                    checking ||
                    (proxySource === 'manual' && config.proxy.server.trim() === '')
                  }
                  onClick={() => void runCheck()}
                >
                  {checking ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <ShieldCheck data-icon="inline-start" />
                  )}
                  {checking ? '检测中…' : '检测代理'}
                </Button>
                <span className="proxy-check-hint">
                  使用代理池插件的检测逻辑；不可用时会说明原因。
                </span>
              </div>
              {checkResult === null ? null : <ProxyCheckSummary result={checkResult} />}
              {checkNote === null ? null : (
                <p className="proxy-check-error" role="alert">
                  {checkNote}
                </p>
              )}
            </div>
          ) : null}

          <Field className="window-switch-field" orientation="horizontal">
            <FieldLabel htmlFor="window-geoip">
              通过代理 IP 匹配时区、语言和 WebRTC IP
            </FieldLabel>
            <Switch
              id="window-geoip"
              disabled={pending}
              checked={config.geoip}
              onCheckedChange={(checked) => patch({ geoip: checked })}
            />
          </Field>
          {proxySource === 'direct' ? (
            <p className="text-xs text-muted-foreground">
              直连时保留自动匹配偏好但不生效；配置代理后才按代理出口匹配。
            </p>
          ) : null}
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="window-timezone">时区覆盖</FieldLabel>
              <Input
                id="window-timezone"
                maxLength={64}
                disabled={pending}
                placeholder="默认 / America/New_York"
                value={config.timezone}
                onChange={(event) => patch({ timezone: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="window-locale">语言覆盖</FieldLabel>
              <Input
                id="window-locale"
                maxLength={35}
                disabled={pending}
                placeholder="默认 / en-US"
                value={config.locale}
                onChange={(event) => patch({ locale: event.target.value })}
              />
            </Field>
          </div>
          <h3>浏览器环境</h3>
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="window-viewport">窗口尺寸</FieldLabel>
              <Select
                value={config.viewport}
                disabled={pending}
                onValueChange={(value) => {
                  if (
                    value === 'default' ||
                    value === '1440x900' ||
                    value === '1920x1080'
                  ) {
                    patch({ viewport: value })
                  }
                }}
              >
                <SelectTrigger id="window-viewport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="default">浏览器默认</SelectItem>
                    <SelectItem value="1440x900">1440 × 900</SelectItem>
                    <SelectItem value="1920x1080">1920 × 1080</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {batch ? (
              <Field>
                <FieldLabel htmlFor="window-seed">指纹种子</FieldLabel>
                <Input id="window-seed" value="每个窗口独立随机生成" readOnly />
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="window-seed">指纹种子</FieldLabel>
                <div className="seed-field">
                  <Input
                    id="window-seed"
                    inputMode="numeric"
                    disabled={pending || !!window}
                    placeholder="自动保持"
                    value={config.fingerprintSeed ?? ''}
                    onChange={(event) =>
                      patch({
                        fingerprintSeed:
                          event.target.value === '' ? null : Number(event.target.value),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="随机生成指纹种子"
                    disabled={pending || !!window}
                    onClick={() => patch({ fingerprintSeed: randomFingerprintSeed() })}
                  >
                    <Dices />
                  </Button>
                </div>
              </Field>
            )}
          </div>
          <Field>
            <FieldLabel htmlFor="window-url">起始地址</FieldLabel>
            <Input
              id="window-url"
              type="url"
              maxLength={2048}
              disabled={pending}
              placeholder="https://example.com"
              value={config.startUrl}
              onChange={(event) => patch({ startUrl: event.target.value })}
            />
          </Field>
          {error ? <FieldError role="alert">{error}</FieldError> : null}
        </FieldGroup>
      </form>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" form="window-form" disabled={pending}>
          {pending
            ? batch
              ? '正在检查配置…'
              : window
                ? '正在保存…'
                : '正在准备内核…'
            : batch
              ? `创建 ${batch.count || 0} 个窗口`
              : window
                ? '保存窗口'
                : '创建窗口'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
