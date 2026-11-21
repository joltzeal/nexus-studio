import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Combobox, type ComboboxOption } from '@proxyshard/shardx-ui-kit'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import { proxySiteApi } from '../../../raccoon/plugins/proxy-pool/providers'
import {
  addressOf,
  EMPTY_QUERY,
  PROXY_PLUGIN_ID,
  type ProxyRow,
} from '../../../raccoon/plugins/proxy-pool/model'
import { poolProxyChoice, poolProxyEndpoint } from '../../../raccoon/profile-proxy'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { useWorkspace } from '../../../raccoon/store'
import { BackIcon, ChevronRightIcon, RouteIcon } from '../../../shared/icons'
import { useT } from '../../../shared/i18n'
import { ProxyFlag } from '../../../shared/ui/ProxyFlag'

const poolName = '代理池'
const pageSize = 100

function usePoolSession() {
  return usePluginCatalog(({ plugins }) => {
    const plugin = plugins.find((item) => item.id === PROXY_PLUGIN_ID)
    if (
      !isNativeRaccoon() ||
      !plugin?.enabled ||
      plugin.state !== 'running' ||
      !plugin.capabilities.includes('proxy.provider') ||
      !plugin.granted.includes('proxy.provider') ||
      !['proxy.list', 'proxy.get', 'proxy.resolve'].every((method) =>
        plugin.methods.includes(method),
      )
    )
      return null
    return JSON.stringify([
      plugin.version,
      plugin.installation,
      plugin.runtimeGeneration,
      plugin.methods.includes('proxy.providerSubscriptions.list'),
    ])
  })
}

export function useWorkspaceProxyPool() {
  const { connections, connectionId, probe } = useWorkspace()
  return (
    connections.some(
      (connection) =>
        connection.id === connectionId && connection.capabilities.proxyPlugin,
    ) && probe?.capabilities.proxyPlugin === true
  )
}

export function useProxyPoolAvailable() {
  return usePoolSession() !== null
}

export function usePoolProxyLabel(value: string | null | undefined) {
  const endpoint = poolProxyEndpoint(value)
  const session = usePoolSession()
  const key = session && endpoint !== null ? `${session}:${endpoint}` : null
  const [result, setResult] = useState<{ key: string; label: string } | null>(null)
  useEffect(() => {
    if (!key || endpoint === null) return
    let active = true
    void proxyPoolApi.get(endpoint).then(
      async (row) => {
        let subscriptionName = ''
        if (row.origin) {
          try {
            const subscriptions = await proxySiteApi.subscriptions()
            subscriptionName =
              subscriptions.find((item) => item.id === row.origin?.subscriptionId)
                ?.name ?? ''
          } catch {
            subscriptionName = ''
          }
        }
        if (active)
          setResult({
            key,
            label: `${poolName} / ${subscriptionName ? `${subscriptionName} / ` : ''}${row.name || addressOf(row)}${row.enabled ? '' : '（已停用）'}`,
          })
      },
      () => {
        if (active) setResult({ key, label: `${poolName} / #${endpoint}（端点不可用）` })
      },
    )
    return () => {
      active = false
    }
  }, [key, endpoint])
  if (endpoint === null) return null
  if (!session) return `${poolName} / #${endpoint}（插件不可用）`
  return result?.key === key ? result.label : `${poolName} / #${endpoint}`
}

function poolOption(
  row: ProxyRow,
  group: string | undefined,
  blocked: boolean,
  subscriptionName: string | undefined,
): ComboboxOption {
  const address = addressOf(row)
  const label = row.name || address
  const risk = row.reputation?.status === 'ok' ? row.reputation.risk : null
  const quality = risk === null ? '风险未检测' : `风险 ${risk}/100`
  const tags = [
    subscriptionName,
    group,
    row.reputation?.provider,
    row.reputation?.networkType,
  ]
  const facts = [
    row.geo?.status === 'ok' ? row.geo.city || row.geo.country : null,
    ...tags,
    row.checkStatus === 'failed'
      ? '检测失败'
      : row.latencyMs !== null
        ? `${row.latencyMs} ms`
        : '未检测',
    !row.enabled ? '已停用' : null,
  ].filter((value): value is string => !!value)
  return {
    value: poolProxyChoice(row.id),
    label,
    keywords: [address, row.username, ...row.schemes, ...facts, quality],
    hint: quality,
    content: (
      <span className="flex min-w-0 items-center gap-2">
        <ProxyFlag cc={row.geo?.countryCode ?? ''} height={14} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate leading-none">
            {label} · {row.schemes.map((scheme) => scheme.toUpperCase()).join(' / ')}
          </span>
          <span className="truncate text-secondary leading-none text-text-sub-600">
            {facts.join(' · ')}
          </span>
        </span>
      </span>
    ),
    disabled: !row.enabled || blocked,
  }
}

