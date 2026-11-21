import { useState } from 'react'
import { Button, IconButton, Modal } from '@proxyshard/shardx-ui-kit'
import { CopyIcon, DeleteIcon, StarOutlineIcon } from '../../../shared/icons'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'
import {
  supplyProductText,
  supplyPublishedText,
  type SupplyFavorite,
  type SupplyProduct,
} from '../../../raccoon/plugins/shared-supply/model'
import { SupplyImageSession } from '../../../raccoon/plugins/shared-supply/image-session'
import { ProductImage } from './ProductGrid'

export function ProductDetail({
  product,
  favorite,
  session,
  imagesAvailable,
  favoritesAvailable,
  onClose,
  onFavorite,
  onRemove,
}: {
  product: SupplyProduct | null
  favorite: SupplyFavorite | null
  session: SupplyImageSession | null
  imagesAvailable: boolean
  favoritesAvailable: boolean
  onClose: () => void
  onFavorite: (product: SupplyProduct) => void
  onRemove: (favorite: SupplyFavorite) => void
}) {
  const [imageIndex, setImageIndex] = useState(0)
  const shown = favorite ?? product
  if (shown === null) return null
  const title = shown.title.trim() || '未命名商品'
  const copy = async (text: string, label: string) => {
    try {
      await clip.write(text)
      toast.ok(`已复制${label}`)
    } catch {
      toast.err('复制失败，请检查剪贴板权限后重试')
    }
  }
  return (
    <Modal
      open
      title={title}
      description="商品详情与可用图片"
      size="lg"
      onOpenChange={(open) => {
        if (!open) {
          setImageIndex(0)
          onClose()
        }
      }}
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1.1fr)_minmax(240px,.9fr)]">
        <div className="flex flex-col gap-2">
          <div className="aspect-square overflow-hidden rounded-surface bg-bg-weak-50">
            {imagesAvailable && shown.images[imageIndex] ? (
              <ProductImage
                url={shown.images[imageIndex]}
                session={session}
                alt={title}
              />
            ) : (
              <span className="flex size-full items-center justify-center text-secondary text-text-soft-400">
                没有可用图片
              </span>
            )}
          </div>
          {shown.images.length > 1 && (
            <div className="flex gap-2 overflow-auto">
              {shown.images.map((url, index) => (
                <IconButton
                  key={url}
                  label={`查看商品图片 ${index + 1}`}
                  icon={
                    imagesAvailable ? (
                      <ProductImage
                        url={url}
                        session={session}
                        alt={`${title} ${index + 1}`}
                      />
                    ) : undefined
                  }
                  aria-pressed={index === imageIndex}
                  onClick={() => setImageIndex(index)}
                  className="size-[56px] overflow-hidden rounded-control bg-bg-weak-50 p-0"
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <p className="m-0 text-section-title text-text-strong-950">
            ¥ {shown.price || '—'}
          </p>
          <p className="m-0 whitespace-pre-wrap text-body text-text-sub-600">
            {shown.description || '暂无描述'}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-secondary text-text-sub-600">
            <dt>发布时间</dt>
            <dd>{supplyPublishedText(shown)}</dd>
            <dt>商户标识</dt>
            <dd className="break-all">{shown.merchantId || '未提供'}</dd>
            <dt>图片数量</dt>
            <dd>{shown.images.length}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            {favoritesAvailable &&
              (favorite ? (
                <Button
                  variant="neutral"
                  mode="stroke"
                  size="xsmall"
                  leftIcon={<DeleteIcon className="size-3.5" />}
                  onClick={() => onRemove(favorite)}
                >
                  取消收藏
                </Button>
              ) : (
                <Button
                  size="xsmall"
                  leftIcon={<StarOutlineIcon className="size-3.5" />}
                  onClick={() => onFavorite(shown)}
                >
                  收藏商品
                </Button>
              ))}
            <Button
              variant="neutral"
              mode="stroke"
              size="xsmall"
              leftIcon={<CopyIcon className="size-3.5" />}
              onClick={() => void copy(shown.title, '标题')}
            >
              复制标题
            </Button>
            <Button
              variant="neutral"
              mode="stroke"
              size="xsmall"
              leftIcon={<CopyIcon className="size-3.5" />}
              onClick={() => void copy(supplyProductText(shown), '商品资料')}
            >
              复制资料
            </Button>
            <Button
              variant="neutral"
              mode="stroke"
              size="xsmall"
              disabled={shown.images.length === 0}
              leftIcon={<CopyIcon className="size-3.5" />}
              onClick={() => void copy(shown.images.join('\n'), '图片链接')}
            >
              复制图片链接
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export { ProductImage }
