import { useState } from 'react'
import {
  Copy,
  KeyRound,
  Link2,
  MoreHorizontal,
  RefreshCw,
  Repeat,
  Trash2,
  UserPlus,
} from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import type { AccountTarget } from './accounts-bridge'
import { changeToken, clearRecords, removeRecord, renewByTels } from './api'
import { appTypeLabel, message, recordExpired, shortTime, type SmsRecord } from './types'

export interface RecordsPanelProps {
  records: SmsRecord[]
  total: number
  query: string
  busy: boolean
  accounts: AccountTarget[]
  onQueryChange: (value: string) => void
  onRefresh: () => void
  onChanged: () => Promise<void>
  onRead: (record: SmsRecord) => void
  onLink: (record: SmsRecord) => void
}

/** The confirm dialog serves two actions, so its title is derived. */
function pendingTitle(
  pending: { kind: 'one'; record: SmsRecord } | { kind: 'all' } | null,
): string {
  if (pending === null) return ''
  return pending.kind === 'all' ? '清空本机号码列表？' : `删除 ${pending.record.tel}？`
}

/**
 * The numbers this machine knows about. The provider's own order endpoints are
 * searchable by order number only, so this table is the browsing surface: every
 * purchase and every synced order lands here.
 */
export function RecordsPanel({
  records,
  total,
  query,
  busy,
  accounts,
  onQueryChange,
  onRefresh,
  onChanged,
  onRead,
  onLink,
}: RecordsPanelProps) {
  const [pending, setPending] = useState<
    { kind: 'one'; record: SmsRecord } | { kind: 'all' } | null
  >(null)
  const [working, setWorking] = useState<string | null>(null)

  async function copy(value: string, done: string) {
    if (value === '') {
      toast.error('这个号码还没有接码链接')
      return
    }
    if (await copyText(value)) toast.success(done)
    else toast.error('复制失败，请检查剪贴板权限后重试。')
  }

  async function renew(record: SmsRecord) {
    setWorking(record.tel)
    try {
      const report = await renewByTels([record.tel])
      if (report.failed > 0)
        toast.error(`续费失败：${report.failedList.join('；') || '未知原因'}`)
      else toast.success('续费成功')
      await onChanged()
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setWorking(null)
    }
  }

  async function rotate(record: SmsRecord) {
    if (record.apiId === null) return
    setWorking(record.tel)
    try {
      await changeToken(record.apiId)
      toast.success('接码链接已更换，旧链接立即失效')
      await onChanged()
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setWorking(null)
    }
  }

  return (
    <>
      <div className="sim8-toolbar">
        <span className="result-count">
          {records.length} / {total} 个号码
        </span>
        <div className="sim8-search-input">
          <Input
            aria-label="搜索号码"
            placeholder="搜索号码、订单号或备注"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
          <RefreshCw
            data-icon="inline-start"
            className={busy ? 'animate-spin' : undefined}
          />
          刷新
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || total === 0}
          onClick={() => setPending({ kind: 'all' })}
        >
          <Trash2 data-icon="inline-start" />
          清空
        </Button>
      </div>

      <div className="space-table-panel">
        <Table aria-label="号码列表">
          <TableHeader>
            <TableRow>
              <TableHead>号码</TableHead>
              <TableHead>订单</TableHead>
              <TableHead>到期</TableHead>
              <TableHead>最近验证码</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((record) => {
              const busyRow = working === record.tel
              return (
                <TableRow key={record.tel}>
                  <TableCell>
                    <span className="sim8-tel">
                      <strong>{record.tel}</strong>
                      {recordExpired(record) ? (
                        <Badge variant="outline">已过期</Badge>
                      ) : null}
                    </span>
                    <small className="block text-muted-foreground">
                      {record.remark || appTypeLabel(record.type)}
                    </small>
                  </TableCell>
                  <TableCell>
                    <code className="sim8-mono">{record.ordernum || '—'}</code>
                  </TableCell>
                  <TableCell>{shortTime(record.endTime)}</TableCell>
                  <TableCell>
                    {record.lastRead === null ? (
                      <span className="sim8-muted">—</span>
                    ) : record.lastRead.code === null ? (
                      <span className="sim8-muted">暂无</span>
                    ) : (
                      <code className="sim8-code">{record.lastRead.code}</code>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="table-actions">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`提取 ${record.tel} 的验证码`}
                        title="提取验证码"
                        disabled={busyRow}
                        onClick={() => onRead(record)}
                      >
                        <KeyRound />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`复制 ${record.tel}`}
                        title="复制号码"
                        onClick={() => void copy(record.tel, '号码已复制')}
                      >
                        <Copy />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`把 ${record.tel} 写入账号`}
                        title="写入 Vinted 账号"
                        disabled={accounts.length === 0}
                        onClick={() => onLink(record)}
                      >
                        <UserPlus />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`${record.tel} 的更多操作`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={record.api === ''}
                            onSelect={() => void copy(record.api, '接码链接已复制')}
                          >
                            <Link2 />
                            复制接码链接
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={busyRow}
                            onSelect={() => void renew(record)}
                          >
                            <Repeat />
                            续费这个号码
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={record.apiId === null || busyRow}
                            onSelect={() => void rotate(record)}
                          >
                            <RefreshCw />
                            更换接码链接
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setPending({ kind: 'one', record })}
                          >
                            <Trash2 />
                            从列表删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        {records.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{total === 0 ? '还没有号码' : '没有找到号码'}</EmptyTitle>
              <EmptyDescription>
                {total === 0
                  ? '到「买号」买一个号码，或从「订单」里同步已购买的号码。'
                  : '调整搜索条件。'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingTitle(pending)}</AlertDialogTitle>
            <AlertDialogDescription>
              只删除本机记录，不会退号，也不影响 SIM8
              账号里已购买的号码。接码链接一旦删掉就找不回来。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault()
                const target = pending
                setPending(null)
                const run =
                  target?.kind === 'one'
                    ? removeRecord(target.record.tel)
                    : clearRecords()
                void run
                  .then(() => onChanged())
                  .then(() => toast.success('已删除'))
                  .catch((cause: unknown) => toast.error(message(cause)))
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
