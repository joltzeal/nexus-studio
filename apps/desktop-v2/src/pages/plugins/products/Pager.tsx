import { IconButton, Select } from '@proxyshard/shardx-ui-kit'
import { BackIcon, ChevronRightIcon } from '../../../shared/icons'

const pageSizes = [
  { value: '20', label: '20 条/页' },
  { value: '50', label: '50 条/页' },
]

export function Pager({
  page,
  pageSize,
  total,
  busy,
  onChange,
}: {
  page: number
  pageSize: 20 | 50
  total?: number
  busy: boolean
  onChange: (page: number, pageSize: 20 | 50) => void
}) {
  const pages = total === undefined ? undefined : Math.max(1, Math.ceil(total / pageSize))
  const disabled = busy || pages === undefined
  return (
    <div
      className="flex min-w-0 shrink-0 flex-nowrap items-center gap-3 border-t border-stroke-soft-200 pt-2 text-secondary text-text-sub-600"
      role="group"
      aria-label="分页"
    >
      <span className="min-w-0 flex-1 truncate tabular-nums" aria-live="polite">
        {total !== undefined && `共 ${total} 条 · `}
        {pages === undefined ? `第 ${page} 页` : `第 ${page} / ${pages} 页`}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <div className="mr-1 w-24">
          <Select
            size="xsmall"
            aria-label="每页条数"
            value={String(pageSize)}
            options={pageSizes}
            disabled={disabled}
            onChange={(value) => {
              const nextSize = value === '50' ? 50 : 20
              if (nextSize !== pageSize) onChange(1, nextSize)
            }}
          />
        </div>
        <IconButton
          type="button"
          label="上一页"
          icon={<BackIcon className="size-3.5" />}
          disabled={disabled || page <= 1}
          onClick={() => onChange(page - 1, pageSize)}
        />
        <IconButton
          type="button"
          label="下一页"
          icon={<ChevronRightIcon className="size-3.5" />}
          disabled={disabled || page >= (pages ?? 1)}
          onClick={() => onChange(page + 1, pageSize)}
        />
      </div>
    </div>
  )
}
