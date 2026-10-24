import { useEffect, useMemo, useState } from 'react'
import { Loader2, Search, Smartphone } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { listPlugins, pluginHostAvailable } from '@/lib/platform/native-plugins'
import { listRecords } from './api'
import {
  canonicalPhone,
  indexAccountPhones,
  listAccountTargets,
  type AccountTarget,
} from './accounts-bridge'
import {
  SIM8_PLUGIN_ID,
  message,
  recordExpired,
  shortTime,
  type SmsRecord,
} from './types'

/** What a form borrows from the pool: the number and the link that reads it. */
export interface PickedNumber {
  tel: string
  api: string
}

type AccountLookup =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; items: AccountTarget[] }

export function NumberPoolOptions({
  records,
  accounts,
  currentAccountId,
  onPick,
  disabled = false,
}: {
  records: SmsRecord[]
  accounts: AccountLookup
  currentAccountId?: string | undefined
  onPick: (number: PickedNumber) => void
  disabled?: boolean
}) {
  const usage = useMemo(
    () => indexAccountPhones(accounts.state === 'ready' ? accounts.items : []),
    [accounts],
  )

  return (
    <>
      {accounts.state === 'ready' ? null : (
        <p className="sim8-hint" role="status">
          {accounts.state === 'loading'
            ? '正在查询账号占用…'
            : '无法读取 Vinted 账号，号码占用情况未知；仍可选择号码。'}
        </p>
      )}
      {records.length === 0 ? null : (
        <div className="sim8-pick-list" role="listbox" aria-label="已购号码">
          {records.map((record) => {
            const owners = usage.get(canonicalPhone(record.tel)) ?? []
            const current = owners.some((owner) => owner.id === currentAccountId)
            const others = owners.filter((owner) => owner.id !== currentAccountId)
            return (
              <button
                key={record.tel}
                type="button"
                role="option"
                aria-selected={current}
                className="sim8-pick-row"
                disabled={disabled || record.api === ''}
                title={record.api === '' ? '这个号码没有接码链接' : '使用号码与接码链接'}
                onClick={() => onPick({ tel: record.tel, api: record.api })}
              >
                <span className="sim8-tel">
                  <strong>{record.tel}</strong>
                  {current ? <Badge variant="secondary">当前账号</Badge> : null}
                  {recordExpired(record) ? <Badge variant="outline">已过期</Badge> : null}
                </span>
                <small>
                  {record.api === ''
                    ? '没有接码链接'
                    : `${record.remark || '已购'} · 到期 ${shortTime(record.endTime)}`}
                </small>
                {others.length > 0 ? (
                  <span className="sim8-number-usage" data-used="true">
                    其他账号已使用：{others.map((owner) => owner.account).join('、')}
                  </span>
                ) : accounts.state === 'ready' && !current ? (
                  <span className="sim8-number-usage">暂无账号使用</span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

/**
 * The purchased numbers, as a list a form can pick from.
 *
 * The pool is read over RPC every time this mounts, so a number bought a minute
 * ago is already here; a popover unmounts its content when it closes, which
 * makes "mount" and "open" the same moment. A number without a record link is
 * listed but not selectable — it could fill a phone field but nothing could
 * read its codes afterwards.
 */
export function NumberPoolList({
  onPick,
  disabled = false,
  currentAccountId,
}: {
  onPick: (number: PickedNumber) => void
  disabled?: boolean
  currentAccountId?: string | undefined
}) {
  const [query, setQuery] = useState('')
  const [records, setRecords] = useState<SmsRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<AccountLookup>({ state: 'loading' })

  useEffect(() => {
    let active = true

    async function load() {
      if (!pluginHostAvailable()) {
        if (active) {
          setError('读取号码池需要桌面应用。')
          setLoading(false)
        }
        return
      }
      try {
        const catalog = await listPlugins()
        const entry = catalog.find((item) => item.id === SIM8_PLUGIN_ID) ?? null
        if (entry === null || entry.state === 'available') {
          if (active) setError('SIM8 接码插件还没安装。')
          return
        }
        if (entry.state !== 'running') {
          if (active) setError('SIM8 接码插件正在启动，稍后再试。')
          return
        }
        // Account lookup must not hide usable numbers when that plugin is down.
        void listAccountTargets().then(
          (items) => {
            if (active) setAccounts({ state: 'ready', items })
          },
          () => {
            if (active) setAccounts({ state: 'unavailable' })
          },
        )
        const list = await listRecords()
        if (active) setRecords(list.items)
      } catch (cause) {
        if (active) setError(message(cause))
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [])

  const needle = query.trim().toLowerCase()
  const visible =
    needle === ''
      ? records
      : records.filter((record) =>
          `${record.tel} ${record.remark} ${record.ordernum}`
            .toLowerCase()
            .includes(needle),
        )

  return (
    <div className="sim8-pick">
      <div className="search-field">
        <Search aria-hidden="true" />
        <Input
          aria-label="搜索号码池"
          placeholder="搜索号码或备注"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {loading ? (
        <p className="sim8-hint">
          <Loader2 className="animate-spin" aria-hidden="true" /> 正在读取号码池…
        </p>
      ) : null}
      {error === null ? null : <p className="sim8-hint">{error}</p>}
      {!loading && error === null && visible.length === 0 ? (
        <p className="sim8-hint">
          {records.length === 0
            ? '号码池是空的，先到「SIM8 接码 → 买号」买一个。'
            : '没有匹配的号码。'}
        </p>
      ) : null}
      {!loading && error === null ? (
        <NumberPoolOptions
          records={visible}
          accounts={accounts}
          currentAccountId={currentAccountId}
          disabled={disabled}
          onPick={onPick}
        />
      ) : null}
    </div>
  )
}

/** The same list behind a button, for forms that have no room for it inline. */
export function NumberPoolPicker({
  onPick,
  disabled = false,
  label = '号码池',
  ariaLabel = '从号码池选择号码',
  size = 'xs',
  variant = 'outline',
  currentAccountId,
}: {
  onPick: (number: PickedNumber) => void
  disabled?: boolean
  label?: string
  ariaLabel?: string
  size?: 'xs' | 'sm' | 'icon-xs'
  variant?: 'outline' | 'ghost' | 'secondary'
  currentAccountId?: string | undefined
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size={size}
          variant={variant}
          aria-label={ariaLabel}
          title={ariaLabel}
          disabled={disabled}
        >
          <Smartphone data-icon="inline-start" />
          {size === 'icon-xs' ? null : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="sim8-picker account-compact-popover">
        <PopoverHeader>
          <PopoverTitle>从号码池选</PopoverTitle>
        </PopoverHeader>
        <NumberPoolList
          disabled={disabled}
          currentAccountId={currentAccountId}
          onPick={(number) => {
            onPick(number)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
