import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import type { PhotoMetadataForm } from './photo-metadata'

const fields: { key: keyof PhotoMetadataForm; label: string }[] = [
  { key: 'make', label: '制造商' },
  { key: 'model', label: '型号' },
  { key: 'lensModel', label: '镜头型号' },
  { key: 'dateTimeOriginal', label: '拍摄日期和时间' },
  { key: 'aperture', label: '光圈值' },
  { key: 'exposureBias', label: '曝光补偿' },
  { key: 'exposureTime', label: '曝光时间' },
  { key: 'focalLength', label: '焦距' },
  { key: 'xResolution', label: '水平分辨率' },
  { key: 'yResolution', label: '垂直分辨率' },
  { key: 'software', label: '软件' },
  { key: 'modifiedAt', label: '修改日期和时间' },
]

export function PhotoMetadataEditor({
  enabled,
  form,
  disabled,
  onEnabledChange,
  onChange,
}: {
  enabled: boolean
  form: PhotoMetadataForm
  disabled: boolean
  onEnabledChange: (enabled: boolean) => void
  onChange: (form: PhotoMetadataForm) => void
}) {
  function select<K extends keyof PhotoMetadataForm>(
    key: K,
    value: PhotoMetadataForm[K],
  ) {
    onChange({ ...form, [key]: value })
  }
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="ai-photo-metadata">EXIF 后置处理</FieldLabel>
        <LabeledSelect
          id="ai-photo-metadata"
          ariaLabel="EXIF 后置处理"
          disabled={disabled}
          value={enabled ? 'custom' : 'none'}
          options={[
            { value: 'none', label: '不写入模板' },
            { value: 'custom', label: '自定义相机模板' },
          ]}
          onValueChange={(value) => onEnabledChange(value === 'custom')}
        />
        <FieldDescription>
          启用后生成结果和新上传的参考图转为 JPEG，写入下面的模板；新图片命名为
          IMG_####。修改模板不会重写已经上传的参考图。
        </FieldDescription>
      </Field>
      {enabled ? (
        <details className="rounded-md border border-border p-3" open>
          <summary className="cursor-pointer text-sm font-medium">编辑相机信息</summary>
          <p className="mt-2 text-xs text-muted-foreground">
            这些值由你提供，不会验证实际拍摄设备；日期格式 YYYY:MM:DD HH:mm:ss。
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fields.map(({ key, label }) => (
              <Field key={key}>
                <FieldLabel htmlFor={`ai-exif-${key}`}>{label}</FieldLabel>
                <Input
                  id={`ai-exif-${key}`}
                  disabled={disabled}
                  value={form[key]}
                  maxLength={160}
                  onChange={(event) => select(key, event.target.value as never)}
                />
              </Field>
            ))}
            <Field>
              <FieldLabel htmlFor="ai-exif-exposure-mode">曝光模式</FieldLabel>
              <LabeledSelect
                id="ai-exif-exposure-mode"
                ariaLabel="曝光模式"
                disabled={disabled}
                value={form.exposureMode}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'manual', label: 'Manual' },
                ]}
                onValueChange={(value) =>
                  select('exposureMode', value as PhotoMetadataForm['exposureMode'])
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ai-exif-exposure-program">曝光程序</FieldLabel>
              <LabeledSelect
                id="ai-exif-exposure-program"
                ariaLabel="曝光程序"
                disabled={disabled}
                value={form.exposureProgram}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'manual', label: 'Manual' },
                ]}
                onValueChange={(value) =>
                  select('exposureProgram', value as PhotoMetadataForm['exposureProgram'])
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ai-exif-metering">测光模式</FieldLabel>
              <LabeledSelect
                id="ai-exif-metering"
                ariaLabel="测光模式"
                disabled={disabled}
                value={form.meteringMode}
                options={[
                  { value: 'multi-segment', label: 'Multi-segment' },
                  { value: 'center-weighted', label: 'Center-weighted' },
                  { value: 'spot', label: 'Spot' },
                ]}
                onValueChange={(value) =>
                  select('meteringMode', value as PhotoMetadataForm['meteringMode'])
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ai-exif-flash">闪光灯状态</FieldLabel>
              <LabeledSelect
                id="ai-exif-flash"
                ariaLabel="闪光灯状态"
                disabled={disabled}
                value={form.flash}
                options={[
                  { value: 'no', label: 'No' },
                  { value: 'no-compulsory', label: 'No, compulsory' },
                  { value: 'yes', label: 'Yes' },
                ]}
                onValueChange={(value) =>
                  select('flash', value as PhotoMetadataForm['flash'])
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ai-exif-white-balance">白平衡</FieldLabel>
              <LabeledSelect
                id="ai-exif-white-balance"
                ariaLabel="白平衡"
                disabled={disabled}
                value={form.whiteBalance}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'manual', label: 'Manual' },
                ]}
                onValueChange={(value) =>
                  select('whiteBalance', value as PhotoMetadataForm['whiteBalance'])
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ai-exif-resolution-unit">分辨率单位</FieldLabel>
              <LabeledSelect
                id="ai-exif-resolution-unit"
                ariaLabel="分辨率单位"
                disabled={disabled}
                value={form.resolutionUnit}
                options={[
                  { value: 'inch', label: 'inch' },
                  { value: 'cm', label: 'cm' },
                ]}
                onValueChange={(value) =>
                  select('resolutionUnit', value as PhotoMetadataForm['resolutionUnit'])
                }
              />
            </Field>
            <Field>
              <FieldLabel>图像方向</FieldLabel>
              <Input value="top, left (1)" disabled readOnly />
            </Field>
          </div>
        </details>
      ) : null}
    </FieldGroup>
  )
}
