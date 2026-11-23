import { useState } from 'react'
import { Button, Input } from '@proxyshard/shardx-ui-kit'
import { FilterMenu, type FilterField, type FilterChip } from '../../../shared/ui/filters'
import { SCHEMES, type ProxyGroup, type ProxyQuery, type Scheme } from '../../../raccoon/plugins/proxy-pool/model'

const flags = [
  ['isProxy', '代理识别'],
  ['isVpn', 'VPN'],
  ['isHosting', '数据中心'],
] as const
const booleanValues = [{ value: 'true', label: '是' }, { value: 'false', label: '否' }]

export function proxyPoolFilters(query: ProxyQuery, groups: ProxyGroup[], patch: (value: Partial<ProxyQuery>) => void) {
  const fields: FilterField[] = [
    {
      id: 'scheme',
      label: '协议',
      values: SCHEMES.map((scheme) => ({ value: scheme, label: scheme.toUpperCase() })),
      current: query.scheme,
      set: (value) => patch({ scheme: value as Scheme | null }),
    },
    {
      id: 'enabled',
      label: '状态',
      values: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }],
      current: query.enabled?.toString() ?? null,
      set: (value) => patch({ enabled: value === null ? null : value === 'true' }),
    },
    {
      id: 'group',
      label: '分组',
      values: [{ value: 'none', label: '未分组' }, ...groups.map((group) => ({ value: String(group.id), label: group.name }))],
      current: query.ungrouped ? 'none' : query.groupId?.toString() ?? null,
      set: (value) => patch({ groupId: value && value !== 'none' ? Number(value) : null, ungrouped: value === 'none' }),
    },
    ...flags.map(([id, label]): FilterField => ({
      id,
      label,
      values: booleanValues,
      current: query[id]?.toString() ?? null,
      set: (value) => patch({ [id]: value === null ? null : value === 'true' }),
    })),
  ]
  const chips: FilterChip[] = fields.flatMap((field) => field.current === null ? [] : [{
    id: field.id,
    label: `${field.label} · ${field.values.find((value) => value.value === field.current)?.label ?? field.current}`,
    onRemove: () => field.set(null),
  }])
  if (query.riskMin !== null || query.riskMax !== null) {
    chips.push({
      id: 'risk',
      label: `IP 风险 · ${query.riskMin ?? 0}–${query.riskMax ?? 100}`,
      onRemove: () => patch({ riskMin: null, riskMax: null }),
    })
  }
  return { fields, chips }
}

export function ProxyPoolFilterMenu({ fields, count, query, disabled, onChange }: {
  fields: FilterField[]
  count: number
  query: ProxyQuery
  disabled: boolean
  onChange: (value: Partial<ProxyQuery>) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <FilterMenu
      open={open}
      onOpenChange={setOpen}
      fields={fields}
      activeCount={count}
      label="代理筛选"
      disabled={disabled}
      footer={open && (
        <RiskRange
          key={`${query.riskMin}:${query.riskMax}`}
          query={query}
          disabled={disabled}
          onApply={(riskMin, riskMax) => {
            onChange({ riskMin, riskMax })
            setOpen(false)
          }}
        />
      )}
    />
  )
}

function RiskRange({ query, disabled, onApply }: {
  query: ProxyQuery
  disabled: boolean
  onApply: (min: number | null, max: number | null) => void
}) {
  const [min, setMin] = useState(query.riskMin?.toString() ?? '')
  const [max, setMax] = useState(query.riskMax?.toString() ?? '')
  const [error, setError] = useState(false)
  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        const lower = min.trim() === '' ? null : Number(min)
        const upper = max.trim() === '' ? null : Number(max)
        if ([lower, upper].some((value) => value !== null && (!Number.isInteger(value) || value < 0 || value > 100))
          || (lower !== null && upper !== null && lower > upper)) {
          setError(true)
          return
        }
        onApply(lower, upper)
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <Input label="最低风险" inputSize="xsmall" inputMode="numeric" disabled={disabled} value={min} onChange={(event) => setMin(event.target.value)} />
        <Input label="最高风险" inputSize="xsmall" inputMode="numeric" disabled={disabled} value={max} onChange={(event) => setMax(event.target.value)} />
      </div>
      {error && <p role="alert" className="m-0 text-secondary text-error-text">请输入 0–100 的整数，最低值须小于或等于最高值</p>}
      <Button type="submit" size="3xsmall" variant="neutral" mode="stroke" disabled={disabled} className="self-start">应用范围</Button>
    </form>
  )
}
