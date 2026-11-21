import { Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { ProductVintedFactsForm } from './product-form'

export interface ProductPlatformFactsEditorProps {
  value: ProductVintedFactsForm[]
  onChange: (value: ProductVintedFactsForm[]) => void
  disabled: boolean
}

export function ProductPlatformFactsEditor({
  value,
  onChange,
  disabled,
}: ProductPlatformFactsEditorProps) {
  function update(index: number, change: Partial<ProductVintedFactsForm>) {
    onChange(value.map((entry, at) => (at === index ? { ...entry, ...change } : entry)))
  }

  return (
    <details className="min-w-0 border-t pt-3" open={value.length > 0}>
      <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-ring">
        Vinted 站点资料（选填）
      </summary>
      <div className="mt-3 flex min-w-0 flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          仅填写已确认的手动资料，各站点独立保存。上传后优先使用网页分类；
          手动分类只在网页未分类时兜底，留空不影响待上架。
        </p>
        {value.map((entry, index) => {
          const prefix = `product-vinted-${index}`
          return (
            <FieldSet key={index} disabled={disabled} className="min-w-0 gap-3">
              <FieldLegend variant="label">站点 {index + 1}</FieldLegend>
              <div className="flex min-w-0 items-end gap-2">
                <Field data-disabled={disabled || undefined} className="min-w-0">
                  <FieldLabel htmlFor={`${prefix}-origin`}>Vinted 站点</FieldLabel>
                  <Input
                    id={`${prefix}-origin`}
                    type="url"
                    value={entry.platformOrigin}
                    maxLength={200}
                    placeholder="https://www.vinted.com"
                    disabled={disabled}
                    aria-describedby={`${prefix}-origin-help`}
                    onChange={(event) =>
                      update(index, { platformOrigin: event.target.value })
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`移除 Vinted 站点 ${index + 1}`}
                  disabled={disabled}
                  onClick={() => onChange(value.filter((_, at) => at !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
              <FieldDescription id={`${prefix}-origin-help`}>
                填写完整 HTTPS 站点，不含路径或末尾斜线；不会套用到其他站点。
              </FieldDescription>
              <FieldGroup className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field data-disabled={disabled || undefined}>
                  <FieldLabel htmlFor={`${prefix}-catalog-id`}>
                    手动分类 ID（选填）
                  </FieldLabel>
                  <Input
                    id={`${prefix}-catalog-id`}
                    inputMode="numeric"
                    value={entry.catalogId}
                    maxLength={16}
                    placeholder="正整数，留空由网页分类"
                    disabled={disabled}
                    onChange={(event) =>
                      update(index, {
                        catalogId: event.target.value,
                        catalogRevision: '',
                      })
                    }
                  />
                </Field>
                <Field data-disabled={disabled || undefined}>
                  <FieldLabel htmlFor={`${prefix}-catalog-revision`}>
                    分类目录版本（选填）
                  </FieldLabel>
                  <Input
                    id={`${prefix}-catalog-revision`}
                    value={entry.catalogRevision}
                    maxLength={64}
                    placeholder="已知的 SHA-256 版本，或留空核对"
                    disabled={disabled}
                    onChange={(event) =>
                      update(index, { catalogRevision: event.target.value })
                    }
                  />
                </Field>
              </FieldGroup>
              {entry.attributes.map((attribute, at) => {
                const attributePrefix = `${prefix}-attribute-${at}`
                const change = (field: 'name' | 'value', next: string) =>
                  update(index, {
                    attributes: entry.attributes.map((row, rowIndex) =>
                      rowIndex === at ? { ...row, [field]: next } : row,
                    ),
                  })
                return (
                  <div key={at} className="flex min-w-0 items-end gap-2">
                    <FieldGroup className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                      <Field data-disabled={disabled || undefined}>
                        <FieldLabel htmlFor={`${attributePrefix}-name`}>
                          页面属性名称
                        </FieldLabel>
                        <Input
                          id={`${attributePrefix}-name`}
                          value={attribute.name}
                          maxLength={120}
                          disabled={disabled}
                          onChange={(event) => change('name', event.target.value)}
                        />
                      </Field>
                      <Field data-disabled={disabled || undefined}>
                        <FieldLabel htmlFor={`${attributePrefix}-value`}>
                          已确认值
                        </FieldLabel>
                        <Input
                          id={`${attributePrefix}-value`}
                          value={attribute.value}
                          maxLength={200}
                          disabled={disabled}
                          onChange={(event) => change('value', event.target.value)}
                        />
                      </Field>
                    </FieldGroup>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`移除站点 ${index + 1} 的属性 ${at + 1}`}
                      disabled={disabled}
                      onClick={() =>
                        update(index, {
                          attributes: entry.attributes.filter(
                            (_, rowIndex) => rowIndex !== at,
                          ),
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )
              })}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || entry.attributes.length >= 20}
                  onClick={() =>
                    update(index, {
                      attributes: [...entry.attributes, { name: '', value: '' }],
                    })
                  }
                >
                  添加已确认属性
                </Button>
              </div>
            </FieldSet>
          )
        })}
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || value.length >= 24}
            onClick={() =>
              onChange([
                ...value,
                {
                  platformOrigin: '',
                  catalogId: '',
                  catalogRevision: '',
                  attributes: [],
                },
              ])
            }
          >
            添加 Vinted 站点
          </Button>
        </div>
      </div>
    </details>
  )
}
