import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  DialogModal,
  Input,
  Select,
  Textarea,
  Tooltip,
} from '@proxyshard/shardx-ui-kit'
import {
  MAX_PRODUCT_IMAGES,
  UploadBeginSchema,
  type Product,
  type ProductImage as ImageMetadata,
} from '@nexus/plugin-contracts/products'
import { productApi } from '../../../raccoon/plugins/products/api'
import {
  emptyProductForm,
  productError,
  productFields,
  productForm,
  productSaveInput,
  type ProductForm,
} from '../../../raccoon/plugins/products/form'
import {
  discardProductImages,
  uploadProductBytes,
} from '../../../raccoon/plugins/products/images'
import { statusLabels } from '../../../raccoon/plugins/products/model'
import { ProductImage } from './ProductImage'

const textFields = [
  ['name', 200],
  ['title', 500],
  ['category', 200],
  ['brand', 120],
  ['size', 120],
  ['tags', 1320],
] as const
const conditions = [
  'New with tags',
  'New without tags',
  'Very good',
  'Good',
  'Satisfactory',
]

async function cleanStaged(staged: Set<string>, keep: ReadonlySet<string> = new Set()) {
  const ids = [...staged].filter((id) => !keep.has(id))
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100)
    await discardProductImages(batch)
    for (const id of batch) staged.delete(id)
  }
}

