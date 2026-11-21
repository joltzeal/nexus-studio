import { useAgentRequestScope } from './scope'
import { useState } from 'react'
import type { Product, ProductSummary } from '@nexus/plugin-contracts/products'
import { ChevronLeft, ChevronRight, RefreshCw } from './icons'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
} from './controls'

import { Checkbox, Tooltip, Input } from '@proxyshard/shardx-ui-kit'

import { listProducts } from './dependencies'
import { agentError, readPickedProducts } from './api'
import { useAgentQuery } from './use-query'
import { AgentProductCover } from './product-cover'
import { productAddedTime, productPublicationCountLabel } from './product-picker-metadata'

export function ProductPicker({
  existingIds,
  onAdd,
  onClose,
}: {
  existingIds: readonly string[]
  onAdd: (products: Product[]) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<Map<string, ProductSummary>>(() => new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scope = useAgentRequestScope()
  const key = JSON.stringify([query, page, attempt])
  const list = useAgentQuery(key, () =>
    listProducts({
      query,
      page,
      pageSize: 20,
    }),
  )
  const data = list.data
  const currentPage = data?.page ?? page
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 20))
  const existing = new Set(existingIds)

  async function add() {
    if (busy || !selected.size) return
    setBusy(true)
    setError(null)
    const current = scope.begin()
    try {
      const products = await readPickedProducts([...selected.keys()])
      if (!current()) return
      if (products.some((product) => product.status === 'archived'))
        throw new Error('所选商品已归档，请刷新商品库重新选择。')
      onAdd(products)
      onClose()
    } catch (cause) {
      if (current()) setError(agentError(cause))
    } finally {
      if (current()) setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sales-agent-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>从商品库选择</DialogTitle>
          <DialogDescription>
            每件商品包含整组图片；曾发布的商品可分配给其他账号，同账号重复发布会被拦截。最多
            100 件。
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-help [&>*]:shrink-0">
          <Input
            inputSize="xsmall"
            aria-label="搜索商品库"
            placeholder="搜索商品名称或标题"
            value={query}
            maxLength={200}
            disabled={busy}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(1)
            }}
          />
          <Button
            variant="outline"
            disabled={busy || list.loading}
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw data-icon="inline-start" />
            刷新
          </Button>
        </div>
        {list.error || error ? (
          <Alert variant="destructive">
            <AlertDescription>{error ?? list.error}</AlertDescription>
          </Alert>
        ) : null}
        <div
          className="max-h-[min(480px,55svh)] overflow-auto overscroll-contain"
          aria-busy={list.loading}
        >
          {list.loading ? <Skeleton className="h-24 w-full" /> : null}
          {data?.items.map((product) => {
            const unavailable = existing.has(product.id) || product.status === 'archived'
            const addedAt = productAddedTime(product.createdAt)
            return (
              <div
                key={product.id}
                className="flex min-w-0 items-center gap-2 border-b border-stroke-soft-200 p-2 text-help aria-selected:bg-bg-weak-50 [&[draggable=true]]:cursor-grab"
              >
                <Checkbox
                  checked={existing.has(product.id) || selected.has(product.id)}
                  disabled={
                    busy ||
                    unavailable ||
                    (!selected.has(product.id) && existing.size + selected.size >= 100)
                  }
                  aria-label={`选择商品 ${product.name}`}
                  onCheckedChange={(checked) =>
                    setSelected((previous) => {
                      const next = new Map(previous)
                      if (checked === true && existing.size + next.size < 100)
                        next.set(product.id, product)
                      else next.delete(product.id)
                      return next
                    })
                  }
                />
                {product.cover ? (
                  <AgentProductCover image={product.cover} />
                ) : (
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-control bg-bg-weak-50 text-micro text-text-soft-400">
                    无图
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere [&>span]:text-help [&>span]:text-text-sub-600">
                  <strong>{product.name}</strong>
                  <span>{product.title || '尚未填写标题'}</span>
                </span>
                <div className="ml-auto flex shrink-0 flex-col gap-1 text-right text-text-sub-600">
                  <span>
                    添加时间{' '}
                    {addedAt.dateTime ? (
                      <Tooltip content={addedAt.title}>
                        <time dateTime={addedAt.dateTime} tabIndex={0}>
                          {addedAt.label}
                        </time>
                      </Tooltip>
                    ) : (
                      addedAt.label
                    )}
                  </span>
                  <span>
                    上架次数 {productPublicationCountLabel(product.publicationCount)}
                  </span>
                </div>
                {unavailable ? (
                  <Badge variant="outline">
                    {existing.has(product.id) ? '已选入' : '已归档'}
                  </Badge>
                ) : null}
              </div>
            )
          })}
          {data?.items.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>没有可选商品</EmptyTitle>
                <EmptyDescription>
                  请先在商品管理创建商品，或调整搜索条件。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
        </div>
        {data?.storageDurable === false ? (
          <Alert variant="destructive">
            <AlertDescription>商品库未启用持久存储，不能创建上架批次。</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 overflow-x-auto border-t border-stroke-soft-200 py-2 text-help tabular-nums [&>*]:shrink-0">
          <span>
            已选 {selected.size} 件 · 共 {data?.total ?? '…'} 件 · 第 {currentPage} /{' '}
            {pages} 页
          </span>
          <Button
            variant="ghost"
            disabled={busy || !selected.size}
            onClick={() => setSelected(new Map())}
          >
            清空勾选
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="上一页商品库"
            disabled={busy || list.loading || currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="下一页商品库"
            disabled={busy || list.loading || currentPage >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              busy || !selected.size || data?.storageDurable !== true || !!list.error
            }
            onClick={() => {
              void add()
            }}
          >
            {busy ? '读取商品…' : `加入 ${selected.size} 件商品`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
