import { ImageOff } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { previewAgentArtifact } from './api'
import { useAgentQuery } from './use-query'

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
    <span className="sales-agent-runtime-cover" title={result.error ?? title}>
      {result.loading ? (
        <Skeleton className="size-10" />
      ) : result.data ? (
        <img src={result.data} alt={title} />
      ) : (
        <ImageOff aria-label="图片暂不可用" />
      )}
    </span>
  )
}
