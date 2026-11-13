import { useMemo, useState, type DragEvent } from 'react'
import { ArrowLeftRight, ArrowRight, GripVertical, Monitor, Undo2, X } from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from '@/components/ui/toast'
import { formatMoney, type DemoProduct, type DemoWindow } from './demo-data'
import { ProductCover, ProductMark } from './demo-widgets'

const dragType = 'application/x-nexus-demo-products'
type ProductFilter = 'all' | 'unassigned' | 'assigned'

export function AssignmentBoard({
  products,
  windows,
  selectedIds,
  onSelect,
  onAssign,
  showProducts,
  disabled,
}: {
  products: DemoProduct[]
  windows: DemoWindow[]
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  onAssign: (ids: string[], windowId: string | null) => void
  showProducts: boolean
  disabled: boolean
}) {
  const [productQuery, setProductQuery] = useState('')
  const [windowQuery, setWindowQuery] = useState('')
  const [filter, setFilter] = useState<ProductFilter>('all')
  const [onlyAssigned, setOnlyAssigned] = useState(false)
  const [draggedIds, setDraggedIds] = useState<string[]>([])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const windowMap = useMemo(
    () => new Map(windows.map((window) => [window.id, window])),
    [windows],
  )
  const assignments = useMemo(() => {
    const grouped = new Map<string, DemoProduct[]>()
    for (const product of products) {
      if (!product.windowId) continue
      const group = grouped.get(product.windowId) ?? []
      group.push(product)
      grouped.set(product.windowId, group)
    }
    return grouped
  }, [products])
  const selectedProducts = products.filter((product) => selectedIds.includes(product.id))
  const unassignedCount = products.filter((product) => !product.windowId).length
  const query = productQuery.trim().toLowerCase()
  const visibleProducts = products.filter(
    (product) =>
      (filter === 'all' ||
        (filter === 'assigned'
          ? product.windowId !== null
          : product.windowId === null)) &&
      `${product.label} ${product.title} ${product.collection}`
        .toLowerCase()
        .includes(query),
  )
  const windowSearch = windowQuery.trim().toLowerCase()
  const visibleWindows = windows.filter(
    (window) =>
      (!showProducts || !onlyAssigned || assignments.has(window.id)) &&
      `${window.name} ${window.account} ${window.provider} ${window.tags.join(' ')}`
        .toLowerCase()
        .includes(windowSearch),
  )
  const visibleSelected = visibleProducts.filter((product) =>
    selectedIds.includes(product.id),
  ).length

  function move(ids: string[], windowId: string | null) {
    if (disabled || !ids.length) return
    onAssign(ids, windowId)
    onSelect([])
    setDraggedIds([])
    setDropTarget(null)
    const message = windowId
      ? `已将 ${ids.length} 件商品分配到 ${windowMap.get(windowId)!.name}`
      : `已将 ${ids.length} 件商品移回待分配`
    setAnnouncement(message)
    toast.success(message)
  }

  function startDrag(event: DragEvent<HTMLElement>, productId: string) {
    if (disabled) {
      event.preventDefault()
      return
    }
    const ids = selectedIds.includes(productId)
      ? selectedProducts.map((product) => product.id)
      : [productId]
    event.dataTransfer.setData(dragType, JSON.stringify(ids))
    event.dataTransfer.effectAllowed = 'move'
    setDraggedIds(ids)
    onSelect(ids)
  }

  function acceptsDrag(event: DragEvent<HTMLElement>) {
    return (
      !disabled && draggedIds.length > 0 && event.dataTransfer.types.includes(dragType)
    )
  }

  function dragOver(event: DragEvent<HTMLElement>, target: string) {
    if (!acceptsDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(target)
  }

  function drop(event: DragEvent<HTMLElement>, windowId: string | null) {
    if (!acceptsDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    move(draggedIds, windowId)
  }

  function leave(event: DragEvent<HTMLElement>) {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      setDropTarget(null)
  }

  return (
    <div className="agent-assignment">
      <div
        className={cn(
          'agent-assignment-grid',
          !showProducts && 'agent-assignment-windows-only',
        )}
        onDragEnd={() => {
          setDraggedIds([])
          setDropTarget(null)
        }}
      >
        {showProducts ? (
          <>
            <section
              className="agent-assignment-column"
              aria-label="本次商品"
              aria-describedby="agent-assignment-help"
              data-drop-active={dropTarget === 'unassigned' || undefined}
              onDragOver={(event) => dragOver(event, 'unassigned')}
              onDragLeave={leave}
              onDrop={(event) => drop(event, null)}
            >
              <div className="agent-assignment-heading">
                <h3>
                  本次商品 <Badge variant="secondary">{products.length}</Badge>
                </h3>
                <Badge variant="outline">商品库</Badge>
              </div>
              <Field className="agent-assignment-search">
                <FieldLabel className="sr-only" htmlFor="agent-product-search">
                  搜索商品
                </FieldLabel>
                <Input
                  id="agent-product-search"
                  type="search"
                  placeholder="搜索商品名称、标题或分组"
                  value={productQuery}
                  onChange={(event) => setProductQuery(event.target.value)}
                />
              </Field>
              <div className="agent-assignment-filters">
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={filter}
                  aria-label="商品分配状态"
                  onValueChange={(value) => value && setFilter(value as ProductFilter)}
                >
                  <ToggleGroupItem value="all">全部 {products.length}</ToggleGroupItem>
                  <ToggleGroupItem value="unassigned">
                    未分配 {unassignedCount}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="assigned">
                    已分配 {products.length - unassignedCount}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <div className="agent-assignment-selection">
                <label>
                  <Checkbox
                    aria-label="选择筛选后的商品"
                    disabled={!visibleProducts.length}
                    checked={
                      visibleSelected && visibleSelected === visibleProducts.length
                        ? true
                        : visibleSelected
                          ? 'indeterminate'
                          : false
                    }
                    onCheckedChange={(checked) => {
                      const visibleIds = new Set(
                        visibleProducts.map((product) => product.id),
                      )
                      onSelect(
                        checked === true
                          ? [...new Set([...selectedIds, ...visibleIds])]
                          : selectedIds.filter((id) => !visibleIds.has(id)),
                      )
                    }}
                  />
                  {selectedProducts.length
                    ? `已选 ${selectedProducts.length} 件`
                    : '选择商品'}
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!selectedProducts.some((product) => product.windowId)}
                  onClick={() =>
                    move(
                      selectedProducts.map((product) => product.id),
                      null,
                    )
                  }
                >
                  <Undo2 data-icon="inline-start" />
                  取消分配
                </Button>
              </div>
              <ul
                className="agent-assignment-scroll"
                aria-label="可分配商品"
                tabIndex={0}
              >
                {visibleProducts.map((product) => {
                  const target = product.windowId ? windowMap.get(product.windowId) : null
                  return (
                    <li
                      key={product.id}
                      className="agent-assignment-product"
                      data-product-id={product.id}
                      data-selected={selectedIds.includes(product.id) || undefined}
                      data-dragging={draggedIds.includes(product.id) || undefined}
                      draggable={!disabled}
                      onDragStart={(event) => startDrag(event, product.id)}
                    >
                      <GripVertical className="agent-drag-handle" aria-hidden="true" />
                      <Checkbox
                        aria-label={`分配商品${product.label}`}
                        checked={selectedIds.includes(product.id)}
                        onCheckedChange={(checked) =>
                          onSelect(
                            checked === true
                              ? [...new Set([...selectedIds, product.id])]
                              : selectedIds.filter((id) => id !== product.id),
                          )
                        }
                      />
                      <ProductMark product={product} />
                      <div className="agent-assignment-product-info">
                        <strong title={product.label}>{product.label}</strong>
                        <span>
                          {product.collection} ·{' '}
                          {Number(product.price) > 0
                            ? formatMoney(Number(product.price), product.currency)
                            : '价格待补全'}
                        </span>
                        <span className={target ? 'agent-product-target' : undefined}>
                          {target ? (
                            <>
                              <ArrowRight />
                              {target.name}
                            </>
                          ) : (
                            '未分配窗口'
                          )}
                        </span>
                      </div>
                    </li>
                  )
                })}
                {!visibleProducts.length ? (
                  <li>
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>
                          {products.length ? '没有符合条件的商品' : '尚未添加商品'}
                        </EmptyTitle>
                        <EmptyDescription>
                          {products.length
                            ? '可调整搜索或切换分配状态。'
                            : '从商品库选择本次要上架的商品。'}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </li>
                ) : null}
              </ul>
              <p className="agent-assignment-column-footer">
                {dropTarget === 'unassigned'
                  ? `松开，将 ${draggedIds.length} 件商品移回待分配`
                  : `显示 ${visibleProducts.length}/${products.length} 件 · 拖回左侧可取消分配`}
              </p>
            </section>
            <div className="agent-assignment-connector" aria-hidden="true">
              <ArrowLeftRight />
            </div>
          </>
        ) : null}
        <section className="agent-assignment-column" aria-label="执行窗口列表">
          <div className="agent-assignment-heading">
            <h3>
              <Monitor />
              执行窗口 <Badge variant="secondary">{windows.length}</Badge>
            </h3>
            <span>按窗口独立执行</span>
          </div>
          <Field className="agent-assignment-search">
            <FieldLabel className="sr-only" htmlFor="agent-window-search">
              搜索执行窗口
            </FieldLabel>
            <Input
              id="agent-window-search"
              type="search"
              placeholder="搜索窗口、账号、浏览器或标签"
              value={windowQuery}
              onChange={(event) => setWindowQuery(event.target.value)}
            />
          </Field>
          {showProducts ? (
            <div className="agent-assignment-window-filter">
              <label>
                <Checkbox
                  checked={onlyAssigned}
                  onCheckedChange={(checked) => setOnlyAssigned(checked === true)}
                />
                只看已分配商品的窗口
              </label>
              <span>{assignments.size} 个已分配</span>
            </div>
          ) : null}
          <ul
            className="agent-assignment-scroll"
            aria-label="可接收商品的窗口"
            tabIndex={0}
          >
            {visibleWindows.map((window) => {
              const assigned = assignments.get(window.id) ?? []
              return (
                <li
                  key={window.id}
                  className="agent-assignment-window"
                  data-window-id={window.id}
                  data-drop-active={dropTarget === window.id || undefined}
                  data-has-products={assigned.length > 0 || undefined}
                  onDragOver={
                    showProducts ? (event) => dragOver(event, window.id) : undefined
                  }
                  onDragLeave={showProducts ? leave : undefined}
                  onDrop={showProducts ? (event) => drop(event, window.id) : undefined}
                >
                  <div className="agent-assignment-window-title">
                    <strong>{window.name}</strong>
                    <Badge
                      variant={window.status === 'blocked' ? 'destructive' : 'outline'}
                    >
                      {window.status === 'blocked' ? '封禁 · 将停止' : '正常'}
                    </Badge>
                    {showProducts ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`将已选商品分配给${window.name}`}
                        disabled={!selectedProducts.length}
                        onClick={() =>
                          move(
                            selectedProducts.map((product) => product.id),
                            window.id,
                          )
                        }
                      >
                        <ArrowRight data-icon="inline-start" />
                        分配
                        {selectedProducts.length ? ` ${selectedProducts.length} 件` : ''}
                      </Button>
                    ) : null}
                  </div>
                  <span className="agent-assignment-account">
                    @{window.account} · {window.provider}
                  </span>
                  <div className="agent-window-meta">
                    <span>{window.tags.join(' / ')}</span>
                    <span>{window.rating}</span>
                  </div>
                  <div className="agent-window-finance">
                    <span>
                      可用 <b>{formatMoney(window.available)}</b>
                    </span>
                    <span>
                      待结算 <b>{formatMoney(window.pending)}</b>
                    </span>
                    {showProducts ? (
                      <Badge variant="secondary">{assigned.length} 件商品</Badge>
                    ) : null}
                  </div>
                  {showProducts ? (
                    <div className="agent-window-products">
                      {assigned.map((product) => (
                        <div
                          key={product.id}
                          className="agent-assigned-product"
                          data-assigned-product-id={product.id}
                          draggable={!disabled}
                          onDragStart={(event) => startDrag(event, product.id)}
                        >
                          <GripVertical aria-hidden="true" />
                          <ProductCover product={product} compact />
                          <span title={product.label}>{product.label}</span>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`取消${product.label}与${window.name}的分配`}
                            onClick={() => move([product.id], null)}
                          >
                            <X />
                          </Button>
                        </div>
                      ))}
                      {!assigned.length ? (
                        <span className="agent-window-drop-hint">
                          拖放商品到这里，或勾选商品后点击“分配”
                        </span>
                      ) : null}
                      {dropTarget === window.id ? (
                        <span className="agent-window-drop-hint">
                          松开，分配 {draggedIds.length} 件商品到此窗口
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
            {!visibleWindows.length ? (
              <li>
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>
                      {windows.length ? '没有符合条件的窗口' : '尚未选择执行窗口'}
                    </EmptyTitle>
                    <EmptyDescription>
                      {windows.length
                        ? '可调整搜索或取消筛选。'
                        : '点击“选择窗口”添加本次执行账号。'}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </li>
            ) : null}
          </ul>
          <p className="agent-assignment-column-footer">
            显示 {visibleWindows.length}/{windows.length} 个窗口
            {showProducts ? ' · 同一窗口内顺序上架' : ''}
          </p>
        </section>
      </div>
      {showProducts ? (
        <div className="agent-assignment-footer">
          <p id="agent-assignment-help">
            拖拽商品到窗口，或勾选后点击窗口的“分配”。一件商品只属于一个窗口。
          </p>
          <span>
            已分配 {products.length - unassignedCount}/{products.length} 件
          </span>
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
}
