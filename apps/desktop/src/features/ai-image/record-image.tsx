import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { imageObjectUrl } from './api'
import type { StoredFile } from './types'

/** The read that finished last, tagged with the image it belongs to. */
interface Loaded {
  key: string
  url: string | null
}

/**
 * Reads a plugin-owned image in chunks and shows it from an object URL. Rows and
 * the detail dialog share the same cache entry, so opening a record does not
 * download its image twice.
 */
export function RecordImage({
  file,
  alt,
  className,
}: {
  file: Pick<StoredFile, 'id' | 'mime'> | null
  alt: string
  className?: string
}) {
  // Records are re-fetched on every poll, so only the identity matters here;
  // keying on the object would restart the read on each refresh.
  const id = file?.id ?? null
  const mime = file?.mime ?? null
  const key = id === null || mime === null ? null : `${id}:${mime}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (id === null || mime === null) return
    const current = `${id}:${mime}`
    let active = true
    void imageObjectUrl(id, mime).then(
      (url) => {
        if (active) setLoaded({ key: current, url })
      },
      () => {
        if (active) setLoaded({ key: current, url: null })
      },
    )
    return () => {
      active = false
    }
  }, [id, mime])

  const missing = (
    <div className={className ?? 'size-full'} role="img" aria-label="图片不可用">
      <ImageOff aria-hidden="true" />
    </div>
  )
  // Both "nothing to show" and "a different image than the one loaded" are
  // derived during render, so the effect never has to reset state.
  if (key === null) return missing
  if (loaded === null || loaded.key !== key) {
    return <Skeleton className={className ?? 'size-full'} aria-label="正在读取图片" />
  }
  if (loaded.url === null) return missing
  return <img src={loaded.url} alt={alt} className={className} draggable={false} />
}
