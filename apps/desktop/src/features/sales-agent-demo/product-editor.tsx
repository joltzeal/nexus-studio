import { useState, type FormEvent } from 'react'
import { Check, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  categoryOptions,
  conditionOptions,
  currencyOptions,
  type DemoProduct,
  type ListingFields,
} from './demo-data'
import { updateProduct } from './demo-state'

type SharedField = 'price' | 'currency' | 'category' | 'condition' | 'brand' | 'size'
const sharedFields: { key: SharedField; label: string }[] = [
  { key: 'price', label: '价格' },
  { key: 'currency', label: '币种' },
  { key: 'category', label: '分类' },
  { key: 'condition', label: '成色' },
  { key: 'brand', label: '品牌' },
  { key: 'size', label: '尺码 / 尺寸' },
]

export function ProductEditor({
  products,
  onSave,
  onClose,
}: {
  products: DemoProduct[]
  onSave: (products: DemoProduct[]) => void
  onClose: () => void
}) {
  const [items, setItems] = useState(() => products.map((product) => ({ ...product })))
  const [enabled, setEnabled] = useState<SharedField[]>(['condition'])
  const [common, setCommon] = useState<ListingFields>({
    title: '',
    description: '',
    price: '',
    currency: 'USD',
    category: categoryOptions[0]!.value,
    condition: conditionOptions[0]!.value,
    brand: '',
    size: '',
  })
  const [tab, setTab] = useState('individual')
  const [error, setError] = useState('')
  const [applied, setApplied] = useState(false)

  function patchItem(id: string, patch: Partial<ListingFields>) {
    setItems((current) =>
      current.map((product) =>
        product.id === id ? updateProduct(product, patch) : product,
      ),
    )
    setError('')
  }

  function applyCommon() {
    if (enabled.includes('price') && common.price && Number(common.price) <= 0) {
      setError('价格需大于 0。')
      return
    }
    const patch = Object.fromEntries(enabled.map((key) => [key, common[key]]))
    setItems((current) => current.map((product) => updateProduct(product, patch)))
    setApplied(true)
    setError('')
    setTab('individual')
  }

  function save(event: FormEvent) {
    event.preventDefault()
    const invalid = items.find(
      (product) =>
        product.price &&
        (!Number.isFinite(Number(product.price)) || Number(product.price) <= 0),
    )
    if (invalid) {
      setError(`「${invalid.label}」的价格需大于 0。`)
      return
    }
    onSave(items)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="agent-editor">
        <DialogHeader>
          <DialogTitle>
            {products.length > 1 ? `批量编辑 ${products.length} 件商品` : '编辑商品资料'}
          </DialogTitle>
          <DialogDescription>
            运行前确认商品资料。标题与描述使用英文，空缺字段可以继续保留在草稿中。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="agent-editor-form">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList aria-label="商品编辑方式">
              <TabsTrigger value="individual">逐件资料</TabsTrigger>
              <TabsTrigger value="common">
                <SlidersHorizontal />
                统一修改
              </TabsTrigger>
            </TabsList>
            <TabsContent value="individual" className="agent-editor-body">
              {applied ? (
                <p className="agent-inline-success" role="status">
                  <Check aria-hidden="true" />
                  统一字段已应用，请确认后保存。
                </p>
              ) : null}
              <Table aria-label="批量商品资料">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">商品</TableHead>
                    <TableHead>标题与描述 · English</TableHead>
                    <TableHead className="w-36">价格与币种</TableHead>
                    <TableHead className="w-44">分类与成色</TableHead>
                    <TableHead className="w-36">品牌与尺寸</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((product) => (
                    <TableRow key={product.id} className="align-top">
                      <TableCell className="whitespace-normal">
                        <strong className="text-xs font-medium">{product.label}</strong>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {product.imageCount} 张图片
                        </p>
                      </TableCell>
                      <TableCell>
                        <FieldGroup className="min-w-64 gap-2">
                          <Field>
                            <FieldLabel
                              htmlFor={`title-${product.id}`}
                              className="sr-only"
                            >
                              {product.label}标题
                            </FieldLabel>
                            <Input
                              id={`title-${product.id}`}
                              value={product.title}
                              placeholder="English title"
                              onChange={(event) =>
                                patchItem(product.id, { title: event.target.value })
                              }
                            />
                          </Field>
                          <Field>
                            <FieldLabel
                              htmlFor={`description-${product.id}`}
                              className="sr-only"
                            >
                              {product.label}描述
                            </FieldLabel>
                            <Textarea
                              id={`description-${product.id}`}
                              value={product.description}
                              placeholder="Describe the item in everyday English..."
                              rows={3}
                              onChange={(event) =>
                                patchItem(product.id, { description: event.target.value })
                              }
                            />
                          </Field>
                        </FieldGroup>
                      </TableCell>
                      <TableCell>
                        <FieldGroup className="gap-2">
                          <Field>
                            <FieldLabel
                              htmlFor={`price-${product.id}`}
                              className="sr-only"
                            >
                              {product.label}价格
                            </FieldLabel>
                            <Input
                              id={`price-${product.id}`}
                              type="number"
                              min="0.01"
                              step="0.01"
                              value={product.price}
                              placeholder="价格"
                              onChange={(event) =>
                                patchItem(product.id, { price: event.target.value })
                              }
                            />
                          </Field>
                          <LabeledSelect
                            ariaLabel={`${product.label}币种`}
                            value={product.currency}
                            options={currencyOptions}
                            onValueChange={(currency) =>
                              patchItem(product.id, { currency })
                            }
                            className="w-full"
                          />
                        </FieldGroup>
                      </TableCell>
                      <TableCell>
                        <FieldGroup className="gap-2">
                          <LabeledSelect
                            ariaLabel={`${product.label}分类`}
                            value={product.category || 'unset'}
                            options={[
                              { value: 'unset', label: '未设置分类（选填）' },
                              ...categoryOptions,
                            ]}
                            onValueChange={(category) =>
                              patchItem(product.id, {
                                category: category === 'unset' ? '' : category,
                              })
                            }
                            className="w-full"
                          />
                          <LabeledSelect
                            ariaLabel={`${product.label}成色`}
                            value={product.condition || 'unset'}
                            options={[
                              { value: 'unset', label: '待补全成色' },
                              ...conditionOptions,
                            ]}
                            onValueChange={(condition) =>
                              patchItem(product.id, {
                                condition: condition === 'unset' ? '' : condition,
                              })
                            }
                            className="w-full"
                          />
                        </FieldGroup>
                      </TableCell>
                      <TableCell>
                        <FieldGroup className="gap-2">
                          {(['brand', 'size'] as const).map((key) => (
                            <Field key={key}>
                              <FieldLabel
                                htmlFor={`${key}-${product.id}`}
                                className="sr-only"
                              >
                                {product.label}
                                {key === 'brand' ? '品牌' : '尺寸'}
                              </FieldLabel>
                              <Input
                                id={`${key}-${product.id}`}
                                value={product[key]}
                                placeholder={key === 'brand' ? '品牌' : '尺码 / 尺寸'}
                                onChange={(event) =>
                                  patchItem(product.id, { [key]: event.target.value })
                                }
                              />
                            </Field>
                          ))}
                        </FieldGroup>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="common" className="agent-common-editor">
              <p className="text-xs text-muted-foreground">
                只修改勾选的字段，其他资料保持各商品原值。留空会清除该字段。
              </p>
              <FieldGroup className="agent-form-grid">
                {sharedFields.map(({ key, label }) => {
                  const checked = enabled.includes(key)
                  const options =
                    key === 'currency'
                      ? currencyOptions
                      : key === 'category'
                        ? categoryOptions
                        : key === 'condition'
                          ? conditionOptions
                          : null
                  return (
                    <Field key={key} data-disabled={!checked}>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`apply-${key}`}
                          checked={checked}
                          onCheckedChange={(value) =>
                            setEnabled((current) =>
                              value === true
                                ? [...current, key]
                                : current.filter((field) => field !== key),
                            )
                          }
                        />
                        <FieldLabel htmlFor={`apply-${key}`}>{label}</FieldLabel>
                      </div>
                      {options ? (
                        <LabeledSelect
                          ariaLabel={`统一${label}`}
                          value={common[key]}
                          options={options}
                          disabled={!checked}
                          className="w-full"
                          onValueChange={(value) =>
                            setCommon((current) => ({ ...current, [key]: value }))
                          }
                        />
                      ) : (
                        <Input
                          aria-label={`统一${label}`}
                          value={common[key]}
                          disabled={!checked}
                          type={key === 'price' ? 'number' : 'text'}
                          {...(key === 'price' ? { min: '0.01', step: '0.01' } : {})}
                          onChange={(event) =>
                            setCommon((current) => ({
                              ...current,
                              [key]: event.target.value,
                            }))
                          }
                        />
                      )}
                    </Field>
                  )
                })}
              </FieldGroup>
              <Button
                type="button"
                variant="outline"
                disabled={!enabled.length}
                onClick={applyCommon}
              >
                应用到这 {items.length} 件商品
              </Button>
            </TabsContent>
          </Tabs>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit">保存 {items.length} 件商品资料</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
