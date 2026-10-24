import { useEffect, useRef } from 'react'
import { LayoutGrid, List, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { publishedText, type Product } from './types'
import { SupplyImage } from './supply-image'

export type ProductView = 'list' | 'waterfall'

export function ProductViewToggle({
  value,
  onChange,
}: {
  value: ProductView
  onChange: (view: ProductView) => void
}) {
  return (
    <div className="supply-view" role="group" aria-label="商品视图">
      <button
        type="button"
        aria-label="列表视图"
        aria-pressed={value === 'list'}
        className={value === 'list' ? 'supply-view-item is-active' : 'supply-view-item'}
        onClick={() => onChange('list')}
      >
        <List aria-hidden="true" />
        列表
      </button>
      <button
        type="button"
        aria-label="瀑布流视图"
        aria-pressed={value === 'waterfall'}
        className={
          value === 'waterfall' ? 'supply-view-item is-active' : 'supply-view-item'
        }
        onClick={() => onChange('waterfall')}
      >
        <LayoutGrid aria-hidden="true" />
        瀑布流
      </button>
    </div>
  )
}

export function ProductGrid({
  rows,
  view,
  onOpen,
  empty = '暂无商品',
}: {
  rows: Product[]
  view: ProductView
  onOpen: (product: Product) => void
  empty?: string
}) {
  if (rows.length === 0) {
    return <p className="supply-empty">{empty}</p>
  }
  return (
    <div className={view === 'waterfall' ? 'supply-grid is-waterfall' : 'supply-grid'}>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className="supply-card"
          onClick={() => onOpen(row)}
        >
          <span className="supply-card-media">
            <SupplyImage url={row.coverUrl} lazy />
          </span>
          <span className="supply-card-body">
            <span className="supply-card-title">
              {row.title === '' ? '未命名商品' : row.title}
            </span>
            <span className="supply-card-price">
              ¥ {row.price === '' ? '—' : row.price}
            </span>
            <span className="supply-card-meta">
              {row.images.length} 张图片 · {publishedText(row)}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

export function Pager({
  page,
  hasMore,
  disabled,
  onChange,
}: {
  page: number
  hasMore: boolean
  disabled?: boolean
  onChange: (page: number) => void
}) {
  return (
    <div className="supply-pager">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled === true || page <= 0}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </Button>
      <span className="supply-pager-label">第 {page + 1} 页</span>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled === true || !hasMore}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  )
}

/**
 * Bottom-of-list sentinel: fetches the next page once it scrolls into view.
 *
 * `loaded` is part of the observer dependencies on purpose. When a page arrives
 * but the sentinel is still visible (short page, tall window), the observer is
 * rebuilt and reports the current intersection again, which keeps filling the
 * viewport instead of waiting for a scroll that may never happen.
 */
export function LoadMore({
  hasMore,
  busy,
  loaded,
  onLoadMore,
}: {
  hasMore: boolean
  busy: boolean
  loaded: number
  onLoadMore: () => void
}) {
  const node = useRef<HTMLDivElement | null>(null)
  const handler = useRef(onLoadMore)

  useEffect(() => {
    handler.current = onLoadMore
  })

  useEffect(() => {
    const element = node.current
    if (element === null || !hasMore || busy) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) handler.current()
      },
      { rootMargin: '160px' },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [hasMore, busy, loaded])

  if (!hasMore && !busy) {
    return loaded === 0 ? null : <p className="supply-more-end">已经到底了</p>
  }

  return (
    <div className="supply-more" ref={node} role="status">
      {busy ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
      {busy ? '正在加载更多…' : '继续下拉加载更多'}
    </div>
  )
}
