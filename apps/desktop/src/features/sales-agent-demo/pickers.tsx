import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { demoProducts, formatMoney, type DemoWindow } from './demo-data'
import { ProductMark } from './demo-widgets'

export function WindowPicker({
  windows,
  selectedIds,
  onSave,
  onClose,
}: {
  windows: DemoWindow[]
  selectedIds: string[]
  onSave: (ids: string[]) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState(selectedIds)
  const [query, setQuery] = useState('')
  const search = query.trim().toLowerCase()
  const filtered = windows.filter((window) =>
    `${window.name} ${window.account} ${window.provider}`.toLowerCase().includes(search),
  )
  const selectedCount = filtered.filter((window) => selected.includes(window.id)).length
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="agent-picker">
        <DialogHeader>
          <DialogTitle>选择执行窗口</DialogTitle>
          <DialogDescription>
            这里使用示例账号。移除窗口后，该窗口的商品需要重新分配。
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel className="sr-only" htmlFor="agent-picker-window-search">
            搜索可选窗口
          </FieldLabel>
          <Input
            id="agent-picker-window-search"
            type="search"
            placeholder="搜索窗口或账号"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <div className="agent-picker-scroll">
          <Table aria-label="可选执行窗口">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="选择当前筛选窗口"
                    disabled={!filtered.length}
                    checked={
                      selectedCount && selectedCount === filtered.length
                        ? true
                        : selectedCount
                          ? 'indeterminate'
                          : false
                    }
                    onCheckedChange={(checked) => {
                      const ids = new Set(filtered.map((window) => window.id))
                      setSelected((current) =>
                        checked === true
                          ? [...new Set([...current, ...ids])]
                          : current.filter((id) => !ids.has(id)),
                      )
                    }}
                  />
                </TableHead>
                <TableHead>窗口 / 账号</TableHead>
                <TableHead>主营与评价</TableHead>
                <TableHead>可用 / 待结算</TableHead>
                <TableHead>账号状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((window) => (
                <TableRow
                  key={window.id}
                  data-state={selected.includes(window.id) ? 'selected' : undefined}
                >
                  <TableCell>
                    <Checkbox
                      aria-label={`选择${window.name}`}
                      checked={selected.includes(window.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked === true
                            ? [...new Set([...current, window.id])]
                            : current.filter((id) => id !== window.id),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <strong className="block font-medium">{window.name}</strong>
                    <span className="text-xs text-muted-foreground">
                      @{window.account} · {window.provider}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="block text-xs">{window.tags.join(' / ')}</span>
                    <span className="text-xs text-muted-foreground">{window.rating}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {formatMoney(window.available)} / {formatMoney(window.pending)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={window.status === 'blocked' ? 'destructive' : 'outline'}
                    >
                      {window.status === 'blocked' ? '封禁 · 将停止' : '正常'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {!filtered.length ? (
                <TableRow>
                  <TableCell colSpan={5}>没有符合条件的窗口</TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <span className="mr-auto self-center text-xs text-muted-foreground">
            已选 {selected.length} 个窗口
          </span>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => onSave(selected)}>确认选择</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ProductPicker({
  existingIds,
  onAdd,
  onClose,
}: {
  existingIds: string[]
  onAdd: (ids: string[]) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="agent-picker">
        <DialogHeader>
          <DialogTitle>从商品库选择</DialogTitle>
          <DialogDescription>
            这里展示商品管理插件的示例资料，每件商品有独立身份、整组图片与上架资料；不会读取或修改真实商品库。
          </DialogDescription>
        </DialogHeader>
        <div className="agent-picker-scroll">
          <Table aria-label="商品库示例商品">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">选择</TableHead>
                <TableHead>商品</TableHead>
                <TableHead>商品分组</TableHead>
                <TableHead>图片</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {demoProducts.map((product) => {
                const added = existingIds.includes(product.id)
                return (
                  <TableRow key={product.id}>
                    <TableCell>
                      <Checkbox
                        aria-label={`添加${product.label}`}
                        disabled={added}
                        checked={added || selected.includes(product.id)}
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked === true
                              ? [...current, product.id]
                              : current.filter((id) => id !== product.id),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ProductMark product={product} />
                        <span>{product.label}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {product.collection}
                    </TableCell>
                    <TableCell>{product.imageCount} 张</TableCell>
                    <TableCell>
                      <Badge variant="outline">{added ? '已在任务中' : '可添加'}</Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!selected.length} onClick={() => onAdd(selected)}>
            添加 {selected.length} 件商品
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
