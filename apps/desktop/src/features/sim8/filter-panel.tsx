import { useEffect, useState, type FormEvent } from 'react'
import { ListChecks, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/ui/search-select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toast'
import { createFilterOrder, filterDetail, listFilterApps } from './api'
import {
  filterStatusLabel,
  formatMoney,
  message,
  shortTime,
  type FilterAppItem,
  type FilterDetail,
} from './types'

/**
 * Filtering is a different product from buying: you upload numbers you already
 * have and pay per number that is still alive. The provider answers with an
 * order id that has to be polled, so the panel keeps both steps on screen.
 */
export function FilterPanel() {
  const [apps, setApps] = useState<FilterAppItem[]>([])
  const [appId, setAppId] = useState('')
  const [code, setCode] = useState('US')
  const [numbers, setNumbers] = useState('')
  const [orderId, setOrderId] = useState('')
  const [detail, setDetail] = useState<FilterDetail | null>(null)
  const [busy, setBusy] = useState<'create' | 'detail' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void listFilterApps().then(
      (catalog) => {
        if (!active) return
        setApps(catalog.items)
        setAppId(String(catalog.items[0]?.id ?? ''))
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [])

  const selected = apps.find((app) => String(app.id) === appId) ?? null
  const list = numbers
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (selected === null) {
      setError('先选择一个项目。')
      return
    }
    if (list.length === 0) {
      setError('至少要有一个号码。')
      return
    }
    setBusy('create')
    setError(null)
    setDetail(null)
    try {
      const created = await createFilterOrder({
        appId: selected.id,
        code: code.trim().toUpperCase(),
        numbers: list,
      })
      setOrderId(String(created.orderId))
      toast.success(
        `已提交 ${String(created.count)} 个号码，订单 ${String(created.orderId)}`,
      )
      setDetail(await filterDetail(created.orderId))
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  async function loadDetail() {
    const id = Number(orderId.trim())
    if (!Number.isInteger(id) || id <= 0) {
      setError('订单 ID 要是正整数。')
      return
    }
    setBusy('detail')
    setError(null)
    try {
      setDetail(await filterDetail(id))
    } catch (cause) {
      setDetail(null)
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="sim8-filter">
      <form className="sim8-form" onSubmit={(event) => void submit(event)}>
        <div className="sim8-grid-2">
          <Field>
            <FieldLabel htmlFor="sim8-filter-app">检测项目</FieldLabel>
            <SearchSelect
              id="sim8-filter-app"
              ariaLabel="检测项目"
              value={appId}
              placeholder={apps.length === 0 ? '没有可用项目' : '选择项目'}
              searchPlaceholder="输入项目名或价格筛选"
              emptyText="没有匹配的项目。"
              options={apps.map((app) => ({
                value: String(app.id),
                label: `${app.name} · ${formatMoney(app.price)}/个`,
              }))}
              onValueChange={setAppId}
              disabled={apps.length === 0}
            />
            {selected === null ? null : (
              <FieldDescription>
                数量范围 {selected.min ?? '—'} – {selected.max ?? '—'}
              </FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="sim8-filter-code">地区代码</FieldLabel>
            <Input
              id="sim8-filter-code"
              placeholder="如 US"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <FieldDescription>
              号码要带国家区号，例如香港 852…、新加坡 65…
            </FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="sim8-filter-numbers">号码列表</FieldLabel>
          <Textarea
            id="sim8-filter-numbers"
            className="sim8-numbers"
            placeholder={'一行一个号码，例如\n14155550100\n14155550101'}
            value={numbers}
            onChange={(event) => setNumbers(event.target.value)}
          />
          <FieldDescription>已识别 {list.length} 个号码。</FieldDescription>
        </Field>

        {error === null ? null : <FieldError role="alert">{error}</FieldError>}

        <div className="sim8-actions">
          <Button type="submit" disabled={busy !== null || selected === null}>
            <ListChecks data-icon="inline-start" />
            {busy === 'create' ? '提交中…' : '提交检测'}
          </Button>
        </div>
      </form>

      <div className="sim8-search">
        <Field>
          <FieldLabel htmlFor="sim8-filter-order">检测订单 ID</FieldLabel>
          <div className="sim8-row">
            <Input
              id="sim8-filter-order"
              placeholder="提交后自动填入"
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void loadDetail()}
            >
              <Search data-icon="inline-start" />
              查详情
            </Button>
          </div>
        </Field>
      </div>

      {detail === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle>检测订单 {detail.orderId}</CardTitle>
            <Badge variant={detail.status === 3 ? 'destructive' : 'outline'}>
              {filterStatusLabel(detail.status)}
            </Badge>
          </CardHeader>
          <CardContent>
            <dl className="sim8-facts">
              <div>
                <dt>项目</dt>
                <dd>{detail.name || '—'}</dd>
              </div>
              <div>
                <dt>地区</dt>
                <dd>
                  {detail.country || '—'}
                  {detail.countryCode === '' ? '' : `（${detail.countryCode}）`}
                </dd>
              </div>
              <div>
                <dt>提交 / 有效</dt>
                <dd>
                  {detail.num ?? '—'} / {detail.valid ?? '—'}
                </dd>
              </div>
              <div>
                <dt>消费</dt>
                <dd>{formatMoney(detail.money)}</dd>
              </div>
              <div>
                <dt>创建</dt>
                <dd>{shortTime(detail.createTime)}</dd>
              </div>
              <div>
                <dt>完成</dt>
                <dd>{shortTime(detail.updateTime)}</dd>
              </div>
            </dl>
            {detail.taskRemark === '' ? null : (
              <p className="sim8-muted">任务说明：{detail.taskRemark}</p>
            )}
            {detail.taskFileUrl === '' ? null : (
              <p className="sim8-muted">
                结果文件：<code className="sim8-mono">{detail.taskFileUrl}</code>
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
