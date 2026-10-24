import { Columns3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LabeledSelect } from '@/components/ui/labeled-select'

export function TablePager({
  page,
  pageSize,
  total,
  busy = false,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageSize: number
  total: number
  busy?: boolean
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="text-xs text-muted-foreground">
        共 {total} 条 · 第 {page + 1} / {pages} 页
      </span>
      <div className="flex items-center gap-2">
        <LabeledSelect
          ariaLabel="每页条数"
          value={String(pageSize)}
          options={[10, 20, 50, 100].map((size) => ({
            value: String(size),
            label: `${size} 条 / 页`,
          }))}
          onValueChange={(value) => onPageSizeChange(Number(value))}
          disabled={busy}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || page + 1 >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  )
}

export function ColumnMenu({
  columns,
  hidden,
  onChange,
}: {
  columns: ReadonlyArray<{ id: string; label: string }>
  hidden: string[]
  onChange: (hidden: string[]) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Columns3 data-icon="inline-start" />
          显示列
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>表格列</DropdownMenuLabel>
        <DropdownMenuGroup>
          {columns.map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={!hidden.includes(column.id)}
              disabled={
                !hidden.includes(column.id) && hidden.length === columns.length - 1
              }
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? hidden.filter((id) => id !== column.id)
                    : [...hidden, column.id],
                )
              }
            >
              {column.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
