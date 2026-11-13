import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ImageMimeSchema,
  MAX_IMAGE_BYTES,
  MAX_PRODUCT_IMAGES,
  type Product,
  type ProductImage,
} from '@nexus/plugin-products/contracts'
import { ArrowLeft, ArrowRight, Loader2, Trash2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toast'
import { discardProductImages, getProduct, saveProduct, uploadProductImage } from './api'
import {
  emptyProductForm,
  PRODUCT_STATUS_OPTIONS,
  productError,
  productForm,
  productSaveInput,
  type ProductForm,
} from './product-form'
import { ProductImagePreview } from './product-image'
import {
  ProductPublicationDialog,
  ProductPublicationOverview,
} from './product-publication-history'

export interface ProductEditorProps {
  productId: string | null
  onClose: () => void
  onSaved: (product: Product) => void
}

async function discardUploads(ids: string[]) {
  for (let offset = 0; offset < ids.length; offset += 100) {
    await discardProductImages(ids.slice(offset, offset + 100))
  }
}

export function ProductEditor({ productId, onClose, onSaved }: ProductEditorProps) {
  const [form, setForm] = useState<ProductForm>(emptyProductForm)
  const [product, setProduct] = useState<Product | null>(null)
  const [images, setImages] = useState<ProductImage[]>([])
  const [loaded, setLoaded] = useState(productId === null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [publicationHistoryOpen, setPublicationHistoryOpen] = useState(false)
  const active = useRef(true)
  const operation = useRef<'save' | 'upload' | 'discard' | null>(null)
  const createKey = useRef(crypto.randomUUID())
  const newlyUploaded = useRef(new Map<string, ProductImage>())
  const uploadController = useRef<AbortController | null>(null)
  const uploadTask = useRef<Promise<void> | null>(null)
  const busy = saving || uploading || discarding

  useEffect(() => {
    active.current = true
    const uploads = newlyUploaded.current
    return () => {
      active.current = false
      uploadController.current?.abort()
      if (uploads.size) {
        void discardUploads([...uploads.keys()]).catch((cause: unknown) => {
          toast.error(`未使用图片清理失败：${productError(cause)}`)
        })
      }
    }
  }, [])

  useEffect(() => {
    if (productId === null) return
    let current = true
    void getProduct(productId).then(
      (value) => {
        if (!current) return
        setProduct(value)
        setForm(productForm(value))
        setImages(value.images)
        setLoadError(null)
        setLoaded(true)
      },
      (cause: unknown) => {
        if (current) setLoadError(productError(cause))
      },
    )
    return () => {
      current = false
    }
  }, [productId, loadAttempt])

  function update<K extends keyof ProductForm>(field: K, value: ProductForm[K]) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function close() {
    if (operation.current === 'save' || operation.current === 'discard') return
    uploadController.current?.abort()
    operation.current = 'discard'
    setDiscarding(true)
    setError(null)
    try {
      await uploadTask.current
      const ids = [...newlyUploaded.current.keys()]
      if (ids.length) await discardUploads(ids)
      newlyUploaded.current.clear()
      if (active.current) onClose()
    } catch (cause) {
      if (active.current) {
        setError(`取消未完成，未使用图片清理失败：${productError(cause)}`)
        setDiscarding(false)
      }
    } finally {
      operation.current = null
    }
  }

  async function upload(files: File[]) {
    if (operation.current || !files.length) return
    if (images.length + files.length > MAX_PRODUCT_IMAGES) {
      setError(`每件商品最多 ${String(MAX_PRODUCT_IMAGES)} 张图片，请减少本次选择。`)
      return
    }
    for (const file of files) {
      if (!ImageMimeSchema.safeParse(file.type).success) {
        setError(`${file.name}：仅支持 PNG、JPEG 和 WebP 图片。`)
        return
      }
      if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
        setError(`${file.name}：每张图片须大于 0 且不超过 8 MB。`)
        return
      }
    }
    const controller = new AbortController()
    uploadController.current = controller
    operation.current = 'upload'
    setUploading(true)
    setError(null)
    const task = async () => {
      try {
        for (const file of files) {
          if (controller.signal.aborted) break
          const image = await uploadProductImage(file, controller.signal)
          newlyUploaded.current.set(image.id, image)
          if (!active.current) {
            try {
              await discardUploads([image.id])
              newlyUploaded.current.delete(image.id)
            } catch (cause) {
              toast.error(`未使用图片清理失败：${productError(cause)}`)
            }
            break
          }
          setImages((current) => [...current, image])
        }
      } catch (cause) {
        if (active.current && !controller.signal.aborted) setError(productError(cause))
        else if (!active.current && !controller.signal.aborted)
          toast.error(productError(cause))
      } finally {
        uploadController.current = null
        if (operation.current === 'upload') operation.current = null
        if (active.current) setUploading(false)
      }
    }
    uploadTask.current = task()
    await uploadTask.current
  }

  function moveImage(index: number, nextIndex: number) {
    setImages((current) => {
      const next = [...current]
      const [image] = next.splice(index, 1)
      if (image) next.splice(nextIndex, 0, image)
      return next
    })
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (operation.current || !loaded) return
    operation.current = 'save'
    setSaving(true)
    setError(null)
    try {
      const value = await saveProduct(
        productSaveInput(
          form,
          images.map((image) => image.id),
          product
            ? { id: product.id, expectedRevision: product.revision }
            : { createKey: createKey.current },
          product?.tags,
        ),
      )
      const savedIds = new Set(value.images.map((image) => image.id))
      for (const id of savedIds) newlyUploaded.current.delete(id)
      const unused = [...newlyUploaded.current.keys()]
      try {
        if (unused.length) await discardUploads(unused)
        newlyUploaded.current.clear()
      } catch (cause) {
        toast.error(`商品已保存，但未使用图片清理失败：${productError(cause)}`)
      }
      if (active.current) onSaved(value)
    } catch (cause) {
      if (active.current) setError(productError(cause))
    } finally {
      operation.current = null
      if (active.current) setSaving(false)
    }
  }

  function textField(
    field: Exclude<keyof ProductForm, 'currency' | 'status' | 'description' | 'note'>,
    label: string,
    maxLength: number,
    options: { required?: boolean; placeholder?: string } = {},
  ) {
    return (
      <Field data-disabled={busy || undefined}>
        <FieldLabel htmlFor={`product-${field}`}>{label}</FieldLabel>
        <Input
          id={`product-${field}`}
          value={form[field]}
          maxLength={maxLength}
          required={options.required}
          placeholder={options.placeholder}
          disabled={busy}
          onChange={(event) => update(field, event.target.value)}
        />
      </Field>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close()
      }}
    >
      <DialogContent className="sm:max-w-4xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{productId ? '编辑商品' : '新建商品'}</DialogTitle>
          <DialogDescription>
            草稿只需商品名称，分类选填。待上架需补齐英文标题、描述、成色、价格与图片。
            保存资料不会在外部平台上架。
          </DialogDescription>
        </DialogHeader>
        {loaded && product && (
          <ProductPublicationOverview
            product={product}
            disabled={busy}
            onViewHistory={() => setPublicationHistoryOpen(true)}
          />
        )}
        {!loaded ? (
          <>
            {loadError ? (
              <Alert variant="destructive">
                <AlertTitle>商品读取失败</AlertTitle>
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
            ) : (
              <Skeleton className="h-32 w-full" aria-label="正在读取商品" />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => void close()}>
                关闭
              </Button>
              {loadError && (
                <Button
                  type="button"
                  onClick={() => {
                    setLoadError(null)
                    setLoadAttempt((value) => value + 1)
                  }}
                >
                  重试读取
                </Button>
              )}
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(event) => void save(event)}
            className="flex min-w-0 flex-col gap-4"
          >
            <FieldSet disabled={busy}>
              <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {textField('name', '商品名称（必填）', 200, { required: true })}
                {textField('sku', 'SKU', 80)}
                <Field data-disabled={busy || undefined} className="sm:col-span-2">
                  <FieldLabel htmlFor="product-title">英文上架标题</FieldLabel>
                  <Input
                    id="product-title"
                    value={form.title}
                    maxLength={500}
                    placeholder="English listing title"
                    disabled={busy}
                    onChange={(event) => update('title', event.target.value)}
                  />
                </Field>
                <Field data-disabled={busy || undefined} className="sm:col-span-2">
                  <FieldLabel htmlFor="product-description">英文上架描述</FieldLabel>
                  <Textarea
                    id="product-description"
                    value={form.description}
                    maxLength={6000}
                    rows={4}
                    placeholder="English listing description"
                    disabled={busy}
                    onChange={(event) => update('description', event.target.value)}
                  />
                </Field>
                <Field data-disabled={busy || undefined}>
                  <FieldLabel htmlFor="product-price">价格（可留空）</FieldLabel>
                  <Input
                    id="product-price"
                    type="number"
                    min="0"
                    max="100000000"
                    step="any"
                    value={form.price}
                    disabled={busy}
                    onChange={(event) => update('price', event.target.value)}
                  />
                </Field>
                <Field data-disabled={busy || undefined}>
                  <FieldLabel htmlFor="product-currency">币种</FieldLabel>
                  <LabeledSelect
                    id="product-currency"
                    ariaLabel="商品币种"
                    value={form.currency}
                    options={['USD', 'GBP', 'EUR'].map((value) => ({
                      value,
                      label: value,
                    }))}
                    disabled={busy}
                    className="w-full"
                    onValueChange={(value) => {
                      if (value === 'USD' || value === 'GBP' || value === 'EUR')
                        update('currency', value)
                    }}
                  />
                </Field>
                {textField('category', '分类（选填）', 200)}
                {textField('condition', '成色', 120)}
                {textField('brand', '品牌', 120)}
                {textField('size', '尺码 / 尺寸', 120)}
                {textField('tags', '标签（逗号分隔，最多 20 个）', 1318)}
                <Field data-disabled={busy || undefined}>
                  <FieldLabel htmlFor="product-status">准备状态</FieldLabel>
                  <LabeledSelect
                    id="product-status"
                    ariaLabel="编辑商品状态"
                    value={form.status}
                    options={PRODUCT_STATUS_OPTIONS}
                    disabled={busy}
                    className="w-full"
                    onValueChange={(value) => {
                      if (value === 'draft' || value === 'ready' || value === 'archived')
                        update('status', value)
                    }}
                  />
                </Field>
                <Field data-disabled={busy || undefined} className="sm:col-span-2">
                  <FieldLabel htmlFor="product-note">内部备注</FieldLabel>
                  <Textarea
                    id="product-note"
                    value={form.note}
                    maxLength={2000}
                    rows={2}
                    disabled={busy}
                    onChange={(event) => update('note', event.target.value)}
                  />
                </Field>
                <Field data-disabled={busy || undefined} className="sm:col-span-2">
                  <FieldLabel htmlFor="product-images">商品图片</FieldLabel>
                  <Input
                    id="product-images"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    disabled={busy || images.length >= MAX_PRODUCT_IMAGES}
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? [])
                      event.target.value = ''
                      void upload(files)
                    }}
                  />
                  <FieldDescription>
                    PNG / JPEG / WebP，每张不超过 8 MB，最多 12 张；第一张为主图。
                    移除已保存图片只改变本次商品资料。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </FieldSet>
            {images.length > 0 && (
              <ol
                aria-label="商品图片顺序"
                className="grid grid-cols-2 gap-3 sm:grid-cols-4"
              >
                {images.map((image, index) => (
                  <li key={image.id} className="flex min-w-0 flex-col gap-2">
                    <ProductImagePreview image={image} />
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs" title={image.name}>
                        {image.name}
                      </span>
                      {index === 0 && <Badge variant="secondary">主图</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`前移图片 ${index + 1}`}
                        disabled={busy || index === 0}
                        onClick={() => moveImage(index, index - 1)}
                      >
                        <ArrowLeft />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`后移图片 ${index + 1}`}
                        disabled={busy || index === images.length - 1}
                        onClick={() => moveImage(index, index + 1)}
                      >
                        <ArrowRight />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`移除图片 ${index + 1}`}
                        disabled={busy}
                        onClick={() =>
                          setImages((current) =>
                            current.filter((item) => item.id !== image.id),
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                      {index > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => moveImage(index, 0)}
                        >
                          设为主图
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {uploading && (
              <p role="status" className="text-sm text-muted-foreground">
                正在上传图片…
              </p>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertTitle>商品尚未保存</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving || discarding}
                onClick={() => void close()}
              >
                {discarding ? '正在清理图片…' : '取消'}
              </Button>
              <Button type="submit" disabled={busy}>
                {saving && <Loader2 data-icon="inline-start" className="animate-spin" />}
                {saving ? '保存中…' : '保存商品'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
      {publicationHistoryOpen && product && (
        <ProductPublicationDialog
          key={product.id}
          productId={product.id}
          productName={product.name}
          onClose={() => setPublicationHistoryOpen(false)}
        />
      )}
    </Dialog>
  )
}