type Selection =
  | { multiple?: false; value: string | null; onChange: (value: string) => void }
  | {
      multiple: true
      value: string[]
      onChange: (value: string, checked: boolean) => void
    }

type Props = Selection & {
  options: ComboboxOption[]
  allowPool: boolean
  label: string
  autoFocus?: boolean
  create?: (query: string) => void
  canCreate?: (query: string) => boolean
  createLabel?: (query: string) => string
  footer?: ReactNode
  unavailableChoices?: ReadonlySet<string>
}

export function ProxyChoiceList(props: Props) {
  const t = useT()
  const session = usePoolSession()
  const [inside, setInside] = useState(false)
  const [query, setQuery] = useState('')
  const entry = useRef<HTMLButtonElement>(null)
  const back = () => {
    setInside(false)
    requestAnimationFrame(() => entry.current?.focus())
  }
  return (
    <div
      className="min-w-0"
      onKeyDown={(event) => {
        if (!inside || event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        back()
      }}
    >
      <div hidden={inside}>
        {props.allowPool && session && (
          <div className="border-b border-stroke-soft-200 p-1">
            <Button
              ref={entry}
              className="w-full"
              size="xsmall"
              mode="ghost"
              variant="neutral"
              contentAlign="start"
              leftIcon={<RouteIcon className="size-3.5" />}
              onClick={() => setInside(true)}
            >
              <span className="flex w-full items-center justify-between gap-2">
                {poolName}
                <ChevronRightIcon className="size-3.5" />
              </span>
            </Button>
          </div>
        )}
        <Combobox
          {...selectionOf(props)}
          aria-label={props.label}
          query={query}
          onQueryChange={setQuery}
          placeholder={t('proxySelect.searchPlaceholder')}
          emptyText={t('proxySelect.noMatches')}
          options={props.options}
          onCreate={
            props.canCreate && !props.canCreate(query.trim()) ? undefined : props.create
          }
          createLabel={props.createLabel}
          autoFocus={props.autoFocus}
        />
        {props.footer}
      </div>
      {inside && (
        <PoolChoices
          key={session ?? 'unavailable'}
          {...props}
          session={session}
          back={back}
        />
      )}
    </div>
  )
}

function selectionOf(props: Selection): Selection {
  return props.multiple
    ? { multiple: true, value: props.value, onChange: props.onChange }
    : { value: props.value, onChange: props.onChange }
}

function PoolChoices(props: Props & { session: string | null; back: () => void }) {
  const { session } = props
  const hasGroups = usePluginCatalog(({ plugins }) =>
    plugins.some(
      (plugin) =>
        plugin.id === PROXY_PLUGIN_ID && plugin.methods.includes('proxy.groups.list'),
    ),
  )
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [inventory, setInventory] = useState<{ row: ProxyRow; group?: string }[]>([])
  const [subscriptions, setSubscriptions] = useState<{ id: string; name: string }[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const hasSubscriptions = usePluginCatalog(({ plugins }) =>
    plugins.some(
      (plugin) =>
        plugin.id === PROXY_PLUGIN_ID &&
        plugin.methods.includes('proxy.providerSubscriptions.list'),
    ),
  )
  useEffect(() => {
    if (!session || !props.allowPool) return
    let active = true
    setStatus('loading')
    setInventory([])
    const load = async () => {
      const groupRequest = hasGroups
        ? proxyPoolApi.groups().catch(() => [])
        : Promise.resolve([])
      const subscriptionRequest = hasSubscriptions
        ? proxySiteApi.subscriptions().catch(() => [])
        : Promise.resolve([])
      const rows = new Map<string, ProxyRow>()
      let groups = new Map<string, string>()
      let end = Number.POSITIVE_INFINITY
      for (let offset = 0; active; offset += pageSize) {
        const page = await proxyPoolApi.list({ ...EMPTY_QUERY, limit: pageSize, offset })
        if (offset === 0)
          groups = new Map(
            (await groupRequest).map((group) => [String(group.id), group.name]),
          )
        if (!active) return
        if (offset === 0) setSubscriptions(await subscriptionRequest)
        if (!active) return
        end = Math.min(end, page.total)
        for (const row of page.items) rows.set(row.id, row)
        setInventory(
          [...rows.values()].map((row) => ({
            row,
            group: row.groupId ? groups.get(row.groupId) : undefined,
          })),
        )
        if (offset + pageSize >= end || page.items.length === 0) break
      }
      if (active) setStatus('ready')
    }
    void load().catch(() => {
      if (active) setStatus('error')
    })
    return () => {
      active = false
    }
  }, [session, attempt, hasGroups, hasSubscriptions, props.allowPool])
  const available = !!session && props.allowPool
  const selected = props.multiple ? null : props.value
  const endpoint = poolProxyEndpoint(selected)
  const blocked = props.unavailableChoices
  const checked = props.multiple ? props.value : undefined
  const options = useMemo(() => {
    const chosen = new Set(checked)
    const rows = inventory.map(({ row, group }) => {
      const option = poolOption(
        row,
        group,
        blocked?.has(poolProxyChoice(row.id)) === true,
        row.origin
          ? subscriptions.find((item) => item.id === row.origin?.subscriptionId)?.name
          : undefined,
      )
      return chosen.has(option.value) ? { ...option, disabled: false } : option
    })
    if (status === 'ready' && chosen.size) {
      const known = new Set(rows.map((option) => option.value))
      for (const choice of chosen) {
        const endpoint = poolProxyEndpoint(choice)
        if (endpoint !== null && !known.has(choice))
          rows.unshift({ value: choice, label: `端点 #${endpoint} 不可用` })
      }
    }
    return rows
  }, [inventory, blocked, checked, status, subscriptions])
  const missing =
    endpoint !== null &&
    status === 'ready' &&
    !options.some((option) => option.value === selected)
  return (
    <>
      <div className="border-b border-stroke-soft-200 p-1">
        <Button
          size="xsmall"
          mode="ghost"
          variant="neutral"
          aria-label="返回代理列表"
          leftIcon={<BackIcon className="size-3.5" />}
          onClick={props.back}
        >
          {poolName}
        </Button>
      </div>
      {available ? (
        <>
          <Combobox
            {...selectionOf(props)}
            aria-label="搜索代理池"
            placeholder="搜索名称、地址或标签"
            query={query}
            onQueryChange={setQuery}
            options={
              missing
                ? [
                    {
                      value: selected!,
                      label: `端点 #${endpoint} 不可用`,
                      disabled: true,
                    },
                    ...options,
                  ]
                : options
            }
            emptyText={
              status === 'loading'
                ? '正在读取代理池…'
                : status === 'error'
                  ? '代理池读取失败'
                  : '没有匹配的代理'
            }
          />
          {(status === 'error' || (status === 'loading' && inventory.length > 0)) && (
            <div
              className="flex items-center justify-between gap-2 border-t border-stroke-soft-200 px-2 py-1 text-secondary text-text-sub-600"
              role="status"
            >
              {status === 'error' ? '部分代理可能未加载' : '正在读取更多代理…'}
              {status === 'error' && (
                <Button
                  size="3xsmall"
                  mode="ghost"
                  variant="neutral"
                  onClick={() => setAttempt((current) => current + 1)}
                >
                  重试
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <p role="status" className="m-0 p-2 text-secondary text-text-sub-600">
          代理池当前不可用
        </p>
      )}
    </>
  )
}
