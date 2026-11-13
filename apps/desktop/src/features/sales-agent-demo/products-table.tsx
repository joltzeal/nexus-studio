import { Pencil, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  conditionOptions,
  formatMoney,
  type DemoProduct,
  type DemoWindow,
} from './demo-data'
import { missingFields } from './demo-state'
import { ProductMark, ReviewBadge } from './demo-widgets'

export function ProductsTable({
  products,
  windows,
  selectedIds,
  onSelect,
  onEdit,
  onRemove,
}: {
  products: DemoProduct[]
  windows: DemoWindow[]
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  onEdit: (ids: string[]) => void
  onRemove: (ids: string[]) => void
}) {
  const selectedCount = products.filter((product) =>
    selectedIds.includes(product.id),
  ).length
  return (
    <Table aria-label="待上架商品">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              aria-label="选择当前商品"
              disabled={!products.length}
              checked={
                selectedCount && selectedCount === products.length
                  ? true
                  : selectedCount
                    ? 'indeterminate'
                    : false
              }
              onCheckedChange={(checked) =>
                onSelect(checked === true ? products.map((product) => product.id) : [])
              }
            />
          </TableHead>
          <TableHead>商品 / 商品分组</TableHead>
          <TableHead>上架资料</TableHead>
          <TableHead>价格</TableHead>
          <TableHead>分配窗口</TableHead>
          <TableHead>运行前检查</TableHead>
          <TableHead className="w-20 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {products.map((product) => {
          const missing = missingFields(product)
          const window = windows.find((entry) => entry.id === product.windowId)
          return (
            <TableRow
              key={product.id}
              data-state={selectedIds.includes(product.id) ? 'selected' : undefined}
            >
              <TableCell>
                <Checkbox
                  aria-label={`选择商品${product.label}`}
                  checked={selectedIds.includes(product.id)}
                  onCheckedChange={(checked) =>
                    onSelect(
                      checked === true
                        ? [...selectedIds, product.id]
                        : selectedIds.filter((id) => id !== product.id),
                    )
                  }
                />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <ProductMark product={product} />
                  <div className="flex min-w-36 flex-col gap-1">
                    <button
                      className="agent-text-action"
                      onClick={() => onEdit([product.id])}
                    >
                      {product.label}
                    </button>
                    <span className="text-xs text-muted-foreground">
                      {product.collection}
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell className="max-w-64">
                {product.title ? (
                  <span className="block max-w-60 truncate" title={product.title}>
                    {product.title}
                  </span>
                ) : (
                  <span className="text-warning-foreground">等待补全标题与描述</span>
                )}
                <span className="mt-1 block text-xs text-muted-foreground">
                  {product.brand || '品牌待补全'} · {product.size || '尺寸待补全'} ·{' '}
                  {conditionOptions.find((option) => option.value === product.condition)
                    ?.label ?? '成色待补全'}
                </span>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {Number(product.price) > 0 ? (
                  formatMoney(Number(product.price), product.currency)
                ) : (
                  <span className="font-sans text-warning-foreground">待补全</span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={window?.status === 'blocked' ? 'destructive' : 'outline'}>
                  {window?.name ?? '未分配'}
                </Badge>
              </TableCell>
              <TableCell className="max-w-52">
                <ReviewBadge product={product} />
                <p
                  className="mt-1 max-w-48 whitespace-normal text-xs leading-4 text-muted-foreground"
                  title={product.reviewNote}
                >
                  {missing.length ? `待补全${missing.length}项资料` : product.reviewNote}
                </p>
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`编辑${product.label}`}
                    onClick={() => onEdit([product.id])}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`移除${product.label}`}
                    onClick={() => onRemove([product.id])}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
        {!products.length ? (
          <TableRow>
            <TableCell colSpan={7}>
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>还没有待上架商品</EmptyTitle>
                  <EmptyDescription>
                    从商品库添加本次商品，再准备上架资料与窗口分配。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )
}
