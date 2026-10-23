import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import type { ImportMode, TransferReport } from '@/lib/platform/native-transfer'

export function TransferWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null
  return (
    <Alert>
      <AlertTitle>迁移提示</AlertTitle>
      <AlertDescription>
        <ul className="flex list-disc flex-col gap-1 pl-4">
          {warnings.map((warning, index) => (
            <li key={index} className="break-words">
              {warning}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

export function TransferResult({
  report,
  action,
  path,
}: {
  report: TransferReport
  action: '导出' | '导入'
  path?: string | null | undefined
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3" role="status">
      <p>
        已{action} {report.windowCount} 个窗口。
      </p>
      {path ? <p className="break-all text-muted-foreground">{path}</p> : null}
      <TransferWarnings warnings={report.warnings} />
    </div>
  )
}

export function ImportModeField({
  mode,
  disabled,
  onChange,
  sync = false,
}: {
  mode: ImportMode
  disabled: boolean
  onChange: (mode: ImportMode) => void
  sync?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <Field orientation="horizontal" data-disabled={disabled}>
        <FieldContent>
          <FieldLabel htmlFor="transfer-replace">覆盖同标识窗口</FieldLabel>
          <FieldDescription>
            {sync
              ? '接收为独立窗口，保留标识供后续同步；已存在时不会覆盖。覆盖需显式启用，且目标窗口必须关闭。'
              : '默认导入独立副本并生成新标识。覆盖会替换完整快照；目标窗口必须关闭，宿主会再次检查。'}
          </FieldDescription>
        </FieldContent>
        <Switch
          id="transfer-replace"
          checked={mode === 'replace'}
          disabled={disabled}
          onCheckedChange={(checked) => {
            if (checked) setConfirming(true)
            else onChange('copy')
          }}
        />
      </Field>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认启用覆盖导入？</AlertDialogTitle>
            <AlertDialogDescription>
              同标识窗口的配置、站点数据及关联插件资料将以这份完整快照为准。
              请先关闭目标窗口；两台设备的后续修改不会自动合并。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留副本模式</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onChange('replace')}>
              确认覆盖模式
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
