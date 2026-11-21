import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, DialogModal, Tooltip } from '@proxyshard/shardx-ui-kit'
import { MAX_PRODUCT_IMAGES } from '@nexus/plugin-contracts/products'
import { listRecords } from '../../../raccoon/plugins/ai-image/api'
import {
  importGenerationProduct,
  type AiProductImportProgress,
} from '../../../raccoon/plugins/ai-image/product-import'
import type { RecordPage } from '../../../raccoon/plugins/ai-image/types'
import { productError } from '../../../raccoon/plugins/products/form'
import { productTime } from '../../../raccoon/plugins/products/model'
import { Pager } from './Pager'
import { PluginFilterRow, PluginSearch } from '../PluginFilterRow'

const MAX_BATCH = 20

export function AiImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [request, setRequest] = useState<{
    page: number
    pageSize: 20 | 50
    query: string
  }>({ page: 1, pageSize: 20, query: '' })
  const [result, setResult] = useState<{
    request: typeof request
    data?: RecordPage
    error?: string
  } | null>(null)
  const [selected, setSelected] = useState(() => new Map<string, string>())
  const [results, setResults] = useState<
    { id: string; name: string; message: string; failure?: boolean }[]
  >([])
  const [progress, setProgress] = useState<{
    record: number
    total: number
    detail?: AiProductImportProgress
  } | null>(null)
  const mounted = useRef(false)
  const active = useRef<AbortController | null>(null)
  const current = result?.request === request ? result : null
  useEffect(() => {
    let live = true
    const timer = window.setTimeout(() => {
      void listRecords(request.page - 1, request.pageSize, undefined, undefined, {
        query: request.query,
      })
        .then((data) => {
          if (!live) return
          const lastPage = Math.max(1, Math.ceil(data.total / request.pageSize))
          if (lastPage < request.page) setRequest({ ...request, page: lastPage })
          else setResult({ request, data })
        })
        .catch((cause) => {
          if (live) setResult({ request, error: productError(cause) })
        })
    }, 180)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [request])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      active.current?.abort()
    }
  }, [])

  async function importSelected() {
    if (active.current || !selected.size) return
    const controller = new AbortController()
    active.current = controller
    const batch = [...selected]
    setResults([])
    try {
      for (const [index, [id, name]] of batch.entries()) {
        if (controller.signal.aborted) break
        const record = index + 1
        setProgress({ record, total: batch.length })
        try {
          const saved = await importGenerationProduct(id, {
            signal: controller.signal,
            onProgress: (detail) => {
              if (!controller.signal.aborted)
                setProgress({ record, total: batch.length, detail })
            },
          })
          if (mounted.current) {
            setResults((current) => [
              ...current,
              {
                id,
                name,
                message: saved.alreadyImported ? '已存在，未覆盖' : '已导入草稿',
              },
            ])
            setSelected((current) => {
              const next = new Map(current)
              next.delete(id)
              return next
            })
            onImported()
          }
        } catch (cause) {
          if (!controller.signal.aborted)
            setResults((current) => [
              ...current,
              { id, name, message: productError(cause), failure: true },
            ])
        }
      }
    } finally {
      active.current = null
      if (mounted.current) setProgress(null)
    }
  }

  return (
    <DialogModal
      open
      size="lg"
      title="从 AI 生图导入"
      confirmLabel={`导入 ${selected.size} 条记录`}
      isLoading={progress !== null}
      isDisabled={!selected.size}
      onConfirm={() => void importSelected()}
      onOpenChange={(open) => {
        if (!open && !active.current) onClose()
      }}
    >
      <div className="flex flex-col gap-3 py-inset">
        <PluginFilterRow label="生图记录筛选">
          <PluginSearch
            label="搜索生图记录"
            maxLength={200}
            value={request.query}
            disabled={progress !== null}
            onChange={(event) =>
              setRequest({ ...request, page: 1, query: event.target.value })
            }
          />
          <Button
            type="button"
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={!current || progress !== null}
            onClick={() => setRequest({ ...request })}
          >
            刷新记录
          </Button>
        </PluginFilterRow>
        {!current && (
          <p role="status" className="text-secondary text-text-sub-600">
            正在读取生图记录…
          </p>
        )}
        {current?.error && (
          <Alert status="error" variant="lighter">
            {current.error}
          </Alert>
        )}
        {current?.data && (
          <>
            <ul className="m-0 max-h-64 list-none divide-y divide-stroke-soft-200 overflow-auto p-0">
              {current.data.items.map((record) => {
                const name = record.title?.trim() || productTime(record.createdAt)
                const blocked =
                  record.status === 'running' ||
                  record.outputVision?.status === 'running' ||
                  !record.outputs.length ||
                  record.outputs.length > MAX_PRODUCT_IMAGES
                return (
                  <li key={record.id} className="flex items-center gap-3 py-2">
                    <Checkbox
                      aria-label={`选择 ${name}`}
                      checked={selected.has(record.id)}
                      disabled={
                        progress !== null ||
                        (!selected.has(record.id) &&
                          (blocked || selected.size >= MAX_BATCH))
                      }
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Map(current)
                          if (checked === true) next.set(record.id, name)
                          else next.delete(record.id)
                          return next
                        })
                      }
                    />
                    <Tooltip whenTruncated content={name}>
                      <span className="min-w-0 flex-1 truncate text-ui text-text-strong-950">
                        {name}
                      </span>
                    </Tooltip>
                    <span className="shrink-0 text-secondary text-text-sub-600">
                      {blocked ? '暂不可导入' : `${record.outputs.length} 张成片`}
                    </span>
                  </li>
                )
              })}
            </ul>
            {!current.data.items.length && (
              <p className="text-secondary text-text-sub-600">没有匹配的生图记录。</p>
            )}
          </>
        )}
        <Pager
          page={current?.data ? current.data.page + 1 : request.page}
          pageSize={request.pageSize}
          total={current?.data?.total}
          busy={progress !== null || !current}
          onChange={(page, pageSize) => setRequest({ ...request, page, pageSize })}
        />
        {selected.size > 0 && (
          <div className="flex items-center gap-2 text-secondary text-text-sub-600">
            <span>
              已选 {selected.size} / {MAX_BATCH} 条，可跨页选择
            </span>
            <Button
              type="button"
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={progress !== null}
              onClick={() => setSelected(new Map())}
            >
              清空选择
            </Button>
          </div>
        )}
        {progress && (
          <div className="flex flex-wrap items-center gap-2 text-secondary text-text-sub-600">
            <p role="status" className="m-0">
              正在导入第 {progress.record} / {progress.total} 条
              {progress.detail?.stage === 'copying'
                ? ` · 已复制 ${progress.detail.completed} / ${progress.detail.total} 张`
                : ''}
            </p>
            <Button
              type="button"
              size="xsmall"
              mode="ghost"
              variant="neutral"
              onClick={() => active.current?.abort()}
            >
              停止导入
            </Button>
          </div>
        )}
        {results.length > 0 && (
          <ul
            aria-label="导入结果"
            aria-live="polite"
            className="m-0 max-h-32 overflow-auto ps-5 text-secondary"
          >
            {results.map((entry) => (
              <li
                key={entry.id}
                className={entry.failure ? 'text-error-text' : 'text-text-sub-600'}
              >
                {entry.name}：{entry.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogModal>
  )
}
