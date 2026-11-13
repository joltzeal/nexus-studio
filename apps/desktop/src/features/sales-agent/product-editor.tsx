import { useState } from 'react'
import type { AgentProductOverride } from '@nexus/plugin-sdk/agent'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { AgentProductCover } from './product-cover'
import {
  effectiveProduct,
  parseProductEdits,
  type AgentDraft,
  type ProductEditKey as EditKey,
  type ProductEditValues as EditValues,
} from './assignment'

const FIELDS = [
  { key: 'title', label: '英文标题', max: 500 },
  { key: 'description', label: '英文描述', max: 6000 },
  { key: 'price', label: '价格', max: 32 },
  { key: 'currency', label: '币种', max: 3 },
  { key: 'condition', label: '成色', max: 120 },
  { key: 'brand', label: '品牌（选填）', max: 120 },
  { key: 'size', label: '尺寸（选填）', max: 120 },
  { key: 'category', label: '分类（选填）', max: 200 },
] as const
const BLANK: EditValues = {
  title: '',
  description: '',
  price: '',
  currency: 'USD',
  condition: '',
  brand: '',
  size: '',
  category: '',
}

function EditFields({
  prefix,
  values,
  onChange,
  enabled,
  onEnabled,
}: {
  prefix: string
  values: EditValues
  onChange: (key: EditKey, value: string) => void
  enabled?: ReadonlySet<EditKey>
  onEnabled?: (key: EditKey, checked: boolean) => void
}) {
  return (
    <FieldGroup className="sales-agent-form-grid">
      {FIELDS.map((field) => (
        <Field
          key={field.key}
          className={field.key === 'description' ? 'sales-agent-field-wide' : undefined}
          data-disabled={enabled && !enabled.has(field.key)}
        >
          <div className="sales-agent-inline">
            {onEnabled ? (
              <Checkbox
                checked={enabled?.has(field.key)}
                aria-label={`统一修改${field.label}`}
                onCheckedChange={(checked) => onEnabled(field.key, checked === true)}
              />
            ) : null}
            <FieldLabel htmlFor={`${prefix}-${field.key}`}>{field.label}</FieldLabel>
          </div>
          {field.key === 'description' ? (
            <Textarea
              id={`${prefix}-${field.key}`}
              value={values[field.key]}
              maxLength={field.max}
              disabled={enabled !== undefined && !enabled.has(field.key)}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          ) : field.key === 'currency' ? (
            <LabeledSelect
              id={`${prefix}-${field.key}`}
              ariaLabel="币种"
              value={values.currency}
              disabled={enabled !== undefined && !enabled.has(field.key)}
              options={['USD', 'GBP', 'EUR'].map((value) => ({ value, label: value }))}
              onValueChange={(value) => onChange(field.key, value)}
            />
          ) : (
            <Input
              id={`${prefix}-${field.key}`}
              value={values[field.key]}
              maxLength={field.max}
              inputMode={field.key === 'price' ? 'decimal' : undefined}
              disabled={enabled && !enabled.has(field.key)}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          )}
        </Field>
      ))}
    </FieldGroup>
  )
}

export function BatchProductEditor({
  draft,
  ids,
  onSave,
  onClose,
}: {
  draft: AgentDraft
  ids: readonly string[]
  onSave: (overrides: Record<string, AgentProductOverride>) => void
  onClose: () => void
}) {
  const products = draft.products.filter((product) => ids.includes(product.id))
  const [values, setValues] = useState<Record<string, EditValues>>(() =>
    Object.fromEntries(
      products.map((product) => {
        const current = effectiveProduct(draft, product)
        return [
          product.id,
          {
            title: current.title,
            description: current.description,
            price: current.price === null ? '' : String(current.price),
            currency: current.currency,
            condition: current.condition,
            brand: current.brand,
            size: current.size,
            category: current.category,
          },
        ]
      }),
    ),
  )
  const [common, setCommon] = useState<EditValues>(BLANK)
  const [enabled, setEnabled] = useState<Set<EditKey>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  function apply() {
    setValues((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([id, row]) => [
          id,
          {
            ...row,
            ...Object.fromEntries([...enabled].map((key) => [key, common[key]])),
          },
        ]),
      ),
    )
    setError(null)
  }

  function save() {
    try {
      const overrides = Object.fromEntries(
        products.map((product) => [
          product.id,
          parseProductEdits(product.id, values[product.id]!),
        ]),
      )
      onSave(overrides)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '商品编辑资料无效。')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sales-agent-dialog">
        <DialogHeader>
          <DialogTitle>本批次商品资料 · {products.length} 件</DialogTitle>
          <DialogDescription>
            修改用于本批次快照，保存到此表单后再创建任务。商品库资料仍由商品管理维护。
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="individual">
          <TabsList>
            <TabsTrigger value="individual">逐件资料</TabsTrigger>
            <TabsTrigger value="common">统一修改</TabsTrigger>
          </TabsList>
          <TabsContent value="individual" className="sales-agent-editor-list">
            {products.map((product) => (
              <section key={product.id} className="sales-agent-edit-product">
                <div className="sales-agent-inline">
                  {product.images[0] ? (
                    <AgentProductCover image={product.images[0]} />
                  ) : null}
                  <strong>{product.name}</strong>
                </div>
                <EditFields
                  prefix={product.id}
                  values={values[product.id]!}
                  onChange={(key, value) =>
                    setValues((previous) => ({
                      ...previous,
                      [product.id]: { ...previous[product.id]!, [key]: value },
                    }))
                  }
                />
              </section>
            ))}
          </TabsContent>
          <TabsContent value="common" className="sales-agent-edit-product">
            <p className="text-muted-foreground">
              只应用勾选字段；应用后可回到逐件资料核对，再保存本次编辑。
            </p>
            <EditFields
              prefix="common"
              values={common}
              enabled={enabled}
              onEnabled={(key, checked) =>
                setEnabled((previous) => {
                  const next = new Set(previous)
                  if (checked) next.add(key)
                  else next.delete(key)
                  return next
                })
              }
              onChange={(key, value) =>
                setCommon((previous) => ({ ...previous, [key]: value }))
              }
            />
            <Button variant="outline" disabled={!enabled.size} onClick={apply}>
              应用到 {products.length} 件商品
            </Button>
          </TabsContent>
        </Tabs>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save}>保存本批次编辑</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
