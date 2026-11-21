import { Switch } from '@proxyshard/shardx-ui-kit'
import type { PhotoMetadataForm } from '../../../raccoon/plugins/ai-image/photo-metadata'
import { AiInput, AiSelect } from './fields'

const TEXT_FIELDS = [
  ['make', '制造商'],
  ['model', '相机型号'],
  ['lensModel', '镜头型号'],
  ['dateTimeOriginal', '拍摄时间'],
  ['modifiedAt', '修改时间'],
  ['aperture', '光圈'],
  ['exposureBias', '曝光补偿'],
  ['exposureTime', '曝光时间'],
  ['focalLength', '焦距'],
  ['xResolution', '水平分辨率'],
  ['yResolution', '垂直分辨率'],
  ['software', '软件版本'],
] as const
const SELECT_FIELDS = [
  {
    key: 'exposureMode',
    label: '曝光模式',
    options: [
      { value: 'auto', label: '自动' },
      { value: 'manual', label: '手动' },
    ],
  },
  {
    key: 'exposureProgram',
    label: '曝光程序',
    options: [
      { value: 'auto', label: '自动' },
      { value: 'manual', label: '手动' },
    ],
  },
  {
    key: 'meteringMode',
    label: '测光模式',
    options: [
      { value: 'multi-segment', label: '多区' },
      { value: 'center-weighted', label: '中央重点' },
      { value: 'spot', label: '点测光' },
    ],
  },
  {
    key: 'flash',
    label: '闪光灯',
    options: [
      { value: 'no', label: '未闪光' },
      { value: 'no-compulsory', label: '强制关闭' },
      { value: 'yes', label: '已闪光' },
    ],
  },
  {
    key: 'whiteBalance',
    label: '白平衡',
    options: [
      { value: 'auto', label: '自动' },
      { value: 'manual', label: '手动' },
    ],
  },
  {
    key: 'resolutionUnit',
    label: '分辨率单位',
    options: [
      { value: 'inch', label: '英寸' },
      { value: 'cm', label: '厘米' },
    ],
  },
] as const

export function PhotoMetadataEditor({
  enabled,
  form,
  disabled,
  supported = true,
  onEnabled,
  onChange,
}: {
  enabled: boolean
  form: PhotoMetadataForm
  disabled: boolean
  supported?: boolean
  onEnabled: (enabled: boolean) => void
  onChange: (form: PhotoMetadataForm) => void
}) {
  function choice(key: (typeof SELECT_FIELDS)[number]['key'], value: string) {
    const field = SELECT_FIELDS.find((field) => field.key === key)
    if (!field?.options.some((option) => option.value === value)) return
    onChange({ ...form, [key]: value })
  }
  return (
    <div className="flex flex-col gap-3">
      <Switch
        label="自定义相机模板"
        checked={enabled}
        disabled={disabled || (!supported && !enabled)}
        onChange={onEnabled}
      />
      {enabled && (
        <>
          <p className="m-0 text-secondary text-text-sub-600">
            模板仅写入用户提供的元数据，不证明真实拍摄设备。不写
            GPS；方向固定为左上。更改模板不会重写已上传图片，需要一致时请重新上传。
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TEXT_FIELDS.map(([key, label]) => (
              <AiInput
                key={key}
                label={label}
                value={form[key]}
                disabled={disabled}
                onChange={(event) => onChange({ ...form, [key]: event.target.value })}
              />
            ))}
            {SELECT_FIELDS.map((field) => (
              <AiSelect
                key={field.key}
                label={field.label}
                value={form[field.key]}
                disabled={disabled}
                options={[...field.options]}
                onChange={(value) => choice(field.key, value)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
