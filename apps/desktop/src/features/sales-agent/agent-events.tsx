import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { agentError, getAgentEvents } from './api'
import { appendEvents, emptyEventStream, type EventStream } from './state'

export function AgentEvents({
  id,
  cache,
  revision,
}: {
  id: string
  cache: Map<string, EventStream>
  revision: number
}) {
  const [attempt, setAttempt] = useState(0)
  const [stream, setStream] = useState<EventStream>(
    () => cache.get(id) ?? emptyEventStream(),
  )
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      const previous = cache.get(id) ?? emptyEventStream()
      try {
        const result = await getAgentEvents(id, previous.cursor)
        if (!active) return
        const next = appendEvents(previous, result)
        cache.delete(id)
        cache.set(id, next)
        // Retain a bounded number of visited batches, each with its latest 500 events.
        if (cache.size > 20) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined && oldest !== id) cache.delete(oldest)
        }
        setStream(next)
        setLoaded(true)
        setError(null)
        setLoading(false)
        timer = setTimeout(
          () => {
            void read()
          },
          result.hasMore ? 50 : 2500,
        )
      } catch (cause) {
        if (active) {
          setError(agentError(cause))
          setLoading(false)
          timer = setTimeout(() => {
            void read()
          }, 5000)
        }
      }
    }
    void read()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [id, cache, revision, attempt])

  return (
    <section className="sales-agent-events" aria-label="执行事件">
      <div className="sales-agent-toolbar">
        <strong>执行事件</strong>
        <span>游标 {stream.cursor} · 保留最近 500 条</span>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => {
            setLoading(true)
            setAttempt((value) => value + 1)
          }}
        >
          <RefreshCw data-icon="inline-start" />
          刷新事件
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>事件读取失败</AlertTitle>
          <AlertDescription>{error} 已保留当前游标，恢复后继续读取。</AlertDescription>
        </Alert>
      ) : null}
      {!loaded && !error ? (
        <Skeleton className="h-16 w-full" aria-label="读取事件" />
      ) : null}
      <ol className="sales-agent-event-list">
        {stream.items.map((event) => (
          <li key={event.sequence}>
            <time dateTime={event.createdAt}>
              {new Date(event.createdAt).toLocaleTimeString()}
            </time>
            <Badge variant="outline">{event.kind}</Badge>
            <span>{event.message}</span>
          </li>
        ))}
      </ol>
      {loaded && !stream.items.length ? (
        <p className="text-muted-foreground">暂无执行事件。</p>
      ) : null}
    </section>
  )
}
