import { useEffect, useRef, useState } from 'react'
import { ImageOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { vintedImageCache } from './image-cache'

export function ItemImage({
  itemId,
  url,
  alt = '',
  contain = false,
  retry = false,
}: {
  itemId: string
  url: string
  alt?: string
  contain?: boolean
  retry?: boolean
}) {
  return <ImageView key={`${itemId}\n${url}`} {...{ itemId, url, alt, contain, retry }} />
}

function ImageView({
  itemId,
  url,
  alt,
  contain,
  retry,
}: {
  itemId: string
  url: string
  alt: string
  contain: boolean
  retry: boolean
}) {
  const node = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    attempt: number
    src?: string
    error?: string
  } | null>(null)
  const current = result?.attempt === attempt ? result : null
  const key = `${itemId}\n${url}`
  useEffect(() => {
    if (!node.current) return
    if (typeof IntersectionObserver === 'undefined') {
      queueMicrotask(() => setVisible(true))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '80px' },
    )
    observer.observe(node.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || !url) return
    let active = true
    const lease = vintedImageCache.acquire(key)
    void lease.promise.then(
      (src) => {
        if (active) setResult({ attempt, src })
      },
      (cause: unknown) => {
        if (active)
          setResult({
            attempt,
            error: cause instanceof Error ? cause.message : '图片加载失败',
          })
      },
    )
    return () => {
      active = false
      lease.release()
    }
  }, [visible, url, key, attempt])
  return (
    <span ref={node} className="flex size-full min-h-8 items-center justify-center">
      {current?.src ? (
        <img
          src={current.src}
          alt={alt}
          className={contain ? 'size-full object-contain' : 'size-full object-cover'}
          decoding="async"
          onError={() => {
            vintedImageCache.invalidate(key, current.src!)
            setResult({ attempt, error: '图片无法解码，请重试' })
          }}
        />
      ) : (
        <span
          className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground"
          role="status"
          title={current?.error ?? (url ? '图片加载中' : '暂无图片')}
        >
          {current?.error || !url ? (
            <ImageOff className="size-4" aria-hidden />
          ) : (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          )}
          <span className={retry ? '' : 'sr-only'}>
            {current?.error ?? (url ? '图片加载中' : '暂无图片')}
          </span>
          {current?.error && retry ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试图片
            </Button>
          ) : null}
        </span>
      )}
    </span>
  )
}
