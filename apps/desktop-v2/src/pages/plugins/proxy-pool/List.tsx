import { useMemo } from 'react'
import { Tooltip } from '@proxyshard/shardx-ui-kit'
import { ProxyDisplayControl } from '../../../features/manage-proxies/ui/ProxyDisplayMenu'
import { PROXY_COLUMNS, type ProxyColumnId } from '../../../entities/proxy'
import { columnChoices, setShown } from '../../../shared/lib/tableColumns'
import { CountryFlag } from '../../../shared/ui/CountryFlag'
import { ProtocolPill } from '../../../shared/ui/ProtocolPill'
import { ProxyTestPill } from '../../../shared/ui/StatusPill'
import { useListLayout, type ListColumnDef } from '../../../shared/ui/listHeader'
import { useT } from '../../../shared/i18n'
import { addressOf, type ProxyRow } from '../../../raccoon/plugins/proxy-pool/model'

type ColumnId = ProxyColumnId | 'username' | 'group' | 'status' | 'risk' | 'password'
type ListRow = {
  proxy: ProxyRow
  isDefault: boolean
  groupName: string
  profileCount: number | null
  checking: boolean
}
type Column = ListColumnDef<ColumnId, ListRow>

export function PoolTestPill({ row, busy }: { row: ProxyRow; busy: boolean }) {
  if (row.checkStatus === 'ok' && row.latencyMs !== null)
    return <ProxyTestPill className="shrink-0" state="ok" ms={row.latencyMs} busy={busy} />
  return <ProxyTestPill className="shrink-0" state={row.checkStatus === 'failed' ? 'failed' : 'untested'} busy={busy} />
}

const baseCells: Record<ProxyColumnId, Pick<Column, 'cell' | 'compare' | 'fit' | 'text' | 'role'>> = {
  name: {
    text: ({ proxy }) => proxy.name,
    compare: (left, right) => left.proxy.name.localeCompare(right.proxy.name),
    cell: ({ proxy, isDefault }) => (
      <Tooltip content={proxy.name} whenTruncated>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-ui">{proxy.name}</span>
          {isDefault && <span className="shrink-0 text-micro text-primary-text">默认</span>}
        </span>
      </Tooltip>
    ),
  },
  type: {
    text: ({ proxy }) => proxy.schemes.map((scheme) => scheme.toUpperCase()).join(' / '),
    fit: ({ proxy }) => proxy.schemes.length * 67,
    cell: ({ proxy }) => (
      <Tooltip content={proxy.schemes.map((scheme) => scheme.toUpperCase()).join(' / ')}>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {proxy.schemes.map((scheme) => <ProtocolPill key={scheme} kind={scheme} />)}
        </span>
      </Tooltip>
    ),
  },
  address: {
    text: ({ proxy }) => addressOf(proxy),
    role: 'mono',
    compare: (left, right) => left.proxy.host.localeCompare(right.proxy.host) || left.proxy.port - right.proxy.port,
  },
  country: {
    text: ({ proxy }) => proxy.geo?.city || proxy.geo?.country || '',
    fit: ({ proxy }, measure) => 22 + measure(proxy.geo?.city || proxy.geo?.country || '', 'secondary'),
    cell: ({ proxy }) => {
      const geo = proxy.geo
      const place = geo?.city || geo?.country || geo?.countryCode
      return place ? (
        <Tooltip content={place} whenTruncated>
          <span className="flex min-w-0 items-center gap-1.5 text-secondary text-text-sub-600">
            {geo?.countryCode && <CountryFlag cc={geo.countryCode} />}
            <span className="truncate">{place}</span>
          </span>
        </Tooltip>
      ) : <span className="text-text-soft-400">—</span>
    },
  },
  profiles: {
    text: ({ profileCount }) => profileCount === null ? '' : String(profileCount),
    role: 'tabular',
    compare: (left, right) => (left.profileCount ?? -1) - (right.profileCount ?? -1),
  },
  test: {
    fit: ({ proxy }, measure) => 110 + (proxy.exitIp ? measure(proxy.exitIp, 'mono') : 0),
    compare: (left, right) => (left.proxy.latencyMs ?? Infinity) - (right.proxy.latencyMs ?? Infinity) || 0,
    cell: ({ proxy, checking }) => (
      <div className="flex min-w-0 items-center gap-1.5">
        <Tooltip content={proxy.checkError || proxy.exitIp || undefined}>
          <PoolTestPill row={proxy} busy={checking} />
        </Tooltip>
        {!checking && proxy.checkStatus === 'ok' && proxy.exitIp && (
          <Tooltip content={proxy.exitIp} whenTruncated>
            <span className="mono min-w-0 truncate text-secondary text-text-sub-600">{proxy.exitIp}</span>
          </Tooltip>
        )}
      </div>
    ),
  },
}
const optional = { shown: false, hideable: true, movable: true } as const
const columns: readonly Column[] = [
  ...PROXY_COLUMNS.map((column) => ({ ...column, ...baseCells[column.id] })),
  { ...optional, id: 'username', title: () => '用户名', need: 120, min: 88, max: 360, text: ({ proxy }) => proxy.username, compare: (left, right) => left.proxy.username.localeCompare(right.proxy.username) },
  { ...optional, id: 'group', title: () => '分组', need: 96, min: 64, max: 240, text: ({ groupName }) => groupName },
  { ...optional, id: 'status', title: () => '状态', need: 80, min: 60, max: 128, text: ({ proxy }) => proxy.enabled ? '启用' : '停用' },
  { ...optional, id: 'risk', title: () => 'IP 风险', need: 104, min: 72, max: 180, text: ({ proxy }) => proxy.reputation?.risk == null ? '' : `${proxy.reputation.risk} / 100`, compare: (left, right) => (left.proxy.reputation?.risk ?? 101) - (right.proxy.reputation?.risk ?? 101) },
  { ...optional, id: 'password', title: () => '密码', need: 80, min: 64, max: 140, text: ({ proxy }) => proxy.hasPassword ? '已配置' : '未配置' },
]

