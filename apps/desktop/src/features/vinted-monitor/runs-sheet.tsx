import { useEffect, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { listRuns } from './api'
import {
  formatTime,
  message,
  runStatusText,
  runSummary,
  type Monitor,
  type Run,
  type RunStatus,
} from './types'

const POLL_MS = 4000

function badgeVariant(status: RunStatus): 'secondary' | 'destructive' | 'outline' {
  if (status === 'success') return 'secondary'
  if (status === 'failed') return 'destructive'
  return 'outline'
}

export interface RunsSheetProps {
  monitor: Monitor
  onOpenChange: (open: boolean) => void
}

/** Run history for one monitor; polls only while something is still running. */
export function RunsSheet({ monitor, onOpenChange }: RunsSheetProps) {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    void listRuns(monitor.id, 50).then(
      (result) => {
        if (!active) return
        setRuns(result.items)
        setError(null)
      },
      (cause: unknown) => {
        if (!active) return
        setRuns([])
        setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [monitor.id, nonce])

  const hasRunning = (runs ?? []).some((run) => run.status === 'running')

  useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(() => {
      setNonce((current) => current + 1)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [hasRunning])

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>采集记录</SheetTitle>
          <SheetDescription>
            {monitor.name} · 每次采集都会留一条记录，包含发现、新增与失败数量。
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {error === null ? null : <p className="vinted-error">{error}</p>}
          {runs === null ? (
            <p className="vinted-muted" role="status">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" /> 正在读取记录…
            </p>
          ) : runs.length === 0 ? (
            <p className="vinted-muted">
              <History aria-hidden="true" /> 还没有采集记录，点「立即采集」跑一次。
            </p>
          ) : (
            <ul className="vinted-run-list">
              {runs.map((run) => (
                <li key={run.id} className="vinted-run">
                  <div className="vinted-run-head">
                    <Badge variant={badgeVariant(run.status)}>
                      {run.status === 'running' ? (
                        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                      ) : null}
                      {runStatusText(run.status)}
                    </Badge>
                    <span className="vinted-run-time">{formatTime(run.startedAt)}</span>
                  </div>
                  <p className="vinted-run-summary">{runSummary(run)}</p>
                  <p className="vinted-muted">
                    {run.pages} 页 · 结束于 {formatTime(run.finishedAt)}
                  </p>
                  {run.error === null ? null : (
                    <p className="vinted-error">{run.error}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
