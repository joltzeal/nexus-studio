import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ImageOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { supplyImageCache } from './image-cache'

const RetryContext = createContext(0)

export function SupplyImageGroup({
  generation,
  children,
}: {
  generation: number
  children: ReactNode
}) {
  useEffect(() => () => supplyImageCache.clearUnused(), [generation])
  return <RetryContext.Provider value={generation}>{children}</RetryContext.Provider>
}

interface Props {
  url: string
  alt?: string
  lazy?: boolean
  compact?: boolean
  /** Only enable inside a noninteractive container, never inside a card button. */
  retryButton?: boolean
}

export function SupplyImage(props: Props) {
  const generation = useContext(RetryContext)
  return <ImageView key={`${props.url}:${generation}`} {...props} />
}

function ImageView({
  url,
  alt = '',
  lazy = false,
  compact = false,
  retryButton = false,
}: Props) {
  const node = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(!lazy)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    attempt: number
    src: string | null
    error: string | null
  } | null>(null)
  const current = result?.attempt === attempt ? result : null

  useEffect(() => {
    if (!lazy) return
    const element = node.current
    if (element === null) return
    if (typeof IntersectionObserver === 'undefined') {
      // The normal path is supported by the desktop WebViews. Older previews
      // can still load images without depending on the observer API.
      queueMicrotask(() => setVisible(true))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const next = entries.some((entry) => entry.isIntersecting)
        if (!next) setAttempt((value) => value + 1)
        setVisible(next)
      },
      { rootMargin: '160px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [lazy])

  useEffect(() => {
    if (!visible || url === '') return
    let active = true
    const lease = supplyImageCache.acquire(url)
    void lease.promise.then(
      (src) => {
        if (active) setResult({ attempt, src, error: null })
      },
      (cause: unknown) => {
        if (active)
          setResult({
            attempt,
            src: null,
            error: cause instanceof Error ? cause.message : '图片加载失败，请刷新重试',
          })
      },
    )
    return () => {
      active = false
      lease.release()
    }
  }, [url, visible, attempt])

  const error = current?.error ?? null
  return (
    <span
      ref={node}
      className="relative flex h-full min-h-6 w-full items-center justify-center"
    >
      {visible && current?.src ? (
        <img
          src={current.src}
          alt={alt}
          className="h-full w-full object-cover"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => {
            supplyImageCache.invalidate(url, current.src!)
            setResult({ attempt, src: null, error: '图片无法解码，请重试或选择其他图片' })
          }}
        />
      ) : (
        <span
          className={
            compact
              ? 'text-muted-foreground'
              : 'flex min-h-20 flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground'
          }
          role="status"
          title={error ?? (url === '' ? '暂无图片' : '图片加载中')}
        >
          {error !== null || url === '' ? (
            <ImageOff className="size-4" aria-hidden="true" />
          ) : (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          )}
          <span className={compact ? 'sr-only' : undefined}>
            {error ?? (url === '' ? '暂无图片' : '图片加载中')}
            {error !== null && !retryButton ? '；刷新可重试' : ''}
          </span>
          {error !== null && retryButton ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                supplyImageCache.clearUnused()
                setAttempt((value) => value + 1)
              }}
            >
              重试图片
            </Button>
          ) : null}
        </span>
      )}
    </span>
  )
}
