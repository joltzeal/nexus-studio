import { useEffect, useRef, useState } from 'react'
import type { ProductImage as ImageMetadata } from '@nexus/plugin-contracts/products'
import { readProductImage } from '../../../raccoon/plugins/products/images'

export function ProductImage({
  image,
  enabled = true,
}: {
  image: ImageMetadata | null
  enabled?: boolean
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<{ id: string; url: string | null } | null>(null)
  const id = image?.id
  const mime = image?.mime
  const name = image?.name
  const bytes = image?.bytes
  const sha256 = image?.sha256
  useEffect(() => {
    if (
      !enabled ||
      id === undefined ||
      mime === undefined ||
      name === undefined ||
      bytes === undefined ||
      sha256 === undefined
    )
      return
    const controller = new AbortController()
    let url: string | undefined
    const load = () =>
      void readProductImage({ id, mime, name, bytes, sha256 }, controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return
          url = URL.createObjectURL(new Blob([data], { type: mime }))
          setPreview({ id, url })
        })
        .catch(() => {
          if (!controller.signal.aborted) setPreview({ id, url: null })
        })
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              observer?.disconnect()
              load()
            }
          })
    if (observer && anchor.current) observer.observe(anchor.current)
    else load()
    return () => {
      observer?.disconnect()
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [enabled, id, mime, name, bytes, sha256])
  const current = enabled && preview?.id === id ? preview : null
  const label = !image
    ? '无图片'
    : !enabled
      ? '预览不可用'
      : current
        ? '读取失败'
        : '待加载'
  return (
    <div
      ref={anchor}
      className="flex aspect-square size-full items-center justify-center overflow-hidden rounded border border-stroke-soft-200 bg-bg-weak-50"
    >
      {current?.url ? (
        <img
          src={current.url}
          alt={image?.name ?? ''}
          className="size-full object-cover"
        />
      ) : (
        <span className="text-micro text-text-soft-400">{label}</span>
      )}
    </div>
  )
}
