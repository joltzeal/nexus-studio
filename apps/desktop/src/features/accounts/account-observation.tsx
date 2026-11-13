import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { accountBalanceData } from './account-observation-data'
import { formatAccountCreatedAt } from './account-table'
import type { Account } from './types'

export function AccountObservationSummary({
  observation,
}: {
  observation: Account['observation']
}) {
  if (observation === undefined) return null
  const tags = observation.tags ?? []
  const hasLabels = tags.length > 0 || observation.rating !== undefined
  if (!hasLabels && !observation.summary) return null

  return (
    <div role="group" aria-label="Agent 账号观察" className="mt-1 max-w-72 space-y-1">
      {hasLabels ? (
        <div className="flex flex-wrap items-center gap-1">
          {tags.map((tag, index) => (
            <Badge
              key={`${String(index)}-${tag}`}
              variant="outline"
              className="max-w-28"
              title={tag}
            >
              <span className="truncate">{tag}</span>
            </Badge>
          ))}
          {observation.rating !== undefined ? (
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {`评分 ${String(observation.rating)}/5`}
            </span>
          ) : null}
        </div>
      ) : null}
      {observation.summary ? (
        <p className="truncate text-xs text-muted-foreground" title={observation.summary}>
          {observation.summary}
        </p>
      ) : null}
    </div>
  )
}

export function AccountObservationBalance({
  accountName,
  observation,
}: {
  accountName: string
  observation: Account['observation']
}) {
  const balance = accountBalanceData(observation)
  if (balance === null) return <span className="text-muted-foreground">—</span>

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-auto flex-col items-stretch gap-0.5 py-1 font-normal"
          aria-label={`查看 ${accountName} 的余额来源与时间`}
        >
          {balance.amounts.map((entry) => (
            <span key={entry.key} className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{entry.label}</span>
              <span className="tabular-nums">
                {entry.amount}{' '}
                <span className="text-muted-foreground">{balance.currency}</span>
              </span>
            </span>
          ))}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
        aria-label={`余额观察：${accountName}`}
      >
        <PopoverHeader>
          <PopoverTitle>余额观察</PopoverTitle>
          <p className="truncate text-xs text-muted-foreground">{accountName}</p>
        </PopoverHeader>
        <dl className="space-y-3">
          {balance.amounts.map((entry) => (
            <div key={entry.key} className="grid grid-cols-[auto_1fr] gap-x-3">
              <dt>{entry.label}</dt>
              <dd className="text-right tabular-nums">
                {entry.amount} {balance.currency}
              </dd>
              <dd className="col-span-2 mt-1 text-xs text-muted-foreground">
                来源：{entry.sourceLabel ?? '—'} ·{' '}
                {entry.observedAt === null ? (
                  '—'
                ) : (
                  <time dateTime={entry.observedAt}>
                    {formatAccountCreatedAt(entry.observedAt)}
                  </time>
                )}
                {entry.retained ? (
                  <span className="mt-1 block">最近读取未知，保留此前金额</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">仅表示观察时的余额。</p>
      </PopoverContent>
    </Popover>
  )
}
