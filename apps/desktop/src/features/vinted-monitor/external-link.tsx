import type { MouseEvent, ReactNode } from 'react'
import { toast } from '@/components/ui/toast'
import { openExternalUrl, safeExternalHttpUrl } from '@/lib/platform/external-url'

export function VintedExternalLink({
  href,
  children,
  className = 'vinted-text-link',
  title,
  fallback = null,
}: {
  href: string | null | undefined
  children: ReactNode
  className?: string
  title?: string
  fallback?: ReactNode
}) {
  const url = safeExternalHttpUrl(href)
  if (!url) return fallback
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()
    void openExternalUrl(url).catch(() => {
      toast.error('无法打开链接，请重试或复制链接后在浏览器中打开。')
    })
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title}
      onClick={open}
      onAuxClick={(event) => {
        if (event.button === 1) open(event)
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  )
}
