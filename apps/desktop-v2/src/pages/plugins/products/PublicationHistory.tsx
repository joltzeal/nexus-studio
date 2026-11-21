import { useEffect, useState } from 'react'
import { Alert, Button, EmptyState, Modal } from '@proxyshard/shardx-ui-kit'
import type {
  ProductPublicationPage,
  ProductSummary,
} from '@nexus/plugin-contracts/products'
import { openPublication, productApi } from '../../../raccoon/plugins/products/api'
import { productError } from '../../../raccoon/plugins/products/form'
import { productTime } from '../../../raccoon/plugins/products/model'
import { toast } from '../../../shared/model/toast'
import { Pager } from './Pager'
import { AgentHistoryAction } from '../../../raccoon/plugins/AgentHistoryAction'

export function PublicationHistory({
  product,
  onClose,
}: {
  product: ProductSummary
  onClose: () => void
}) {
  const [request, setRequest] = useState<{ page: number; pageSize: 20 | 50 }>({
    page: 1,
    pageSize: 20,
  })
  const [result, setResult] = useState<{
    request: typeof request
    data?: ProductPublicationPage
    error?: string
  } | null>(null)
  const current = result?.request === request ? result : null
  const { id } = product
  useEffect(() => {
    let live = true
    void productApi
      .listPublications({ productId: id, ...request })
      .then((data) => {
        if (live) setResult({ request, data })
      })
      .catch((cause) => {
        if (live) setResult({ request, error: productError(cause) })
      })
    return () => {
      live = false
    }
  }, [id, request])
  return (
    <Modal
      open
      title="发布历史"
      description={product.name}
      size="lg"
      footer={<AgentHistoryAction kind="product" id={product.id} beforeOpen={onClose} />}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <div className="flex flex-col gap-3 py-inset">
        {!current && (
          <p role="status" className="text-secondary text-text-sub-600">
            正在读取发布历史…
          </p>
        )}
        {current?.error && (
          <>
            <Alert status="error" variant="lighter">
              {current.error}
            </Alert>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              className="self-start"
              onClick={() => setRequest({ ...request })}
            >
              重试
            </Button>
          </>
        )}
        {current?.data && (
          <>
            {current.data.items.length === 0 ? (
              <EmptyState title="暂无发布记录" />
            ) : (
              <ol className="m-0 max-h-96 list-none divide-y divide-stroke-soft-200 overflow-auto p-0">
                {current.data.items.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-col gap-1 py-3 text-secondary text-text-sub-600"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="break-all font-medium text-text-strong-950">
                        {entry.platform} · {entry.listingId}
                      </strong>
                      <Button
                        size="xsmall"
                        mode="stroke"
                        variant="neutral"
                        onClick={() =>
                          void openPublication(entry).catch(() =>
                            toast.err('无法打开刊登链接'),
                          )
                        }
                      >
                        打开刊登链接
                      </Button>
                    </div>
                    <span className="break-all">
                      Profile：{entry.windowName} · {entry.windowId}
                    </span>
                    <span>
                      发布于 {productTime(entry.publishedAt)} · 商品修订{' '}
                      {entry.productRevision}
                    </span>
                    <span>记录于 {productTime(entry.recordedAt)}</span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        <Pager
          page={current?.data?.page ?? request.page}
          pageSize={current?.data?.pageSize ?? request.pageSize}
          total={current?.data?.total}
          busy={!current}
          onChange={(page, pageSize) => setRequest({ page, pageSize })}
        />
      </div>
    </Modal>
  )
}
