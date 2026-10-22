import { Search, SlidersHorizontal, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ProxySelect, type ProxySelectOption } from './proxy-select'
import { SCHEMES, type ProxyGroup, type ProxyListQuery, type Scheme } from './types'

const ALL = 'all'
const FLAG_OPTIONS: ProxySelectOption[] = [
  { value: ALL, label: '不限' },
  { value: 'true', label: '是' },
  { value: 'false', label: '否' },
]

export interface ProxyFiltersProps {
  query: ProxyListQuery
  groups: ProxyGroup[]
  activeCount: number
  busy: boolean
  onChange: (patch: Partial<ProxyListQuery>) => void
  onReset: () => void
}

/**
 * Filter state maps 1:1 onto `proxy.list` parameters, so what the user sees here
 * is exactly what the plugin filters on — no client-side re-filtering.
 */
export function ProxyFilters({
  query,
  groups,
  activeCount,
  busy,
  onChange,
  onReset,
}: ProxyFiltersProps) {
  const groupValue = query.ungrouped ? 'ungrouped' : (query.groupId?.toString() ?? ALL)
  const flagValue = (value: boolean | null): string =>
    value === null ? ALL : value ? 'true' : 'false'
  const setFlag = (key: 'isProxy' | 'isVpn' | 'isHosting', value: string) => {
    onChange({
      [key]: value === ALL ? null : value === 'true',
    } as Partial<ProxyListQuery>)
  }
  const schemeOptions: ProxySelectOption[] = [
    { value: ALL, label: '全部协议' },
    ...SCHEMES.map((scheme) => ({ value: scheme, label: scheme.toUpperCase() })),
  ]
  const groupOptions: ProxySelectOption[] = [
    { value: ALL, label: '全部分组' },
    { value: 'ungrouped', label: '未分组' },
    ...groups.map((group) => ({ value: String(group.id), label: group.name })),
  ]
  return (
    <div className="proxy-filter-bar">
      <div className="search-field">
        <Search aria-hidden="true" />
        <Input
          aria-label="搜索代理"
          placeholder="搜索名称或主机"
          value={query.keyword}
          disabled={busy}
          onChange={(event) => onChange({ keyword: event.target.value, offset: 0 })}
        />
      </div>
      <ProxySelect
        ariaLabel="按协议筛选"
        className="proxy-filter-trigger"
        value={query.scheme ?? ALL}
        options={schemeOptions}
        onValueChange={(value) =>
          onChange({ scheme: value === ALL ? null : (value as Scheme), offset: 0 })
        }
      />
      <ProxySelect
        ariaLabel="按分组筛选"
        className="proxy-filter-trigger"
        value={groupValue}
        options={groupOptions}
        onValueChange={(value) =>
          onChange(
            value === ALL
              ? { groupId: null, ungrouped: false, offset: 0 }
              : value === 'ungrouped'
                ? { groupId: null, ungrouped: true, offset: 0 }
                : { groupId: Number(value), ungrouped: false, offset: 0 },
          )
        }
      />
      <ProxySelect
        ariaLabel="按状态筛选"
        className="proxy-filter-trigger"
        value={flagValue(query.enabled)}
        options={[
          { value: ALL, label: '全部状态' },
          { value: 'true', label: '启用' },
          { value: 'false', label: '停用' },
        ]}
        onValueChange={(value) =>
          onChange({ enabled: value === ALL ? null : value === 'true', offset: 0 })
        }
      />
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="proxy-filter-more">
            <SlidersHorizontal data-icon="inline-start" />
            更多筛选
            {activeCount > 3 ? (
              <Badge variant="secondary">{activeCount - 3}</Badge>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72">
          <PopoverHeader>
            <PopoverTitle>出口特征与风险</PopoverTitle>
          </PopoverHeader>
          <div className="proxy-more-filters">
            <label>
              <span>是否代理</span>
              <ProxySelect
                ariaLabel="是否代理"
                value={flagValue(query.isProxy)}
                options={FLAG_OPTIONS}
                onValueChange={(value) => setFlag('isProxy', value)}
              />
            </label>
            <label>
              <span>是否 VPN</span>
              <ProxySelect
                ariaLabel="是否 VPN"
                value={flagValue(query.isVpn)}
                options={FLAG_OPTIONS}
                onValueChange={(value) => setFlag('isVpn', value)}
              />
            </label>
            <label>
              <span>是否数据中心</span>
              <ProxySelect
                ariaLabel="是否数据中心"
                value={flagValue(query.isHosting)}
                options={FLAG_OPTIONS}
                onValueChange={(value) => setFlag('isHosting', value)}
              />
            </label>
            <div className="proxy-risk-range">
              <span>风险分区间</span>
              <div>
                <Input
                  aria-label="风险分下限"
                  inputMode="numeric"
                  placeholder="0"
                  value={query.riskMin ?? ''}
                  onChange={(event) =>
                    onChange({
                      riskMin:
                        event.target.value === '' ? null : Number(event.target.value),
                      offset: 0,
                    })
                  }
                />
                <span aria-hidden="true">–</span>
                <Input
                  aria-label="风险分上限"
                  inputMode="numeric"
                  placeholder="100"
                  value={query.riskMax ?? ''}
                  onChange={(event) =>
                    onChange({
                      riskMax:
                        event.target.value === '' ? null : Number(event.target.value),
                      offset: 0,
                    })
                  }
                />
              </div>
            </div>
            <p className="proxy-detail-note">
              风险分来自 proxycheck.io；未检测的代理不会落入风险区间。
            </p>
          </div>
        </PopoverContent>
      </Popover>
      {activeCount > 0 ? (
        <Button variant="ghost" size="sm" onClick={onReset} disabled={busy}>
          <X data-icon="inline-start" />
          清除筛选
        </Button>
      ) : null}
    </div>
  )
}
