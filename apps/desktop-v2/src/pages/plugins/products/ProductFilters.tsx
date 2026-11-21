import { Button, Select } from '@proxyshard/shardx-ui-kit'
import type { ProductQuery } from '@nexus/plugin-contracts/products'
import {
  publicationLabels,
  sourceLabels,
  statusLabels,
} from '../../../raccoon/plugins/products/model'
import { PluginFilterRow, PluginSearch } from '../PluginFilterRow'

function options(labels: Record<string, string>) {
  return [
    { value: 'all', label: '全部' },
    ...Object.entries(labels).map(([value, label]) => ({ value, label })),
  ]
}

export function ProductFilters({
  query,
  onChange,
}: {
  query: ProductQuery
  onChange: (query: ProductQuery) => void
}) {
  const update = (patch: Partial<ProductQuery>) =>
    onChange({ ...query, ...patch, page: 1 })
  return (
    <PluginFilterRow label="商品筛选条件">
      <PluginSearch
        pageShortcut
        label="搜索商品"
        value={query.query}
        maxLength={200}
        placeholder="名称、标题、分类或刊登 ID"
        onChange={(event) => update({ query: event.target.value })}
      />
      <div className="w-[112px]">
        <Select
          size="xsmall"
          label="准备状态"
          value={query.status ?? 'all'}
          options={options(statusLabels)}
          onChange={(value) =>
            update({
              status: value === 'all' ? undefined : (value as ProductQuery['status']),
            })
          }
        />
      </div>
      <div className="w-[112px]">
        <Select
          size="xsmall"
          label="发布状态"
          value={query.publicationStatus ?? 'all'}
          options={options(publicationLabels)}
          onChange={(value) =>
            update({
              publicationStatus:
                value === 'all'
                  ? undefined
                  : (value as ProductQuery['publicationStatus']),
            })
          }
        />
      </div>
      <div className="w-[128px]">
        <Select
          size="xsmall"
          label="商品来源"
          value={query.sourceKind ?? 'all'}
          options={options(sourceLabels)}
          onChange={(value) =>
            update({
              sourceKind:
                value === 'all' ? undefined : (value as ProductQuery['sourceKind']),
            })
          }
        />
      </div>
      <Button
        size="xsmall"
        mode="ghost"
        variant="neutral"
        disabled={
          !query.query && !query.status && !query.publicationStatus && !query.sourceKind
        }
        onClick={() => onChange({ query: '', page: 1, pageSize: query.pageSize })}
      >
        清除
      </Button>
    </PluginFilterRow>
  )
}
