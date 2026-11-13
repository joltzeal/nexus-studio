import { useEffect, useState, type MouseEvent } from 'react'
import {
  compareProductPublicationRecency,
  type Product,
  type ProductPublication,
  type ProductPublicationPage,
} from '@nexus/plugin-products/contracts'
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toast'
import { openExternalUrl, safeExternalHttpUrl } from '@/lib/platform/external-url'
import { listProductPublications } from './api'
import { productError, productTime } from './product-form'

export function ProductPublicationOverview({
  product,
  onViewHistory,
  disabled,
}: {
  product: Pick<Product, 'publicationCount' | 'latestPublication'>
  onViewHistory: () => void
  disabled: boolean
}) {
  const latest = product.latestPublication
  return (
    <section aria-label="发布使用" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={product.publicationCount > 0 ? 'secondary' : 'outline'}>
          {product.publicationCount > 0 ? '已发布' : '未发布'}
        </Badge>
        <span className="text-xs text-muted-foreground">
          共 {product.publicationCount} 次发布 · 发布记录只读
        </span>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          disabled={disabled}
          onClick={onViewHistory}
        >
          查看发布历史
        </Button>
      </div>
      {latest && (
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          最近发布窗口：{latest.windowName} · {latest.platform} ·{' '}
          <time dateTime={latest.publishedAt} title={latest.publishedAt}>
            {productTime(latest.publishedAt)}
          </time>
        </p>
      )}
    </section>
  )
}

