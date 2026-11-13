import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import type { DemoProduct } from './demo-data'
import type { JobPhase } from './demo-state'
import coverAtlas from './assets/product-covers.png'

export function ProductCover({
  product,
  compact = false,
}: {
  product: DemoProduct
  compact?: boolean
}) {
  return (
    <span
      className={cn('agent-product-cover', compact && 'agent-product-cover-compact')}
      data-cover-index={product.coverIndex}
    >
      <img
        src={coverAtlas}
        alt={`${product.label}首图`}
        loading="lazy"
        decoding="async"
        draggable={false}
        style={{
          left: `${(product.coverIndex % 3) * -100}%`,
          top: `${Math.floor(product.coverIndex / 3) * -100}%`,
        }}
      />
    </span>
  )
}

export function ProductMark({ product }: { product: DemoProduct }) {
  return (
    <span className="agent-product-mark">
      <ProductCover product={product} />
      <small>{product.imageCount} 图</small>
    </span>
  )
}

export function ReviewBadge({ product }: { product: DemoProduct }) {
  return (
    <Badge
      variant={product.review === 'skip' ? 'destructive' : 'outline'}
      className={product.review === 'ready' ? 'agent-badge-success' : undefined}
    >
      {product.review === 'ready'
        ? '检查通过'
        : product.review === 'skip'
          ? '将跳过'
          : '待检查'}
    </Badge>
  )
}

const phaseLabels: Record<JobPhase, string> = {
  queued: '等待中',
  checking: '检查账号',
  executing: '执行中',
  completed: '已完成',
  blocked: '账号已停止',
  skipped: '已跳过',
  cancelled: '已取消',
}

export function JobBadge({ phase }: { phase: JobPhase }) {
  return (
    <Badge
      variant={
        phase === 'blocked'
          ? 'destructive'
          : phase === 'checking' || phase === 'executing'
            ? 'default'
            : 'outline'
      }
      className={phase === 'completed' ? 'agent-badge-success' : undefined}
    >
      {phaseLabels[phase]}
    </Badge>
  )
}
