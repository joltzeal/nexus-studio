import { useEffect, useState } from 'react'
import type { ProductImage } from '@nexus/plugin-products/contracts'
import { ImageOff, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { productImageUrl } from './api'
import { productError } from './product-form'

export function ProductImagePreview({
  image,
  compact = false,
}: {
  image: ProductImage
  compact?: boolean
}) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    key: string
    url: string | null
    error: string | null
  }>({ key: '', url: null, error: null })
  const key = `${image.id}:${image.sha256}:${String(attempt)}`

  useEffect(() => {
    let active = true
    void productImageUrl(image).then(
      (url) => {
        if (active) setState({ key, url, error: null })
      },
      (cause: unknown) => {
        if (active) setState({ key, url: null, error: productError(cause) })
      },
    )
    return () => {
      active = false
    }
  }, [image, key])

  const current = state.key === key ? state : null
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted',
        compact ? 'size-10' : 'aspect-square w-full',
      )}
    >
      {current?.error ? (
        <div className="flex min-w-0 flex-col items-center gap-1 p-1 text-center">
          {compact ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={current.error}
              aria-label={`重试图片 ${image.name}`}
              onClick={() => setAttempt((value) => value + 1)}
            >
              <ImageOff />
            </Button>
          ) : (
            <>
              <p className="line-clamp-3 text-xs text-destructive">{current.error}</p>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw data-icon="inline-start" />
                重试图片
              </Button>
            </>
          )}
        </div>
      ) : current?.url ? (
        <img
          src={current.url}
          alt={image.name}
          className="size-full object-contain"
          onError={() => setState({ key, url: null, error: '图片预览失败，请重试。' })}
        />
      ) : (
        <Skeleton className="size-full" aria-label="正在读取图片" />
      )}
    </div>
  )
}
