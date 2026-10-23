import { useState } from 'react'
import { KeyRound, RefreshCw, Repeat, Search, UserPlus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
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
import type { AccountTarget } from './accounts-bridge'
import { fetchOrderApi, listOrderApis, listOrders, renewByTels } from './api'
import {
  allocationLabel,
  message,
  shortTime,
  type OrderApisResult,
  type OrderItem,
  type SmsRecord,
} from './types'

const PAGE_SIZE = 20

export interface OrdersPanelProps {
  accounts: AccountTarget[]
  onSynced: () => Promise<void>
  onRead: (record: SmsRecord) => void
  onLink: (record: SmsRecord) => void
}

/**
 * Orders are the provider's own record of a purchase. `order/api` is also the
 * only way to collect a deferred order once its allocation finished, so the
 * table's main action is "sync the numbers".
 */
export function OrdersPanel({ accounts, onSynced, onRead, onLink }: OrdersPanelProps) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<OrderItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [synced, setSynced] = useState<OrderApisResult | null>(null)

  async function load(nextPage: number) {
    setBusy('list')
    setError(null)
    try {
      const result = await listOrders({
        page: nextPage,
        limit: PAGE_SIZE,
        ...(query.trim() === '' ? {} : { ordernum: query.trim() }),
      })
      setRows(result.items)
      setTotal(result.total)
      setPage(nextPage)
    } catch (cause) {
      setRows([])
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  async function sync(ordernum: string) {
    setBusy(ordernum)
    setError(null)
    try {
      const result = await listOrderApis(ordernum)
      setSynced(result)
      await onSynced()
      toast.success(
        result.total === 0
          ? '这个订单还没有分配号码'
          : `已同步 ${String(result.total)} 个号码`,
      )
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  async function single(ordernum: string) {
    setBusy(ordernum)
    try {
      const result = await fetchOrderApi(ordernum)
      if (result.record === null) toast.error('这个订单还没有分配号码')
      else toast.success(`单条号码：${result.record.tel}`)
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusy(null)
    }
  }

  async function renewSynced() {
    if (synced === null || synced.records.length === 0) return
    setBusy('renew')
    try {
      const report = await renewByTels(synced.records.map((record) => record.tel))
      if (report.failed > 0) toast.error(`有 ${String(report.failed)} 个号码续费失败`)
      else toast.success(`已续费 ${String(report.success)} 个号码`)
      await onSynced()
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusy(null)
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="sim8-orders">
      <form
        className="sim8-search"
        onSubmit={(event) => {
          event.preventDefault()
          void load(1)
        }}
      >
        <Field>
          <FieldLabel htmlFor="sim8-order-query">订单号</FieldLabel>
          <div className="sim8-row">
            <Input
              id="sim8-order-query"
              placeholder="留空查看最近的订单"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button type="submit" disabled={busy !== null}>
              <Search data-icon="inline-start" />
              查询
            </Button>
          </div>
        </Field>
      </form>

      {error === null ? null : <FieldError role="alert">{error}</FieldError>}

      <div className="space-table-panel">
        <div className="panel-heading">
          <h2>订单</h2>
          <Badge variant="secondary">{total}</Badge>
          <span>
            第 {page} / {pages} 页
          </span>
        </div>
        <Table aria-label="订单列表">
          <TableHeader>
            <TableRow>
              <TableHead>订单号</TableHead>
              <TableHead>分配状态</TableHead>
              <TableHead>申请 / 已分配</TableHead>
              <TableHead>排队到期</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((row) => (
              <TableRow key={`${row.ordernum}-${row.allocationStatus}`}>
                <TableCell>
                  <code className="sim8-mono">{row.ordernum || '—'}</code>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{allocationLabel(row.allocationStatus)}</Badge>
                  {row.failureReason === '' ? null : (
                    <small className="block text-muted-foreground">
                      {row.failureReason}
                    </small>
                  )}
                </TableCell>
                <TableCell>
                  {row.requestedNum ?? '—'} / {row.allocatedNum ?? '—'}
                </TableCell>
                <TableCell>{shortTime(row.expireAt)}</TableCell>
                <TableCell>
                  <div className="table-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null || row.ordernum === ''}
                      onClick={() => void sync(row.ordernum)}
                    >
                      <RefreshCw data-icon="inline-start" />
                      同步号码
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null || row.ordernum === ''}
                      onClick={() => void single(row.ordernum)}
                    >
                      查单条
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rows !== null && rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>没有查到订单</EmptyTitle>
              <EmptyDescription>
                换个订单号，或清空输入框查看最近的订单。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>

      <div className="sim8-pager">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null || page <= 1}
          onClick={() => void load(page - 1)}
        >
          上一页
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null || page >= pages}
          onClick={() => void load(page + 1)}
        >
          下一页
        </Button>
      </div>

      {synced === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle>订单 {synced.ordernum} 的号码</CardTitle>
            <Badge variant="secondary">{synced.total} 个</Badge>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || synced.records.length === 0}
              onClick={() => void renewSynced()}
            >
              <Repeat data-icon="inline-start" />
              全部续费
            </Button>
          </CardHeader>
          <CardContent>
            {synced.records.length === 0 ? (
              <p className="sim8-muted">
                这个订单还没有号码，分配状态：
                {allocationLabel(synced.allocation.allocationStatus)}。
              </p>
            ) : (
              <ul className="sim8-result-list">
                {synced.records.map((record) => (
                  <li key={record.tel}>
                    <div>
                      <strong>{record.tel}</strong>
                      <small>{shortTime(record.endTime)} 到期</small>
                    </div>
                    <div className="sim8-result-actions">
                      <Button variant="ghost" size="sm" onClick={() => onRead(record)}>
                        <KeyRound data-icon="inline-start" />
                        提取
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={accounts.length === 0}
                        onClick={() => onLink(record)}
                      >
                        <UserPlus data-icon="inline-start" />
                        写入账号
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
