import { useEffect, useState } from 'react'
import { Copy, ImageOff, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import { listItems } from './api'
import { formatTime, message, priceText, type Item, type Monitor } from './types'

const PAGE_SIZE = 24

interface Rows {
  key: string
  items: Item[]
  total: number
  page: number
}

export interface ItemsSheetProps {
  monitor: Monitor
  onOpenChange: (open: boolean) => void
}

/** Collected listings for one monitor, newest first. */
export function ItemsSheet({ monitor, onOpenChange }: ItemsSheetProps) {
  const [draft, setDraft] = useState('')
  const [keyword, setKeyword] = useState('')
  const [rows, setRows] = useState<Rows | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const queryKey = `${monitor.id}:${keyword}`
  const current = rows !== null && rows.key === queryKey ? rows : null

  // Page 0 for the current query. State is only written from the callbacks, so
  // no effect body touches state synchronously.
  useEffect(() => {
    const key = `${monitor.id}:${keyword}`
    let active = true
    void listItems(monitor.id, 0, PAGE_SIZE, keyword).then(
      (result) => {
        if (!active) return
        setRows({ key, items: result.items, total: result.total, page: 0 })
        setError(null)
      },
      (cause: unknown) => {
        if (!active) return
        setRows({ key, items: [], total: 0, page: 0 })
        setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [monitor.id, keyword])

  async function loadMore() {
    if (current === null || busy) return
    if (current.items.length >= current.total) return
    setBusy(true)
    try {
      const next = current.page + 1
      const result = await listItems(monitor.id, next, PAGE_SIZE, keyword)
      setRows((previous) =>
        previous === null || previous.key !== queryKey
          ? previous
          : {
              key: queryKey,
              items: [...previous.items, ...result.items],
              total: result.total,
              page: next,
            },
      )
      setError(null)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  async function copyLink(item: Item) {
    if (await copyText(item.url)) {
      toast.success('已复制商品链接')
      return
    }
    setError('复制失败，请检查剪贴板权限后重试。')
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>采集到的商品</SheetTitle>
          <SheetDescription>
            {monitor.name} · 共 {current?.total ?? 0} 件，按上架时间从新到旧。
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            className="vinted-search"
            onSubmit={(event) => {
              event.preventDefault()
              setKeyword(draft.trim())
            }}
          >
            <Input
              value={draft}
              maxLength={100}
              placeholder="按标题、品牌或卖家筛选"
              aria-label="筛选商品"
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy}>
              <Search data-icon="inline-start" />
              筛选
            </Button>
          </form>

          {error === null ? null : <p className="vinted-error">{error}</p>}

          {current === null ? (
            <p className="vinted-muted" role="status">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" /> 正在读取商品…
            </p>
          ) : current.items.length === 0 ? (
            <p className="vinted-muted">
              {keyword === ''
                ? '这个监控还没有采集到商品，先跑一次采集。'
                : '没有匹配的商品。'}
            </p>
          ) : (
            <div className="vinted-items">
              {current.items.map((item) => (
                <article key={item.id} className="vinted-item">
                  <div className="vinted-item-media">
                    {item.imageUrl === '' ? (
                      <ImageOff aria-hidden="true" />
                    ) : (
                      <img src={item.imageUrl} alt="" loading="lazy" />
                    )}
                  </div>
                  <div className="vinted-item-body">
                    <p className="vinted-item-title">
                      {item.title === '' ? '未命名商品' : item.title}
                    </p>
                    <p className="vinted-item-price">{priceText(item)}</p>
                    <p className="vinted-muted">
                      {[item.brand, item.size, item.condition]
                        .filter((part) => part !== '')
                        .join(' · ') || '品牌与尺码未提供'}
                    </p>
                    <p className="vinted-muted">
                      卖家 {item.seller === '' ? '未知' : item.seller} · 上架{' '}
                      {formatTime(item.listedAt)}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void copyLink(item)}
                    >
                      <Copy data-icon="inline-start" />
                      复制链接
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {current === null ? null : current.items.length < current.total ? (
            <Button variant="outline" disabled={busy} onClick={() => void loadMore()}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {busy
                ? '加载中…'
                : `加载更多（还有 ${current.total - current.items.length} 件）`}
            </Button>
          ) : (
            <p className="vinted-muted">已经到底了</p>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