export function useProxyPoolList({ rows, defaultId, groupName, profileCounts, checking }: {
  rows: ProxyRow[]
  defaultId: string | null
  groupName: (row: ProxyRow) => string
  profileCounts: ReadonlyMap<string, number> | null
  checking: ReadonlySet<string> | undefined
}) {
  const t = useT()
  const items = useMemo(() => rows.map((proxy) => ({
    proxy,
    isDefault: defaultId === proxy.id,
    groupName: groupName(proxy),
    profileCount: profileCounts ? profileCounts.get(proxy.id) ?? 0 : null,
    checking: checking?.has(proxy.id) ?? false,
  })), [rows, defaultId, groupName, profileCounts, checking])
  const list = useListLayout({
    storageKey: 'raccoon.proxy-pool.layout',
    defs: columns,
    items,
    selectable: true,
    tail: 24,
    actionsLabel: t('proxyList.colActions'),
  })
  const display = (
    <ProxyDisplayControl
      sort={list.sort ? `${list.sort.id}:${list.sort.dir}` : 'default'}
      onSort={(value) => {
        const column = columns.find(({ id, compare }) => compare && value.startsWith(`${id}:`))
        list.setSort(column ? { id: column.id, dir: value.endsWith(':descending') ? 'descending' : 'ascending' } : null)
      }}
      sortOptions={[
        { value: 'default', label: t('profileFilterBar.orderAdded') },
        ...columns.filter((column) => column.compare).flatMap((column) => [
          { value: `${column.id}:ascending`, label: `${column.title(t)} ↑` },
          { value: `${column.id}:descending`, label: `${column.title(t)} ↓` },
        ]),
      ]}
      choices={columnChoices(columns, list.api.set, list.table, t)}
      onToggle={(id, shown) => list.api.setSet(setShown(columns, list.api.set, id, shown))}
      changed={!list.api.pristine}
      onReset={list.api.reset}
    />
  )
  return { ...list, display }
}
