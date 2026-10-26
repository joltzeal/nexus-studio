import { useEffect, useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  Sparkles,
  Star,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toast'
import { getItem, reviewItem, starItem } from './api'
import { VintedExternalLink } from './external-link'
import { ItemImage } from './item-image'
import { safeExternalUrl, sourceCountry } from './item-filters'
import { SellerProfile } from './seller-profile'
import {
  AVAILABILITY_LABELS,
  formatTime,
  message,
  priceText,
  type Item,
  type ReviewStatus,
} from './types'

function itemPhotos(item: Item): string[] {
  return [
    ...new Set(
      (item.images?.length ? item.images : [item.imageUrl]).filter(
        (url) => !!safeExternalUrl(url),
      ),
    ),
  ]
}

export function AvailabilityBadge({ item }: { item: Pick<Item, 'availabilityStatus'> }) {
  return (
    <Badge
      variant={
        item.availabilityStatus === 'sold'
          ? 'destructive'
          : item.availabilityStatus === 'pending'
            ? 'secondary'
            : 'outline'
      }
    >
      {AVAILABILITY_LABELS[item.availabilityStatus] ?? '未核查'}
    </Badge>
  )
}

export function ItemDetailSheet({
  itemId,
  preview = false,
  aiImageReady,
  onClose,
  onGenerate,
  onHistory,
  onChanged,
}: {
  itemId: string
  preview?: boolean
  aiImageReady: boolean
  onClose: () => void
  onGenerate: (item: Item, images: string[]) => void
  onHistory: (item: Item) => void
  onChanged: () => void
}) {
  const [item, setItem] = useState<Item | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let active = true
    void getItem(itemId).then(
      ({ item: next }) => {
        if (active) {
          setItem(next)
          setError(null)
        }
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [itemId, nonce])
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent side="right" className="sm:max-w-4xl">
        <SheetHeader>
          <SheetTitle>{item?.title || (preview ? '商品图片' : '商品详情')}</SheetTitle>
          <SheetDescription>
            商品内容保留采集时快照，点赞数按后续列表更新。
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {error ? (
            <FieldError role="alert">
              {error}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setNonce((value) => value + 1)}
              >
                重新加载
              </Button>
            </FieldError>
          ) : item ? (
            <ItemDetail
              key={item.id}
              {...{ item, preview, aiImageReady, onGenerate, onHistory }}
              onUpdate={(next) => {
                setItem(next)
                onChanged()
              }}
            />
          ) : (
            <Skeleton className="h-64 w-full" />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

function ItemDetail({
  item,
  preview,
  aiImageReady,
  onGenerate,
  onHistory,
  onUpdate,
}: {
  item: Item
  preview: boolean
  aiImageReady: boolean
  onGenerate: (item: Item, images: string[]) => void
  onHistory: (item: Item) => void
  onUpdate: (item: Item) => void
}) {
  const photos = itemPhotos(item)
  const [index, setIndex] = useState(0)
  const [selection, setSelection] = useState<string[]>(() => photos.slice(0, 6))
  const [note, setNote] = useState(item.statusNote ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function review(status: ReviewStatus) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await reviewItem(item.id, status, note.trim())
      onUpdate(result.item)
      toast.success('核查状态已保存')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  async function toggleStar() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      onUpdate((await starItem(item.id, !item.starred)).item)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  function selectPhoto(photo: string) {
    if (!selection.includes(photo) && selection.length >= 6) {
      toast.error('最多选择 6 张参考图，请先取消部分选择')
      return
    }
    setSelection((selected) =>
      selected.includes(photo)
        ? selected.filter((value) => value !== photo)
        : [...selected, photo],
    )
  }
  const ordered = photos.filter((photo) => selection.includes(photo))
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!aiImageReady || ordered.length === 0}
          title={aiImageReady ? '将所选图片带入 AI 生图' : '请先安装并启用 AI 生图插件'}
          onClick={() => onGenerate(item, ordered)}
        >
          <Sparkles data-icon="inline-start" />
          生成商品场景{ordered.length ? `（${ordered.length} 张）` : ''}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!aiImageReady}
          onClick={() => onHistory(item)}
        >
          <History data-icon="inline-start" />
          商品生成记录
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-pressed={item.starred}
          onClick={() => void toggleStar()}
        >
          <Star data-icon="inline-start" fill={item.starred ? 'currentColor' : 'none'} />
          {item.starred ? '已加星标' : '添加星标'}
        </Button>
        <VintedExternalLink href={item.url}>查看原商品</VintedExternalLink>
      </div>
      {!aiImageReady ? (
        <p className="text-xs text-muted-foreground">
          启用 AI 生图插件后，可使用所选商品图片生成场景。
        </p>
      ) : null}
      {photos.length ? (
        <div className="flex flex-col gap-2">
          <div className="vinted-gallery-main">
            <ItemImage
              itemId={item.id}
              url={photos[index] ?? photos[0]!}
              alt={`${item.title} · ${index + 1}`}
              contain
              retry
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="上一张商品图片"
              disabled={index === 0}
              onClick={() => setIndex((value) => value - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="text-xs text-muted-foreground">
              图片 {index + 1} / {photos.length} · 已选 {selection.length} / 6 张用于生图
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="下一张商品图片"
              disabled={index + 1 >= photos.length}
              onClick={() => setIndex((value) => value + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {photos.map((photo, position) => (
              <div key={photo} className="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  className="vinted-gallery-thumb"
                  aria-label={`查看商品图片 ${position + 1}`}
                  aria-pressed={index === position}
                  onClick={() => setIndex(position)}
                >
                  <ItemImage itemId={item.id} url={photo} />
                </button>
                <Button
                  size="sm"
                  variant={selection.includes(photo) ? 'secondary' : 'outline'}
                  aria-pressed={selection.includes(photo)}
                  aria-label={`${selection.includes(photo) ? '取消' : '选择'}参考图 ${position + 1}`}
                  onClick={() => selectPhoto(photo)}
                >
                  {selection.includes(photo) ? <Check data-icon="inline-start" /> : null}
                  参考图 {position + 1}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">接口未返回商品图片</p>
      )}
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      {!preview ? (
        <>
          <section
            className="flex flex-col gap-3 rounded-md border p-3"
            aria-label="商品状态核查"
          >
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">商品状态核查</h3>
              <AvailabilityBadge item={item} />
            </div>
            {item.missingSince ? (
              <p className="text-xs text-muted-foreground">
                首次进入待核查：{formatTime(item.missingSince)}
              </p>
            ) : null}
            {item.statusCheckedAt ? (
              <p className="text-xs text-muted-foreground">
                上次人工核查：{formatTime(item.statusCheckedAt)}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              列表中消失只表示需要核查。请打开原商品页面确认后记录判断。
            </p>
            <Field>
              <FieldLabel htmlFor="vinted-review-note">核查备注</FieldLabel>
              <Input
                id="vinted-review-note"
                maxLength={500}
                value={note}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
                placeholder="可选"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              {(['pending', 'available', 'sold', 'ignored'] as const).map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void review(status)}
                >
                  {busy ? <Loader2 className="animate-spin" /> : null}
                  {status === 'pending' ? '加入待核查' : AVAILABILITY_LABELS[status]}
                </Button>
              ))}
            </div>
          </section>
          <dl className="vinted-detail-values">
            {[
              ['来源国家', sourceCountry(item.domain)],
              ['来源商品 ID', item.externalId],
              ['价格', priceText(item)],
              ['点赞数', item.favouriteCount],
              ['浏览数', item.viewCount],
              ['品牌', item.brand],
              ['尺码', item.size],
              ['成色', item.condition],
              ['采集时间', formatTime(item.collectedAt)],
              ['最近采集', formatTime(item.lastSeenAt)],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt>{label}</dt>
                <dd>{value ?? '—'}</dd>
              </div>
            ))}
          </dl>
          <section className="flex flex-col gap-2" aria-label="卖家资料">
            <h3 className="text-sm font-medium">卖家资料</h3>
            {item.sellerProfile ? (
              <SellerProfile seller={item.sellerProfile} itemId={item.id} />
            ) : (
              <p className="text-xs text-muted-foreground">
                尚未采集卖家资料，下一轮采集时获取。
              </p>
            )}
          </section>
          <details>
            <summary className="cursor-pointer text-xs font-medium">原始商品详情</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(item.detail, null, 2)}
            </pre>
          </details>
        </>
      ) : null}
    </div>
  )
}
