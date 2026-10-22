import { useState } from 'react'
import { ChevronsLeftRight } from 'lucide-react'
import { RecordImage } from './record-image'
import type { StoredFile } from './types'

/**
 * Before/after comparison by dragging one divider instead of putting two images
 * side by side: the difference between the reference photo and the result is
 * easier to judge when both occupy the same pixels.
 */
export function CompareSlider({
  before,
  after,
  beforeLabel = '参考图',
  afterLabel = '生成图',
}: {
  before: StoredFile | null
  after: StoredFile
  beforeLabel?: string
  afterLabel?: string
}) {
  const [position, setPosition] = useState(50)

  if (before === null) {
    return (
      <div className="compare is-single">
        <div className="compare-layer">
          <RecordImage file={after} alt={afterLabel} className="compare-image" />
        </div>
      </div>
    )
  }

  return (
    <div className="compare">
      <div className="compare-layer">
        <RecordImage file={after} alt={afterLabel} className="compare-image" />
      </div>
      <div
        className="compare-layer"
        style={{ clipPath: `inset(0 ${String(100 - position)}% 0 0)` }}
      >
        <RecordImage file={before} alt={beforeLabel} className="compare-image" />
      </div>
      <div
        className="compare-divider"
        style={{ left: `${String(position)}%` }}
        aria-hidden="true"
      >
        <span className="compare-handle">
          <ChevronsLeftRight />
        </span>
      </div>
      <input
        type="range"
        className="compare-range"
        min={0}
        max={100}
        step={0.5}
        value={position}
        aria-label="拖动对比参考图与生成图"
        onChange={(event) => setPosition(Number(event.target.value))}
      />
      <span className="compare-tag compare-tag-before">{beforeLabel}</span>
      <span className="compare-tag compare-tag-after">{afterLabel}</span>
    </div>
  )
}
