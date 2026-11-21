import { ChevronLeft, ChevronRight } from './icons'
import { Button, LabeledSelect } from './controls'

export function AgentPagination({
  label,
  total,
  page,
  pageSize,
  busy = false,
  sizes = [20, 50],
  onPage,
  onPageSize,
}: {
  label: string
  total: number
  page: number
  pageSize: number
  busy?: boolean
  sizes?: number[]
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 overflow-x-auto border-t border-stroke-soft-200 py-2 text-help tabular-nums [&>*]:shrink-0">
      <span>
        共 {total} 个{label} · 第 {page} / {pages} 页
      </span>
      <LabeledSelect
        ariaLabel={`每页${label}数`}
        value={String(pageSize)}
        disabled={busy}
        options={sizes.map((size) => ({ value: String(size), label: `${size} / 页` }))}
        onValueChange={(value) => onPageSize(Number(value))}
      />
      <Button
        variant="outline"
        size="icon"
        aria-label={`上一页${label}`}
        disabled={busy || page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft />
      </Button>
      <Button
        variant="outline"
        size="icon"
        aria-label={`下一页${label}`}
        disabled={busy || page >= pages}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight />
      </Button>
    </div>
  )
}
