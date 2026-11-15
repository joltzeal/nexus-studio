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
import type { Account, Binding } from './types'

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
                <span className="text-muted-foreground">{entry.currency ?? ''}</span>
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
                {entry.amount} {entry.currency ?? ''}
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

export function AccountWindowSessions({
  accountId,
  observation,
  bindings,
}: {
  accountId: string
  observation: Account['observation']
  bindings: readonly Binding[]
}) {
  const windows = bindings.filter((binding) => binding.accountId === accountId)
  if (windows.length === 0) return <span className="text-muted-foreground">未关联</span>
  return (
    <ul className="space-y-1 text-xs" aria-label="逐窗口登录观察">
      {windows.map((binding) => {
        const observed = observation?.sessions[binding.windowId]
        const session =
          observed?.bindingRevision === binding.revision &&
          observed?.accountId === accountId
            ? observed
            : undefined
        const failed =
          observation?.checks[`session:${binding.windowId}`]?.outcome === 'failed'
        return (
          <li key={binding.windowId} title={binding.windowId}>
            <span className={session?.status === 'logged_out' ? 'text-destructive' : ''}>
              {`窗口 ${binding.windowId.slice(0, 8)}：${
                session === undefined
                  ? '未检查'
                  : session.status === 'authenticated'
                    ? '已登录'
                    : '已掉登'
              }`}
            </span>
            {session === undefined ? null : (
              <time dateTime={session.observedAt} className="block text-muted-foreground">
                {formatAccountCreatedAt(session.observedAt)}
              </time>
            )}
            {failed ? (
              <span className="block text-muted-foreground">
                本次检查失败{session === undefined ? '' : '，保留上次观察'}
              </span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

export function AccountBankSummary({
  accountName,
  observation,
  onDetails,
}: {
  accountName: string
  observation: Account['observation']
  onDetails: () => void
}) {
  const bank = observation?.bankAccounts
  const failed = observation?.checks.bankAccounts?.outcome === 'failed'
  if (bank === undefined)
    return (
      <span className="text-xs text-muted-foreground">
        {failed ? '读取失败，未检查' : '未检查'}
      </span>
    )
  const defaults = bank.records.filter((record) => record.is_default)
  return (
    <div className="space-y-1 text-xs">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onDetails}
        aria-label={`查看 ${accountName} 的收款资料`}
        className="h-auto flex-col items-start gap-0.5 py-1 font-normal"
      >
        <span>
          {bank.records.length === 0
            ? '已检查，未绑定'
            : `${String(bank.records.length)} 个收款账户`}
        </span>
        {defaults.length === 1 ? (
          <span className="font-mono">{defaults[0]!.account_number}</span>
        ) : null}
        {bank.records.length > 0 && defaults.length !== 1 ? (
          <span className="text-muted-foreground">
            {defaults.length === 0 ? '无默认项' : '默认项异常'}
          </span>
        ) : null}
        <time dateTime={bank.observedAt} className="text-muted-foreground">
          {formatAccountCreatedAt(bank.observedAt)}
        </time>
      </Button>
      {failed ? (
        <span className="block text-muted-foreground">本次读取失败，保留此前资料</span>
      ) : null}
    </div>
  )
}

export function AccountBankDetails({
  bankAccounts,
}: {
  bankAccounts: NonNullable<NonNullable<Account['observation']>['bankAccounts']>
}) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        官方接口 ·{' '}
        <time dateTime={bankAccounts.observedAt}>
          {formatAccountCreatedAt(bankAccounts.observedAt)}
        </time>
      </p>
      {bankAccounts.records.length === 0 ? <p>已检查，未绑定收款账户。</p> : null}
      {bankAccounts.records.map((record) => (
        <dl
          key={record.id}
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-b pb-3 text-sm last:border-0"
        >
          <dt className="text-muted-foreground">账户</dt>
          <dd className="break-all font-mono">{record.account_number}</dd>
          <dt className="text-muted-foreground">姓名</dt>
          <dd className="break-all">
            {record.hide_name ? '平台隐藏姓名' : record.name || '—'}
          </dd>
          <dt className="text-muted-foreground">Routing number</dt>
          <dd className="font-mono">{record.routing_number}</dd>
          <dt className="text-muted-foreground">原始类型</dt>
          <dd className="break-all">{record.spending_type}</dd>
          <dt className="text-muted-foreground">默认账户</dt>
          <dd>{record.is_default ? '是' : '否'}</dd>
        </dl>
      ))}
    </div>
  )
}
