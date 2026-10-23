import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { InstalledKernel, KernelSelection } from '@/lib/platform/native-kernels'
import { canPinBrowserVersion, type LicenseStatus } from '@/lib/platform/native-license'

export function WindowKernelPicker({
  value,
  onChange,
  license,
  installed,
  loading,
  error,
  disabled,
}: {
  value: KernelSelection
  onChange: (value: KernelSelection) => void
  license: LicenseStatus | null
  installed: InstalledKernel[]
  loading: boolean
  error: string | null
  disabled: boolean
}) {
  const baseKernels = installed.filter((kernel) => kernel.kind === 'base')
  const latestKernel = installed.find((kernel) => kernel.kind === 'latest')
  const canPinLatest = license !== null && canPinBrowserVersion(license)

  return (
    <FieldGroup>
      <Field data-disabled={disabled}>
        <FieldLabel id="window-kernel-label">浏览器内核</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={value.kind}
          disabled={disabled}
          aria-labelledby="window-kernel-label"
          onValueChange={(kind) => {
            if (kind === 'base' || kind === 'latest') onChange({ kind })
          }}
        >
          <ToggleGroupItem value="base">基础内核</ToggleGroupItem>
          <ToggleGroupItem value="latest" disabled={!license?.configured}>
            最新内核
          </ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription>
          {value.kind === 'base'
            ? '无需激活码。创建后内核固定，保存激活码不会更换此窗口的内核。'
            : license?.plan?.toLowerCase() === 'free'
              ? '使用当前可用的最新内核。免费计划同时最多打开一个新版内核窗口。'
              : '使用激活码对应的最新内核，创建后版本固定。'}
          {!license?.configured ? ' 最新内核需先在设置中填写激活码。' : ''}
        </FieldDescription>
      </Field>
      {value.kind === 'base' ? (
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor="window-base-version">指定基础版本（可选）</FieldLabel>
          <Input
            id="window-base-version"
            inputMode="numeric"
            autoComplete="off"
            disabled={disabled}
            placeholder="留空使用当前系统默认版本"
            value={value.version ?? ''}
            onChange={(event) => onChange({ kind: 'base', version: event.target.value })}
          />
          <FieldDescription>
            {loading
              ? '正在读取本地版本；也可直接填写完整版本或使用默认基础版本。'
              : error
                ? '本地版本暂时无法读取，仍可填写版本；留空即可使用默认基础版本。'
                : baseKernels.length > 0
                  ? `已下载：${baseKernels.map((kernel) => kernel.version).join('、')}。留空按当前系统提供，缺少时自动下载。`
                  : '填写完整版本号可固定基础内核；留空按当前系统提供，缺少时自动下载。'}
          </FieldDescription>
        </Field>
      ) : canPinLatest ? (
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor="window-browser-version">指定新版版本（可选）</FieldLabel>
          <Input
            id="window-browser-version"
            inputMode="numeric"
            autoComplete="off"
            disabled={disabled}
            placeholder="留空使用最新内核"
            value={value.version ?? ''}
            onChange={(event) =>
              onChange({ kind: 'latest', version: event.target.value })
            }
          />
          <FieldDescription>填写完整版本号，例如 155.0.1.2。</FieldDescription>
        </Field>
      ) : latestKernel ? (
        <FieldDescription>
          本机已下载 Chromium {latestKernel.version}，实际版本在创建时确定。
        </FieldDescription>
      ) : null}
    </FieldGroup>
  )
}
