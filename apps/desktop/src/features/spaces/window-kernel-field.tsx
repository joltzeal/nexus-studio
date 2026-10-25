import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  getKernelStatus,
  isKernelVersion,
  KernelOperationError,
  type InstalledKernel,
} from '@/lib/platform/native-kernels'

export function WindowKernelField({
  value,
  disabled,
  onChange,
}: {
  value: string | null
  disabled: boolean
  onChange: (version: string | null) => void
}) {
  const [installed, setInstalled] = useState<InstalledKernel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refresh = useRef<() => void>(() => {})

  useEffect(() => {
    let active = true
    let reading = false
    function read() {
      if (!active || reading) return
      reading = true
      setLoading(true)
      setError(null)
      void getKernelStatus(true)
        .then(
          (status) => {
            if (active) setInstalled(status.installed)
          },
          (cause: unknown) => {
            if (active) {
              setError(
                cause instanceof KernelOperationError
                  ? cause.message
                  : '无法读取已安装内核，请重试。',
              )
            }
          },
        )
        .finally(() => {
          reading = false
          if (active) setLoading(false)
        })
    }
    refresh.current = read
    read()
    return () => {
      active = false
      refresh.current = () => {}
    }
  }, [])

  const versions = [...new Set(installed.map((kernel) => kernel.version))]
  const missingSelection = value !== null && !versions.includes(value)

  return (
    <Field>
      <FieldLabel htmlFor="window-kernel-version">浏览器内核</FieldLabel>
      <div className="flex items-center gap-2">
        <Select
          value={value ?? 'latest'}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === 'latest') onChange(null)
            else if (isKernelVersion(next)) onChange(next)
          }}
        >
          <SelectTrigger
            id="window-kernel-version"
            className="min-w-0 flex-1"
            aria-describedby="window-kernel-description"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="latest">最新稳定版（默认）</SelectItem>
              {versions.map((version) => (
                <SelectItem key={version} value={version}>
                  {version}（已安装）
                </SelectItem>
              ))}
              {missingSelection ? (
                <SelectItem value={value}>{value}（保留选择）</SelectItem>
              ) : null}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || loading}
          onClick={() => refresh.current()}
        >
          <RefreshCw data-icon="inline-start" />
          {loading ? '正在读取…' : error ? '重试读取' : '刷新内核'}
        </Button>
      </div>
      <FieldDescription id="window-kernel-description">
        其他版本可到「应用设置 → 浏览器内核」下载。
        {missingSelection && !loading && !error
          ? '所选版本不在当前清单中，创建时将尝试获取该版本。'
          : null}
      </FieldDescription>
      {error ? (
        <FieldError role="alert">
          {error} 已保留版本选择；仍可使用最新稳定版创建窗口。
        </FieldError>
      ) : null}
    </Field>
  )
}
