import { useEffect, useMemo, useState } from 'react'
import { Check, RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listNativeProfiles } from '@/lib/platform/native-profiles'
import { getConfig, listPickerProxies } from './api'
import { indexProxyUsage, proxyUsageLabel, type ProxyUsageState } from './proxy-usage'
import { addressOf, flagOf, matchesProxyQuery, message, type ProxyRow } from './types'

function UsageLabel({
  state,
  endpointId,
}: {
  state: ProxyUsageState
  endpointId: string
}) {
  const label = proxyUsageLabel(state, endpointId)
  return (
    <small className="line-clamp-2 whitespace-normal wrap-anywhere" title={label}>
      {label}
    </small>
  )
}

export function ProxyPickerOption({
  row,
  selected,
  usage,
  disabled,
  onSelect,
}: {
  row: ProxyRow
  selected: boolean
  usage: ProxyUsageState
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className="account-option min-w-0"
      data-selected={selected ? 'true' : undefined}
      disabled={disabled || !row.enabled}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1">
        <strong className="truncate" title={row.name}>
          {flagOf(row.geo?.countryCode ?? null)} {row.name}
        </strong>
        <small className="block truncate" title={addressOf(row)}>
          {row.schemes.map((scheme) => scheme.toUpperCase()).join(' / ')} ·{' '}
          {addressOf(row)}
          {!row.enabled ? ' · 已停用' : ''}
          {row.checkStatus === 'ok' ? ' · 上次检测通过' : ''}
        </small>
        <small className="block truncate" title={row.username}>
          用户名：{row.username || '未设置'}
        </small>
        <UsageLabel state={usage} endpointId={row.id} />
      </span>
      {selected ? <Check aria-hidden="true" /> : null}
    </button>
  )
}

export function ProxyPicker({
  endpointId,
  currentWindowId,
  batch = false,
  disabled,
  onChange,
}: {
  endpointId: number | null
  currentWindowId: string | null
  batch?: boolean
  disabled: boolean
  onChange: (endpointId: number | null) => void
}) {
  const [proxies, setProxies] = useState<ProxyRow[] | null>(null)
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [usage, setUsage] = useState<ProxyUsageState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    // Share the same default snapshot so the picker and usage cannot disagree.
    const config = getConfig()
    void Promise.all([listPickerProxies(), config]).then(
      ([rows, poolConfig]) => {
        if (!active) return
        setProxies(rows)
        setDefaultId(poolConfig.defaultEndpointId)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    void Promise.all([listNativeProfiles(), config]).then(
      ([profiles, poolConfig]) => {
        if (!active) return
        setUsage({
          status: 'loaded',
          byEndpoint: indexProxyUsage(
            profiles,
            poolConfig.defaultEndpointId,
            currentWindowId,
          ),
        })
      },
      (cause: unknown) => {
        if (active) setUsage({ status: 'error', message: message(cause) })
      },
    )
    return () => {
      active = false
    }
  }, [currentWindowId, revision])

  const visibleProxies = useMemo(
    () => proxies?.filter((row) => matchesProxyQuery(row, query)) ?? [],
    [proxies, query],
  )
  const defaultProxy = proxies?.find((row) => row.id === defaultId)
  const loading = proxies === null && error === null
  const defaultSelected = endpointId === null && defaultId !== null

  function refresh() {
    setProxies(null)
    setDefaultId(null)
    setError(null)
    setUsage({ status: 'loading' })
    setRevision((current) => current + 1)
  }

  return (
    <div className="proxy-picker min-w-0">
      <div className="proxy-picker-head">
        <span>从代理池选择</span>
        <div className="flex items-center gap-2">
          <small>
            {error ? '读取失败' : loading ? '加载中…' : `${proxies?.length ?? 0} 条`}
          </small>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="刷新代理与窗口占用"
            disabled={disabled || loading}
            onClick={refresh}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="search-field">
        <Search aria-hidden="true" />
        <Input
          aria-label="搜索代理"
          placeholder="搜索名称、主机、端口或用户名"
          disabled={disabled}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {error ? (
        <p className="text-xs text-destructive wrap-anywhere" role="alert">
          代理池读取失败：{error}
        </p>
      ) : null}
      {error === null && usage.status === 'error' ? (
        <p className="text-xs text-destructive wrap-anywhere" role="alert">
          窗口占用未知：{usage.message}。可刷新重试，仍可选择代理。
        </p>
      ) : null}
      <div className="account-picker min-w-0" role="listbox" aria-label="代理池代理">
        <button
          type="button"
          role="option"
          aria-selected={defaultSelected}
          className="account-option min-w-0"
          data-selected={defaultSelected ? 'true' : undefined}
          disabled={disabled || loading || error !== null || defaultId === null}
          onClick={() => onChange(null)}
        >
          <span className="min-w-0 flex-1">
            <strong>{batch ? '使用当前默认代理' : '使用插件默认代理'}</strong>
            <small className="block truncate">
              {error
                ? '默认项读取失败'
                : loading
                  ? '正在读取默认项…'
                  : defaultId === null
                    ? '尚未设置，请选择下方的具体代理'
                    : batch
                      ? `本批次固定使用默认代理 #${defaultId}`
                      : `跟随默认代理 #${defaultId}`}
            </small>
            {defaultProxy ? (
              <>
                <small
                  className="block truncate"
                  title={`${defaultProxy.name} · ${addressOf(defaultProxy)}`}
                >
                  {defaultProxy.name} · {addressOf(defaultProxy)}
                  {!defaultProxy.enabled ? ' · 已停用' : ''}
                </small>
                <small className="block truncate" title={defaultProxy.username}>
                  用户名：{defaultProxy.username || '未设置'}
                </small>
              </>
            ) : null}
            {defaultId === null ? null : (
              <UsageLabel state={usage} endpointId={defaultId} />
            )}
          </span>
          {defaultSelected ? <Check aria-hidden="true" /> : null}
        </button>
        {visibleProxies.map((row) => (
          <ProxyPickerOption
            key={row.id}
            row={row}
            selected={endpointId === Number(row.id)}
            usage={usage}
            disabled={disabled}
            onSelect={() => onChange(Number(row.id))}
          />
        ))}
        {proxies !== null && visibleProxies.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {query.trim() ? '没有匹配的代理。' : '代理池还没有代理。'}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        占用按已保存的窗口配置统计，包含跟随默认项的窗口；可继续选择并共用代理。
      </p>
    </div>
  )
}
