import { useState } from 'react'
import { Copy, Heart, Loader2, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import { sendToAiImage } from '@/lib/page-handoff'
import { addFavorite, removeFavorite } from './api'
import { message, productText, publishedText, type Favorite, type Product } from './types'

const COPY_FAILED = '复制失败，请检查剪贴板权限后重试。'

async function copy(text: string, what: string) {
  if (await copyText(text)) {
    toast.success(`已复制${what}`)
  } else {
    toast.error(COPY_FAILED)
  }
}

export function ProductDialog({
  product,
  favorite,
  aiImageReady,
  onClose,
  onChanged,
}: {
  product: Product | null
  /** Set when this product is already in favourites. */
  favorite: Favorite | null
  /** The AI image plugin is running, so its page can accept these photos. */
  aiImageReady: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [pending, setPending] = useState(false)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const shown = favorite ?? product

  async function save() {
    if (product === null) return
    setPending(true)
    setError(null)
    try {
      const result = await addFavorite(product)
      toast.success(result.alreadySaved ? '收藏已更新' : '已收藏')
      onChanged()
    } catch (cause) {
      setError(message(cause))
      toast.error(message(cause))
    } finally {
      setPending(false)
    }
  }

  /**
   * The AI page needs the plugin to download the photos itself, so this only
   * carries URLs across; nothing is fetched here.
   */
  function openInAiImage() {
    if (shown === null || shown.images.length === 0) return
    sendToAiImage({ images: shown.images, title: shown.title })
    toast.success(`已把 ${String(shown.images.length)} 张图片带到 AI 生图`)
    onClose()
  }

  async function drop() {
    if (favorite === null) return
    setPending(true)
    setError(null)
    try {
      await removeFavorite(favorite.favoriteId)
      toast.success('已取消收藏')
      onChanged()
      onClose()
    } catch (cause) {
      setError(message(cause))
      toast.error(message(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={product !== null}
      onOpenChange={(open) => {
        if (!open) {
          setIndex(0)
          setError(null)
          onClose()
        }
      }}
    >
      <DialogContent className="supply-dialog">
        <DialogHeader>
          <DialogTitle>
            {shown?.title === '' || shown === null ? '未命名商品' : shown.title}
          </DialogTitle>
          <DialogDescription>商品详情与全部可用图片</DialogDescription>
        </DialogHeader>
        {shown === null ? null : (
          <div className="supply-dialog-body">
            <div className="supply-dialog-media">
              <div className="supply-dialog-main">
                {shown.images[index] === undefined ? (
                  <span className="supply-empty">这件商品没有图片</span>
                ) : (
                  <img src={shown.images[index]} alt={shown.title} />
                )}
              </div>
              {shown.images.length <= 1 ? null : (
                <div className="supply-dialog-strip">
                  {shown.images.map((url, position) => (
                    <button
                      key={`${url}-${position}`}
                      type="button"
                      aria-label={`查看商品图片 ${position + 1}`}
                      aria-pressed={position === index}
                      className={
                        position === index
                          ? 'supply-dialog-thumb is-active'
                          : 'supply-dialog-thumb'
                      }
                      onClick={() => setIndex(position)}
                    >
                      <img src={url} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="supply-dialog-side">
              <p className="supply-dialog-price">
                ¥ {shown.price === '' ? '—' : shown.price}
              </p>
              <p className="supply-dialog-description">
                {shown.description === '' ? '暂无描述' : shown.description}
              </p>
              <dl className="supply-dialog-meta">
                <dt>发布时间</dt>
                <dd>{publishedText(shown)}</dd>
                <dt>图片</dt>
                <dd>{shown.images.length} 张</dd>
                <dt>商户标识</dt>
                <dd>{shown.merchantId === '' ? '未提供' : shown.merchantId}</dd>
                {favorite === null ? null : (
                  <>
                    <dt>收藏时间</dt>
                    <dd>
                      {new Date(favorite.savedAt).toLocaleString('zh-CN', {
                        hour12: false,
                      })}
                    </dd>
                  </>
                )}
              </dl>

              {error === null ? null : (
                <p className="supply-error" role="alert">
                  {error}
                </p>
              )}

              <div className="supply-dialog-actions">
                {aiImageReady ? (
                  <Button
                    variant="secondary"
                    disabled={shown.images.length === 0}
                    title={
                      shown.images.length === 0
                        ? '这件商品没有图片，无法生图'
                        : '把商品图片带进 AI 生图'
                    }
                    onClick={openInAiImage}
                  >
                    <Sparkles data-icon="inline-start" />
                    AI 生图
                  </Button>
                ) : null}
                {favorite === null ? (
                  <Button disabled={pending} onClick={() => void save()}>
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Heart data-icon="inline-start" />
                    )}
                    收藏商品
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void drop()}
                  >
                    <Trash2 data-icon="inline-start" />
                    取消收藏
                  </Button>
                )}
                <Button variant="outline" onClick={() => void copy(shown.title, '标题')}>
                  <Copy data-icon="inline-start" />
                  复制标题
                </Button>
                <Button
                  variant="outline"
                  disabled={shown.images.length === 0}
                  onClick={() => void copy(shown.images.join('\n'), '图片链接')}
                >
                  <Copy data-icon="inline-start" />
                  复制图片链接
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void copy(productText(shown), '商品资料')}
                >
                  <Copy data-icon="inline-start" />
                  复制资料
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