export function ProductPublicationHistory({
  publications,
  total,
}: {
  publications: readonly ProductPublication[]
  total: number
}) {
  const records = [...publications].sort((left, right) =>
    compareProductPublicationRecency(right, left),
  )

  return (
    <section aria-label="发布使用" className="flex min-h-0 min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={total > 0 ? 'secondary' : 'outline'}>
          {total > 0 ? '已发布' : '未发布'}
        </Badge>
        <span className="text-xs text-muted-foreground">
          共 {total} 次发布 · 本页 {records.length} 条 ·
          窗口名称为发布时快照，记录仅供查看。
        </span>
      </div>
      {records.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{total === 0 ? '暂无发布记录' : '本页没有发布记录'}</EmptyTitle>
            <EmptyDescription>
              {total === 0
                ? '准备状态为待上架不代表商品已经发布。'
                : '请刷新发布历史后重试。'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol
          aria-label="发布历史记录"
          tabIndex={0}
          className="flex max-h-[50svh] min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain rounded-sm pr-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {records.map((publication, index) => {
            const url = safeExternalHttpUrl(publication.listingUrl)
            function openListing(event: MouseEvent<HTMLAnchorElement>) {
              event.preventDefault()
              if (!url) return
              void openExternalUrl(url).catch(() =>
                toast.error('无法打开平台商品链接，请重试或复制链接后在浏览器中打开。'),
              )
            }
            return (
              <li key={publication.id} className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto min-w-0 justify-start p-0"
                      onClick={() =>
                        navigateDetail({ kind: 'window', id: publication.windowId })
                      }
                      aria-label={`查看发布窗口 ${publication.windowName}`}
                    >
                      {publication.windowName}
                    </Button>
                    <Badge variant="outline" className="max-w-full">
                      <span className="truncate" title={publication.platform}>
                        {publication.platform}
                      </span>
                    </Badge>
                  </div>
                  <span className="break-all text-xs text-muted-foreground">
                    窗口 UUID：{publication.windowId}
                  </span>
                </div>
                <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">发布时间</dt>
                  <dd>
                    <time
                      dateTime={publication.publishedAt}
                      title={publication.publishedAt}
                    >
                      {productTime(publication.publishedAt)}
                    </time>
                  </dd>
                  <dt className="text-muted-foreground">记录时间</dt>
                  <dd>
                    <time
                      dateTime={publication.recordedAt}
                      title={publication.recordedAt}
                    >
                      {productTime(publication.recordedAt)}
                    </time>
                  </dd>
                  <dt className="text-muted-foreground">商品版本</dt>
                  <dd>v{publication.productRevision}</dd>
                  <dt className="text-muted-foreground">平台商品 ID</dt>
                  <dd className="min-w-0 break-all">
                    {publication.listingId || '未提供'}
                  </dd>
                  <dt className="text-muted-foreground">平台链接</dt>
                  <dd className="min-w-0">
                    {url ? (
                      <Button
                        type="button"
                        variant="link"
                        asChild
                        className="h-auto max-w-full justify-start p-0"
                      >
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={url}
                          aria-label={`在默认浏览器打开平台商品 ${publication.listingId || publication.id}`}
                          onClick={openListing}
                          onAuxClick={(event) => {
                            if (event.button === 1) openListing(event)
                          }}
                        >
                          <ExternalLink data-icon="inline-start" />
                          <span className="truncate">{url}</span>
                        </a>
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">
                        {publication.listingUrl ? '链接不可用' : '未提供'}
                      </span>
                    )}
                  </dd>
                </dl>
                {index < records.length - 1 && <Separator />}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

export interface ProductPublicationDialogProps {
  productId: string
  productName: string
  onClose: () => void
}

export function ProductPublicationDialog({
  productId,
  productName,
  onClose,
}: ProductPublicationDialogProps) {
  const [pagination, setPagination] = useState<{
    productId: string
    page: number
    pageSize: 20 | 50
  }>(() => ({ productId, page: 1, pageSize: 20 }))
  const page = pagination.productId === productId ? pagination.page : 1
  const pageSize = pagination.productId === productId ? pagination.pageSize : 20
  const [attempt, setAttempt] = useState(0)
  const requestKey = JSON.stringify([productId, page, pageSize, attempt])
  const [result, setResult] = useState<{
    key: string
    data: ProductPublicationPage | null
    error: string | null
  }>({ key: '', data: null, error: null })

  useEffect(() => {
    let current = true
    void listProductPublications({ productId, page, pageSize }).then(
      (data) => {
        if (current) setResult({ key: requestKey, data, error: null })
      },
      (cause: unknown) => {
        if (current)
          setResult({ key: requestKey, data: null, error: productError(cause) })
      },
    )
    return () => {
      current = false
    }
  }, [productId, page, pageSize, attempt, requestKey])

  const data = result.key === requestKey ? result.data : null
  const error = result.key === requestKey ? result.error : null
  const loading = !data && !error
  const currentPage = data?.page ?? page
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : null

  function refresh() {
    setPagination({ productId, page: currentPage, pageSize })
    setAttempt((value) => value + 1)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex min-h-0 flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>发布历史</DialogTitle>
          <DialogDescription className="break-words">
            {data?.productName ?? productName} · 按页查看每次发布使用的窗口与平台商品。
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3" aria-busy={loading}>
          {loading ? (
            <>
              <Skeleton className="h-24 w-full" />
              <span role="status" className="sr-only">
                正在读取发布历史…
              </span>
            </>
          ) : error ? (
            <Alert variant="destructive">
              <AlertTitle>发布历史读取失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : data ? (
            <ProductPublicationHistory publications={data.items} total={data.total} />
          ) : null}
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 sm:justify-between">
          <div
            role="group"
            aria-label="发布历史分页"
            className="flex flex-wrap items-center gap-2"
          >
            <LabeledSelect
              ariaLabel="每页发布历史数量"
              className="w-auto min-w-24"
              value={String(pageSize)}
              options={[
                { value: '20', label: '20 条 / 页' },
                { value: '50', label: '50 条 / 页' },
              ]}
              onValueChange={(value) => {
                if (value === '20' || value === '50')
                  setPagination({
                    productId,
                    page: 1,
                    pageSize: value === '50' ? 50 : 20,
                  })
              }}
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                第 {currentPage} / {pages ?? '—'} 页
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="上一页发布历史"
                disabled={loading || !data || currentPage <= 1}
                onClick={() =>
                  setPagination({ productId, page: currentPage - 1, pageSize })
                }
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="下一页发布历史"
                disabled={loading || !data || pages === null || currentPage >= pages}
                onClick={() =>
                  setPagination({ productId, page: currentPage + 1, pageSize })
                }
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              关闭
            </Button>
            <Button
              type="button"
              variant={error ? 'default' : 'outline'}
              disabled={loading}
              onClick={refresh}
            >
              <RefreshCw data-icon="inline-start" />
              {error ? '重试读取' : '刷新记录'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
import { navigateDetail } from '@/lib/detail-navigation'
