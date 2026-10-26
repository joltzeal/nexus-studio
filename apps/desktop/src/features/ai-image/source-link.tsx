import type { MouseEvent } from 'react'
import { toast } from '@/components/ui/toast'
import { openExternalUrl } from '@/lib/platform/external-url'
import type { GenerationSource } from './types'
import { safeSourceUrl } from './source'

export function SourceLink({ source }: { source: GenerationSource }) {
  const url = safeSourceUrl(source.url)
  function open(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (url !== null) {
      void openExternalUrl(url).catch(() => toast.error('无法打开来源商品，请重试。'))
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="break-words text-muted-foreground">来源：{source.title}</span>
      {url === null ? (
        <span className="text-muted-foreground">来源链接无效</span>
      ) : (
        <a
          className="w-fit text-primary underline underline-offset-4"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={open}
          onAuxClick={(event) => {
            if (event.button === 1) open(event)
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          查看来源商品
        </a>
      )}
    </div>
  )
}