export function ProductEditor({
  product,
  canWrite,
  onClose,
  onSaved,
}: {
  product: Product | null
  canWrite: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(() =>
    product ? productForm(product) : emptyProductForm(),
  )
  const [images, setImages] = useState(() => [...(product?.images ?? [])])
  const [busy, setBusy] = useState<'saving' | 'uploading' | 'discarding' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [createKey] = useState(() => crypto.randomUUID())
  const pending = useRef(new Set<string>())
  const active = useRef<AbortController | null>(null)
  const saving = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const staged = pending.current
    return () => {
      mounted.current = false
      active.current?.abort()
      if (!saving.current && staged.size) void cleanStaged(staged).catch(() => undefined)
    }
  }, [])

  function change<Key extends keyof ProductForm>(key: Key, value: ProductForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function upload(files: File[]) {
    if (!canWrite || !files.length || active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy('uploading')
    setError(null)
    const added: ImageMetadata[] = []
    try {
      if (images.length + files.length > MAX_PRODUCT_IMAGES)
        throw new Error(`每件商品最多 ${MAX_PRODUCT_IMAGES} 张图片。`)
      for (const file of files) {
        if (!UploadBeginSchema.safeParse({ mime: file.type, size: file.size }).success)
          throw new Error(
            `${file.name}：仅支持 PNG、JPEG 和 WebP，单张不得为空或超过 8 MiB。`,
          )
      }
      for (const file of files) {
        controller.signal.throwIfAborted()
        const bytes = new Uint8Array(await file.arrayBuffer())
        const image = await uploadProductBytes(
          { bytes, name: file.name, mime: file.type },
          controller.signal,
        )
        if (!mounted.current) {
          await discardProductImages([image.id]).catch(() => undefined)
          return
        }
        pending.current.add(image.id)
        added.push(image)
        setImages((current) => [...current, image])
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          `${added.length ? `已添加 ${added.length} 张。` : ''}${productError(cause)}`,
        )
    } finally {
      active.current = null
      if (mounted.current) setBusy(null)
    }
  }

  async function close() {
    if (active.current) return
    if (!pending.current.size) {
      onClose()
      return
    }
    const controller = new AbortController()
    active.current = controller
    setBusy('discarding')
    setError(null)
    try {
      await cleanStaged(pending.current)
      if (!controller.signal.aborted) onClose()
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(`未使用图片清理失败：${productError(cause)}`)
    } finally {
      active.current = null
      if (mounted.current) setBusy(null)
    }
  }

  async function save() {
    if (!canWrite || active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy('saving')
    saving.current = true
    setError(null)
    try {
      const identity = product
        ? { id: product.id, expectedRevision: product.revision }
        : { createKey }
      const request = productSaveInput(
        form,
        images.map((image) => image.id),
        identity,
        product?.tags,
      )
      const selectedIds = new Set(request.data.imageIds)
      await cleanStaged(pending.current, selectedIds)
      controller.signal.throwIfAborted()
      const saved = await productApi.save(request)
      const committed = new Set(saved.images.map((image) => image.id))
      for (const id of committed) pending.current.delete(id)
      if (!controller.signal.aborted) onSaved()
    } catch (cause) {
      if (!controller.signal.aborted) setError(productError(cause))
    } finally {
      saving.current = false
      active.current = null
      if (!controller.signal.aborted) setBusy(null)
      else if (pending.current.size)
        void cleanStaged(pending.current).catch(() => undefined)
    }
  }

  function move(from: number, to: number) {
    setImages((current) => {
      const next = [...current]
      const [image] = next.splice(from, 1)
      if (image) next.splice(to, 0, image)
      return next
    })
  }

  const baseline = product ? productForm(product) : emptyProductForm()
  const dirty =
    JSON.stringify(form) !== JSON.stringify(baseline) ||
    images.map((image) => image.id).join() !==
      (product?.images ?? []).map((image) => image.id).join()
  const conditionOptions = [
    '',
    ...conditions,
    ...(form.condition && !conditions.includes(form.condition) ? [form.condition] : []),
  ]
  return (
    <DialogModal
      open
      title={product ? '编辑商品' : '新建商品'}
      size="lg"
      dirty={dirty && !busy}
      isLoading={busy !== null}
      isDisabled={!canWrite}
      confirmLabel="保存商品"
      onConfirm={() => void save()}
      onOpenChange={(open) => {
        if (!open) void close()
      }}
      footerNote={
        !canWrite
          ? '商品存储当前不可写。'
          : busy === 'discarding'
            ? '正在清理未使用图片'
            : undefined
      }
    >
      {busy === 'uploading' && (
        <div className="flex items-center justify-between gap-2 py-2">
          <span role="status" className="text-secondary text-text-sub-600">
            正在上传图片…
          </span>
          <Button
            type="button"
            size="xsmall"
            mode="ghost"
            variant="neutral"
            onClick={() => active.current?.abort()}
          >
            停止上传
          </Button>
        </div>
      )}
      <fieldset
        disabled={busy !== null}
        className="m-0 flex min-w-0 flex-col gap-5 border-0 px-0 py-inset"
      >
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        <section className="flex flex-col gap-3" aria-label="商品资料">
          <div className="grid gap-3 sm:grid-cols-2">
            {textFields.map(([field, maxLength]) => (
              <Input
                key={field}
                inputSize="xsmall"
                label={productFields[field]}
                value={form[field]}
                required={field === 'name'}
                maxLength={maxLength}
                onChange={(event) => change(field, event.target.value)}
              />
            ))}
            <Input
              inputSize="xsmall"
              label="价格"
              type="number"
              step="any"
              min="0"
              value={form.price}
              onChange={(event) => change('price', event.target.value)}
            />
            <Select
              size="xsmall"
              label="币种"
              value={form.currency}
              options={['USD', 'GBP', 'EUR'].map((value) => ({ value, label: value }))}
              onChange={(value) => change('currency', value as ProductForm['currency'])}
            />
            <Select
              size="xsmall"
              label="成色"
              value={form.condition || 'none'}
              options={conditionOptions.map((value) => ({
                value: value || 'none',
                label: value || '未填写',
              }))}
              onChange={(value) => change('condition', value === 'none' ? '' : value)}
            />
            <Select
              size="xsmall"
              label="准备状态"
              value={form.status}
              options={Object.entries(statusLabels).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(value) => change('status', value as ProductForm['status'])}
            />
          </div>
          <Button
            type="button"
            size="xsmall"
            mode="ghost"
            variant="neutral"
            className="self-start"
            onClick={() => change('brand', 'List without brand')}
          >
            标记为无品牌
          </Button>
          <Textarea
            label="英文描述"
            rows={4}
            maxLength={6000}
            value={form.description}
            onChange={(event) => change('description', event.target.value)}
          />
          <Textarea
            label="内部备注"
            rows={2}
            maxLength={2000}
            value={form.note}
            onChange={(event) => change('note', event.target.value)}
          />
        </section>
        <section
          className="flex flex-col gap-3 border-t border-stroke-soft-200 pt-4"
          aria-label="商品图片"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-ui font-medium text-text-strong-950">
              图片 {images.length} / {MAX_PRODUCT_IMAGES}
            </h3>
            <Input
              inputSize="xsmall"
              label="添加图片"
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              disabled={!canWrite || images.length >= MAX_PRODUCT_IMAGES}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                void upload(files)
              }}
            />
          </div>
          <ol className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
            {images.map((image, index) => (
              <li key={image.id} className="flex min-w-0 items-center gap-2">
                <div className="size-16 shrink-0">
                  <ProductImage image={image} />
                </div>
                <div className="min-w-0 flex-1">
                  <Tooltip whenTruncated content={image.name}>
                    <div className="truncate text-secondary text-text-sub-600">
                      {index === 0 ? '主图 · ' : ''}
                      {image.name}
                    </div>
                  </Tooltip>
                  <div className="flex flex-wrap">
                    <Button
                      type="button"
                      size="3xsmall"
                      mode="ghost"
                      variant="neutral"
                      disabled={index === 0}
                      onClick={() => move(index, 0)}
                    >
                      设为主图
                    </Button>
                    <Button
                      type="button"
                      size="3xsmall"
                      mode="ghost"
                      variant="neutral"
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      前移
                    </Button>
                    <Button
                      type="button"
                      size="3xsmall"
                      mode="ghost"
                      variant="neutral"
                      disabled={index === images.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      后移
                    </Button>
                    <Button
                      type="button"
                      size="3xsmall"
                      mode="ghost"
                      variant="error"
                      onClick={() =>
                        setImages((current) =>
                          current.filter((entry) => entry.id !== image.id),
                        )
                      }
                    >
                      移除
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <VintedFacts sites={form.sites} onChange={(value) => change('sites', value)} />
      </fieldset>
    </DialogModal>
  )
}

function VintedFacts({
  sites,
  onChange,
}: {
  sites: ProductForm['sites']
  onChange: (sites: ProductForm['sites']) => void
}) {
  function changeSite(index: number, patch: Partial<ProductForm['sites'][number]>) {
    onChange(
      sites.map((site, position) => (position === index ? { ...site, ...patch } : site)),
    )
  }
  return (
    <details className="border-t border-stroke-soft-200 pt-4">
      <summary className="cursor-pointer text-ui font-medium text-text-strong-950">
        Vinted 站点资料 · {sites.length}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {sites.map((site, index) => (
          <section
            key={index}
            aria-label={`站点 ${index + 1}`}
            className="flex flex-col gap-2 border-b border-stroke-soft-200 pb-3"
          >
            <Input
              inputSize="xsmall"
              label={`站点 ${index + 1} URL`}
              placeholder="https://www.vinted.fr"
              value={site.platformOrigin}
              maxLength={200}
              onChange={(event) =>
                changeSite(index, { platformOrigin: event.target.value })
              }
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                inputSize="xsmall"
                label="分类 ID"
                inputMode="numeric"
                value={site.catalogId}
                onChange={(event) => changeSite(index, { catalogId: event.target.value })}
              />
              <Input
                inputSize="xsmall"
                label="分类版本"
                maxLength={64}
                value={site.catalogRevision}
                onChange={(event) =>
                  changeSite(index, { catalogRevision: event.target.value })
                }
              />
            </div>
            {site.attributes.map((row, position) => (
              <div
                key={position}
                className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
              >
                {(['name', 'value'] as const).map((key) => (
                  <Input
                    key={key}
                    inputSize="xsmall"
                    label={key === 'name' ? '属性名称' : '已确认值'}
                    value={row[key]}
                    maxLength={key === 'name' ? 120 : 200}
                    onChange={(event) =>
                      changeSite(index, {
                        attributes: site.attributes.map((item, rowIndex) =>
                          rowIndex === position
                            ? { ...item, [key]: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                ))}
                <Button
                  type="button"
                  size="xsmall"
                  mode="ghost"
                  variant="error"
                  onClick={() =>
                    changeSite(index, {
                      attributes: site.attributes.filter(
                        (_, rowIndex) => rowIndex !== position,
                      ),
                    })
                  }
                >
                  移除属性
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={site.attributes.length >= 20}
                onClick={() =>
                  changeSite(index, {
                    attributes: [...site.attributes, { name: '', value: '' }],
                  })
                }
              >
                添加属性
              </Button>
              <Button
                type="button"
                size="xsmall"
                mode="ghost"
                variant="error"
                onClick={() =>
                  onChange(sites.filter((_, position) => position !== index))
                }
              >
                移除站点
              </Button>
            </div>
          </section>
        ))}
        <Button
          type="button"
          size="xsmall"
          mode="stroke"
          variant="neutral"
          className="self-start"
          disabled={sites.length >= 24}
          onClick={() =>
            onChange([
              ...sites,
              { platformOrigin: '', catalogId: '', catalogRevision: '', attributes: [] },
            ])
          }
        >
          添加 Vinted 站点
        </Button>
      </div>
    </details>
  )
}
