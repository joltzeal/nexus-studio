import { useEffect, useRef, useState } from 'react'
import type { ProductImage } from '@nexus/plugin-products/contracts'
import { Skeleton } from '@/components/ui/skeleton'
import { ProductImagePreview } from '@/features/products/product-image'

/** Only read images near the independently scrolling panel, including assigned cards. */
export function AgentProductCover({ image }: { image: ProductImage }) {
  const element = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === 'undefined',
  )
  useEffect(() => {
    const node = element.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((entry) => entry.isIntersecting))
      },
      { rootMargin: '80px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={element} className="sales-agent-product-cover">
      {visible ? (
        <ProductImagePreview image={image} compact />
      ) : (
        <Skeleton className="size-10" />
      )}
    </div>
  )
}
