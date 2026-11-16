import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ClipboardList, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { openExternalUrl } from '@/lib/platform/external-url'
import { listOrderWatchItems } from './api'
import type { OrderWardrobePage } from './order-watch-types'

export function AccountWardrobePopover({
  account,
  ready,
}: {
  account: { id: string; account: string; homepageUrl: string }
  ready: boolean
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<OrderWardrobePage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const openRef = useRef(false)
  const accountRef = useRef(account.id)
  const previousAccountId = useRef(account.id)
  accountRef.current = account.id

  useEffect(() => {
    if (ready) return
    generation.current += 1
    openRef.current = false
    // A stopped plugin must close the panel and invalidate in-flight reads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false)
    setLoading(false)
  }, [ready])

  useEffect(() => {
    if (previousAccountId.current === account.id) return
    previousAccountId.current = account.id
    generation.current += 1
    setData(null)
    setError(null)
    setLoading(false)
    if (openRef.current && ready && account.homepageUrl.trim()) void load(1)
    // The keyed window cell normally remounts for a different account.
    // This also handles a reused component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id])

  async function load(page: number) {
    const request = ++generation.current
    const id = account.id
    setLoading(true)
    setError(null)
    try {
      const result = await listOrderWatchItems(id, page)
      if (
        request === generation.current &&
        openRef.current &&
        accountRef.current === id
      ) {
        setData(result)
      }
    } catch {
      if (
        request === generation.current &&
        openRef.current &&
        accountRef.current === id
      ) {
        setError('读取商品快照失败，请检查账号池插件后重试。')
      }
    } finally {
      if (
        request === generation.current &&
        openRef.current &&
        accountRef.current === id
      ) {
        setLoading(false)
      }
    }
  }

  async function openItem(url: string) {
    try {
      await openExternalUrl(url)
    } catch {
      setError('无法打开商品链接，请稍后重试。')
    }
  }

  const hasHomepage = account.homepageUrl.trim() !== ''
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        openRef.current = next
        setOpen(next)
        if (next && ready && hasHomepage) {
          setData(null)
          void load(1)
        } else if (!next) {
          generation.current += 1
          setLoading(false)
          setError(null)
          setData(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`查看 ${account.account} 的商品快照`}
          title="查看衣柜商品快照"
          disabled={!ready}
        >
          <ClipboardList aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="account-compact-popover w-80">
        <PopoverHeader>
          <PopoverTitle>衣柜商品快照</PopoverTitle>
          <span
            className="truncate text-xs text-muted-foreground"
            title={account.account}
          >
            {account.account}
          </span>
        </PopoverHeader>
        {!hasHomepage ? (
          <p className="text-xs text-muted-foreground">
            请先为账号填写 Vinted 用户主页。
          </p>
        ) : (
          <>
            {data ? (
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{data.total} 件 · 最近完整扫描</span>
                <time>
                  {data.lastCompleteAt
                    ? new Date(data.lastCompleteAt).toLocaleString()
                    : '尚未完成'}
                </time>
              </div>
            ) : null}
            {data?.lastError ? (
              <p role="status" className="text-xs text-muted-foreground">
                上次扫描失败：{data.lastError}。显示上次完整快照。
              </p>
            ) : null}
            {loading && !data ? (
              <p
                role="status"
                className="flex items-center gap-1 text-xs text-muted-foreground"
              >
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                正在读取…
              </p>
            ) : null}
            {error ? <FieldError role="alert">{error}</FieldError> : null}
            {data?.total === 0 ? (
              <p className="text-xs text-muted-foreground">
                尚无完整衣柜快照，等待账号池完成扫描。
              </p>
            ) : null}
            {data?.items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 border-t py-1"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium" title={item.title}>
                    {item.title}
                  </p>
                  <p className="text-xs text-muted-foreground">#{item.id}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`打开商品 ${item.title}`}
                  onClick={() => void openItem(item.url)}
                >
                  <ArrowUpRight aria-hidden="true" />
                </Button>
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={loading}
                onClick={() => void load(data?.page ?? 1)}
              >
                <RefreshCw data-icon="inline-start" />
                重新读取
              </Button>
              {data && data.total > data.pageSize ? (
                <div className="flex items-center gap-1 text-xs">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={loading || data.page === 1}
                    onClick={() => void load(data.page - 1)}
                  >
                    上一页
                  </Button>
                  <span>
                    {data.page}/{pages}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={loading || data.page >= pages}
                    onClick={() => void load(data.page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
