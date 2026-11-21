import { IconButton, Select } from '@proxyshard/shardx-ui-kit'
import { BackIcon, ChevronRightIcon } from '../../../shared/icons'
import {
  ACCOUNT_PAGE_SIZES,
  type AccountPageSize,
} from '../../../raccoon/plugins/vinted-accounts/table'

export function AccountPager({
  page,
  pageSize,
  total,
  busy,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageSize: AccountPageSize
  total: number
  busy: boolean
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: AccountPageSize) => void
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(Math.max(1, page), pageCount)
  return (
    <div
      className="flex min-w-0 shrink-0 flex-nowrap items-center gap-3 border-t border-stroke-soft-200 pt-2 text-secondary text-text-soft-400"
      role="group"
      aria-label="账号分页"
    >
      <span className="min-w-0 flex-1 truncate tabular-nums" aria-live="polite">
        共 {total} 个 · 第 {currentPage} / {pageCount} 页
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <div className="mr-1 w-24">
          <Select
            aria-label="每页账号数"
            size="xsmall"
            value={String(pageSize)}
            options={ACCOUNT_PAGE_SIZES.map((size) => ({
              value: String(size),
              label: `${size} 条/页`,
            }))}
            disabled={busy}
            onChange={(value) => {
              const next = ACCOUNT_PAGE_SIZES.find((size) => String(size) === value)
              if (next) onPageSizeChange(next)
            }}
          />
        </div>
        <IconButton
          type="button"
          label="上一页"
          icon={<BackIcon className="size-3.5" />}
          disabled={busy || currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
        />
        <IconButton
          type="button"
          label="下一页"
          icon={<ChevronRightIcon className="size-3.5" />}
          disabled={busy || currentPage >= pageCount}
          onClick={() => onPageChange(currentPage + 1)}
        />
      </div>
    </div>
  )
}
