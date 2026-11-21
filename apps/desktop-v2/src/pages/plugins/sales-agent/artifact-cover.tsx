import { ImageOff } from './icons'
import { Skeleton } from './controls'
import { previewAgentArtifact } from './api'
import { useAgentQuery } from './use-query'
import { Tooltip } from '@proxyshard/shardx-ui-kit'

export function ArtifactCover({
  jobId,
  artifactId,
  title,
}: {
  jobId: string
  artifactId?: string | undefined
  title: string
}) {
  const result = useAgentQuery(JSON.stringify([jobId, artifactId]), async () =>
    artifactId ? previewAgentArtifact(jobId, artifactId) : null,
  )
  return (
    <Tooltip content={result.error ?? title}>
      <span
        tabIndex={0}
        className="inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-control bg-bg-weak-50 text-text-sub-600 [&_img]:size-full [&_img]:object-cover [&>svg]:size-4"
      >
        {result.loading ? (
          <Skeleton className="size-10" />
        ) : result.data ? (
          <img src={result.data} alt={title} />
        ) : (
          <ImageOff aria-label="图片暂不可用" />
        )}
      </span>
    </Tooltip>
  )
}
