import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Hash, KeyRound, RefreshCw, ShoppingCart, Timer, UserPlus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { SearchSelect } from '@/components/ui/search-select'
import { toast } from '@/components/ui/toast'
import type { AccountTarget } from './accounts-bridge'
import { buyDeferred, buyNumbers, listApps, listCategories, listPrefixes } from './api'
import {
  APP_TYPES,
  EXPIRY_OPTIONS,
  allocationLabel,
  formatMoney,
  message,
  shortTime,
  type AllocationState,
  type AppItem,
  type CategoryItem,
  type PrefixReport,
  type PurchaseResult,
  type SmsRecord,
} from './types'

export interface BuyPanelProps {
  accounts: AccountTarget[]
  onPurchased: () => Promise<void>
  onRead: (record: SmsRecord) => void
  onLink: (record: SmsRecord) => void
}

/**
 * One form, two ways to buy: `create` hands the numbers back immediately,
 * `deferred` queues the order and allocates later. Both end in the same list, so
 * the page does not need two different result panels.
 */
export function BuyPanel({ accounts, onPurchased, onRead, onLink }: BuyPanelProps) {
  const [categories, setCategories] = useState<CategoryItem[]>([])
  const [cateId, setCateId] = useState('2')
  const [type, setType] = useState('1')
  const [apps, setApps] = useState<AppItem[]>([])
  const [appId, setAppId] = useState('')
  const [expiry, setExpiry] = useState('0')
  const [num, setNum] = useState('1')
  const [prefix, setPrefix] = useState('')
  const [excludePrefix, setExcludePrefix] = useState('')
  const [prefixes, setPrefixes] = useState<PrefixReport | null>(null)
  const [result, setResult] = useState<PurchaseResult | null>(null)
  const [deferred, setDeferred] = useState<AllocationState | null>(null)
  const [busy, setBusy] = useState<'apps' | 'buy' | 'deferred' | 'prefix' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The selection survives a category switch when the project is still listed;
  // otherwise it falls back to the first one.
  const applyApps = useCallback((items: AppItem[]) => {
    setApps(items)
    setAppId((current) =>
      items.some((app) => String(app.id) === current)
        ? current
        : String(items[0]?.id ?? ''),
    )
    setError(null)
  }, [])

  useEffect(() => {
    let active = true
    void listCategories().then(
      (catalog) => {
        if (active) setCategories(catalog.items)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [])

  // The project list follows the category and the card type. Every switch
  // lands here, so the spinner belongs to the explicit refresh below instead
  // of flashing on each fetch.
  useEffect(() => {
    let active = true
    void listApps({ cateId: Number(cateId), type: Number(type) }).then(
      (catalog) => {
        if (active) applyApps(catalog.items)
      },
      (cause: unknown) => {
        if (!active) return
        setApps([])
        setAppId('')
        setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [cateId, type, applyApps])

  async function refreshApps() {
    setBusy('apps')
    try {
      applyApps((await listApps({ cateId: Number(cateId), type: Number(type) })).items)
    } catch (cause) {
      setApps([])
      setAppId('')
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  const selected = apps.find((app) => String(app.id) === appId) ?? null
  const count = Number(num)
  const validCount = Number.isInteger(count) && count >= 1 && count <= 50_000

  async function showPrefixes() {
    if (selected === null) return
    setBusy('prefix')
    try {
      setPrefixes(
        await listPrefixes({
          appId: selected.id,
          type: Number(type),
          expiry: Number(expiry),
        }),
      )
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  function input() {
    return {
      appId: selected?.id ?? 0,
      num: count,
      type: Number(type),
      expiry: Number(expiry),
      ...(prefix.trim() === '' ? {} : { prefix: prefix.trim() }),
      ...(excludePrefix.trim() === '' ? {} : { excludePrefix: excludePrefix.trim() }),
    }
  }

  async function submit(event: FormEvent, mode: 'buy' | 'deferred') {
    event.preventDefault()
    if (selected === null) {
      setError('先选择一个项目。')
      return
    }
    if (!validCount) {
      setError('数量要是 1 到 50000 之间的整数。')
      return
    }
    setBusy(mode)
    setError(null)
    setDeferred(null)
    try {
      if (mode === 'buy') {
        const purchased = await buyNumbers(input())
        setResult(purchased)
        toast.success(
          purchased.total === 0
            ? '订单已创建，但接口没有返回号码'
            : `已买到 ${String(purchased.total)} 个号码`,
        )
      } else {
        setResult(null)
        setDeferred(await buyDeferred(input()))
        toast.success('已提交后分配订单')
      }
      await onPurchased()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="sim8-buy">
      <form
        className="sim8-form sim8-buy-form"
        onSubmit={(event) => void submit(event, 'buy')}
      >
        <div className="sim8-grid-2">
          <Field>
            <FieldLabel htmlFor="sim8-cate">分类</FieldLabel>
            <LabeledSelect
              id="sim8-cate"
              ariaLabel="项目分类"
              value={cateId}
              options={categories.map((entry) => ({
                value: String(entry.id),
                label: entry.name,
              }))}
              onValueChange={setCateId}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sim8-type">卡类型</FieldLabel>
            <LabeledSelect
              id="sim8-type"
              ariaLabel="卡类型"
              value={type}
              options={APP_TYPES.map((entry) => ({
                value: entry.value,
                label: entry.label,
              }))}
              onValueChange={setType}
            />
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="sim8-app">项目</FieldLabel>
          <div className="sim8-row">
            <SearchSelect
              id="sim8-app"
              ariaLabel="项目"
              value={appId}
              placeholder={apps.length === 0 ? '没有可用项目' : '选择项目'}
              searchPlaceholder="输入项目名或价格筛选"
              emptyText="没有匹配的项目。"
              options={apps.map((app) => ({
                value: String(app.id),
                label: `${app.name} · ${formatMoney(app.price)}${
                  app.stock === null ? '' : ` · 库存 ${String(app.stock)}`
                }`,
              }))}
              onValueChange={setAppId}
              disabled={apps.length === 0}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="刷新项目列表"
              disabled={busy !== null}
              onClick={() => void refreshApps()}
            >
              <RefreshCw className={busy === 'apps' ? 'animate-spin' : undefined} />
            </Button>
          </div>
          {selected === null ? (
            <FieldDescription>这个分类下没有可用项目。</FieldDescription>
          ) : (
            <FieldDescription>
              单价 {formatMoney(selected.price)}
              {selected.stock === null ? '' : ` · 剩余 ${String(selected.stock)} 个`}
            </FieldDescription>
          )}
        </Field>

        <div className="sim8-grid-2">
          <Field>
            <FieldLabel htmlFor="sim8-expiry">有效期</FieldLabel>
            <LabeledSelect
              id="sim8-expiry"
              ariaLabel="有效期"
              value={expiry}
              options={EXPIRY_OPTIONS.map((entry) => ({
                value: entry.value,
                label: entry.label,
              }))}
              onValueChange={setExpiry}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sim8-num">数量</FieldLabel>
            <Input
              id="sim8-num"
              inputMode="numeric"
              value={num}
              onChange={(event) => setNum(event.target.value)}
            />
            <FieldDescription>
              本机最多保留 2000 个号码的记录，超出部分仍可在订单里查到。
            </FieldDescription>
          </Field>
        </div>

        <div className="sim8-grid-2">
          <Field>
            <FieldLabel htmlFor="sim8-prefix">指定前缀</FieldLabel>
            <Input
              id="sim8-prefix"
              placeholder="如 1415,1416"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sim8-exclude">排除前缀</FieldLabel>
            <Input
              id="sim8-exclude"
              placeholder="如 1417"
              value={excludePrefix}
              onChange={(event) => setExcludePrefix(event.target.value)}
            />
          </Field>
        </div>

        {error === null ? null : <FieldError role="alert">{error}</FieldError>}

        <div className="sim8-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={busy !== null || selected === null}
            onClick={() => void showPrefixes()}
          >
            <Hash data-icon="inline-start" />
            {busy === 'prefix' ? '查询中…' : '查看可用前缀'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || selected === null}
            onClick={(event) => void submit(event, 'deferred')}
          >
            <Timer data-icon="inline-start" />
            {busy === 'deferred' ? '提交中…' : '后分配下单'}
          </Button>
          <Button type="submit" disabled={busy !== null || selected === null}>
            <ShoppingCart data-icon="inline-start" />
            {busy === 'buy'
              ? '购买中…'
              : `购买${selected === null ? '' : ` · ${formatMoney(selected.price * (validCount ? count : 0))}`}`}
          </Button>
        </div>
      </form>

      {prefixes === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle>可用前缀</CardTitle>
            <Badge variant="secondary">{prefixes.num} 个号源</Badge>
          </CardHeader>
          <CardContent>
            <div className="sim8-prefix-list">
              {prefixes.items.length === 0 ? (
                <p className="sim8-muted">这个项目当前没有可选前缀。</p>
              ) : (
                prefixes.items.slice(0, 60).map((item) => (
                  <button
                    key={item.prefix}
                    type="button"
                    className="sim8-prefix"
                    onClick={() => setPrefix(item.prefix)}
                    title="点一下填进指定前缀"
                  >
                    {item.prefix}
                    <span>{item.num}</span>
                  </button>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {deferred === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle>后分配订单</CardTitle>
            <Badge variant="outline">{allocationLabel(deferred.allocationStatus)}</Badge>
          </CardHeader>
          <CardContent>
            <p className="sim8-muted">
              订单 {deferred.ordernum} · 申请 {deferred.requestedNum ?? '—'} · 已分配{' '}
              {deferred.allocatedNum ?? '—'}
              {deferred.expireAt === ''
                ? ''
                : ` · 排队到期 ${shortTime(deferred.expireAt)}`}
            </p>
            <p className="sim8-muted">
              号码分配完成后到「订单」页按订单号同步即可拿到接码链接。
            </p>
          </CardContent>
        </Card>
      )}

      {result === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle>刚买到的号码</CardTitle>
            <Badge variant="secondary">{result.total} 个</Badge>
            <code className="sim8-mono">{result.ordernum}</code>
          </CardHeader>
          <CardContent>
            {result.records.length === 0 ? (
              <p className="sim8-muted">
                接口没有返回号码。可以到「订单」页按订单号 {result.ordernum} 再同步一次。
              </p>
            ) : (
              <ul className="sim8-result-list">
                {result.records.map((record) => (
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
            {result.truncated ? (
              <p className="sim8-hint">这里只列出前 200 个，其余号码已存进「号码池」。</p>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
