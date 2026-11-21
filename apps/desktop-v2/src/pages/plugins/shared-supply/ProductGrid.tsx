import { useEffect, useRef, useState } from 'react'
import { Button, Card, EmptyState, IconButton } from '@proxyshard/shardx-ui-kit'
import { BuildingIcon, StarOutlineIcon } from '../../../shared/icons'
import {
  supplyPublishedText,
  type SupplyProduct,
} from '../../../raccoon/plugins/shared-supply/model'
import { SupplyImageSession } from '../../../raccoon/plugins/shared-supply/image-session'

export function ProductImage({
  url,
  session,
  alt,
  compact = false,
}: {
  url: string
  session: SupplyImageSession | null
  alt: string
  compact?: boolean
}) {
  const container = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [result, setResult] = useState<{
    url: string
    session: SupplyImageSession
    source?: string
    error?: string
  } | null>(null)
  useEffect(() => {
    if (!container.current) return
    if (typeof IntersectionObserver !== 'function') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting === true),
      { rootMargin: '120px' },
    )
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (session === null || url === '' || !visible) return
    const lease = session.acquire(url)
    let live = true
    lease.url
      .then((value) => {
        if (live) setResult({ url, session, source: value })
      })
      .catch((cause: unknown) => {
        if (live)
          setResult({
            url,
            session,
            error: cause instanceof Error ? cause.message : '图片加载失败',
          })
      })
    return () => {
      live = false
      lease.release()
    }
  }, [session, url, visible])
  const current =
    visible && result?.url === url && result.session === session ? result : null
  return (
    <span ref={container} className="block size-full">
      {current?.source ? (
        <img
          src={current.source}
          alt={alt}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() =>
            setResult({ ...current, source: undefined, error: '图片无法解码' })
          }
        />
      ) : compact ? (
        <span className="grid size-full place-items-center text-text-soft-400"><BuildingIcon className="size-3.5" /></span>
      ) : (
        <span className="flex size-full items-center justify-center p-3 text-center text-secondary text-text-soft-400">
          {current?.error ?? '正在加载图片…'}
        </span>
      )}
    </span>
  )
}

export function ProductGrid({
  products,
  session,
  imagesAvailable,
  favorites,
  favoritesAvailable,
  onOpen,
  onFavorite,
}: {
  products: SupplyProduct[]
  session: SupplyImageSession | null
  imagesAvailable: boolean
  favorites: ReadonlySet<string>
  favoritesAvailable: boolean
  onOpen: (product: SupplyProduct) => void
  onFavorite: (product: SupplyProduct) => void
}) {
  if (products.length === 0) return <EmptyState title="暂无商品" />
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {products.map((product) => {
        const title = product.title.trim() || '未命名商品'
        return (
          <Card
            key={product.id}
            variant="surface"
            padding="none"
            className="overflow-hidden"
          >
            <Button
              type="button"
              mode="ghost"
              variant="neutral"
              className="!block !h-auto !w-full !rounded-none !p-0 !text-left"
              onClick={() => onOpen(product)}
            >
              <span className="block aspect-square bg-bg-weak-50">
                {imagesAvailable && product.coverUrl !== '' ? (
                  <ProductImage url={product.coverUrl} session={session} alt="" />
                ) : (
                  <span className="flex size-full items-center justify-center p-3 text-secondary text-text-soft-400">
                    {imagesAvailable ? '无商品图片' : '图片传输不可用'}
                  </span>
                )}
              </span>
              <span className="flex flex-col gap-1 px-3 py-2">
                <strong className="line-clamp-2 text-body text-text-strong-950">
                  {title}
                </strong>
                <span className="text-ui text-text-sub-600">
                  ¥ {product.price || '—'}
                </span>
                <span className="text-secondary text-text-soft-400">
                  {product.images.length} 张图片 · {supplyPublishedText(product)}
                </span>
              </span>
            </Button>
            <div className="flex items-center justify-end px-2 pb-2">
              {favoritesAvailable && (
                <IconButton
                  label={favorites.has(product.id) ? '更新收藏' : '收藏商品'}
                  icon={<StarOutlineIcon className="size-3.5" />}
                  variant={favorites.has(product.id) ? 'primary' : 'neutral'}
                  mode="ghost"
                  onClick={() => onFavorite(product)}
                />
              )}
            </div>
          </Card>
        )
      })}
    </div>
  )
}
