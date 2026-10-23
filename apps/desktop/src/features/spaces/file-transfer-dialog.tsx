import { useRef, useState, type FormEvent } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { NativeProfile } from '@/lib/platform/native-profiles'
import {
  exportWindows,
  importWindows,
  inspectTransfer,
  pickTransferPath,
  transferError,
  type ExportReport,
  type ImportMode,
  type TransferInspection,
  type TransferReport,
} from '@/lib/platform/native-transfer'
import { ImportModeField, TransferResult, TransferWarnings } from './transfer-feedback'
import { exportPasswordError, selectionError } from './transfer-state'

export function FileTransferDialog({
  kind,
  windows,
  operating,
  onImported,
  onClose,
}: {
  kind: 'export' | 'import'
  windows: NativeProfile[]
  operating: ReadonlySet<string>
  onImported: () => Promise<void>
  onClose: () => void
}) {
  const [path, setPath] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [inspection, setInspection] = useState<TransferInspection | null>(null)
  const [mode, setMode] = useState<ImportMode>('copy')
  const [report, setReport] = useState<TransferReport | ExportReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const exporting = kind === 'export'
  const issue = exporting ? selectionError(windows, operating) : null

  async function run(label: string, operation: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(label)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      setError(transferError(cause))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  function chooseImportFile() {
    void run('正在选择文件…', async () => {
      const chosen = await pickTransferPath(false)
      if (chosen === null) return
      setPath(chosen)
      setPassword('')
      setInspection(null)
      setReport(null)
      setMode('copy')
    })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (report !== null || inFlight.current) return
    if (exporting) {
      const problem = issue ?? exportPasswordError(password, confirmation)
      if (problem !== null) {
        setError(problem)
        return
      }
      void run('正在选择导出位置…', async () => {
        const chosen = await pickTransferPath(true)
        if (chosen === null) return
        setPath(chosen)
        setBusy('正在加密并导出快照，请保持窗口关闭…')
        const result = await exportWindows(
          windows.map((window) => window.id),
          password,
          chosen,
        )
        setReport(result)
        setPassword('')
        setConfirmation('')
      })
    } else if (path !== null && password.length > 0) {
      void run('正在解密并检查快照…', async () => {
        setInspection(null)
        setInspection(await inspectTransfer(path, password))
      })
    } else {
      setError('请先选择 .nexuswindow 文件并输入密码。')
    }
  }

  function confirmImport() {
    if (inspection === null || path === null || report !== null) return
    void run('正在导入快照，请等待宿主完成…', async () => {
      const result = await importWindows(path, password, mode)
      setReport(result)
      setPassword('')
      try {
        await onImported()
      } catch (cause) {
        setError(
          `窗口已导入，但列表刷新失败：${transferError(cause)}。请关闭弹窗后刷新列表。`,
        )
      }
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !inFlight.current) onClose()
      }}
    >
      <DialogContent className="sm:max-w-xl" showCloseButton={busy === null}>
        <DialogHeader>
          <DialogTitle>{exporting ? '导出窗口' : '导入窗口'}</DialogTitle>
          <DialogDescription>
            {exporting
              ? `将选中的 ${windows.length} 个已关闭窗口保存为加密的 .nexuswindow 快照。密码不会保存。`
              : '选择加密快照，解密检查后显式导入。副本在两台设备上各自独立，后续修改不会自动合并。'}
          </DialogDescription>
        </DialogHeader>
        {report !== null ? (
          <TransferResult
            report={report}
            action={exporting ? '导出' : '导入'}
            path={report.path}
          />
        ) : (
          <>
            <form id="window-transfer-form" onSubmit={submit}>
              <FieldGroup>
                {!exporting ? (
                  <Field>
                    <FieldLabel>快照文件</FieldLabel>
                    <div className="flex min-w-0 items-center gap-2">
                      <Input
                        aria-label="快照文件路径"
                        readOnly
                        value={path ?? ''}
                        placeholder="选择 .nexuswindow 文件"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={chooseImportFile}
                      >
                        <FolderOpen data-icon="inline-start" />
                        选择文件
                      </Button>
                    </div>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="transfer-password">
                    {exporting ? '导出密码' : '快照密码'}
                  </FieldLabel>
                  <Input
                    id="transfer-password"
                    type="password"
                    autoComplete={exporting ? 'new-password' : 'off'}
                    disabled={busy !== null}
                    value={password}
                    placeholder={exporting ? '至少 8 个字符' : '输入快照密码'}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setInspection(null)
                      setMode('copy')
                      setError(null)
                    }}
                  />
                </Field>
                {exporting ? (
                  <Field>
                    <FieldLabel htmlFor="transfer-password-confirmation">
                      确认密码
                    </FieldLabel>
                    <Input
                      id="transfer-password-confirmation"
                      type="password"
                      autoComplete="new-password"
                      disabled={busy !== null}
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </Field>
                ) : null}
              </FieldGroup>
            </form>
            {issue ? <FieldError>{issue}</FieldError> : null}
            {exporting &&
            windows.some((window) => window.settings.fingerprintSeed === null) ? (
              <TransferWarnings
                warnings={['部分旧窗口未固定指纹种子，迁移后不能保证指纹完全一致。']}
              />
            ) : null}
            {inspection !== null ? (
              <div className="flex min-w-0 flex-col gap-4">
                <p className="text-muted-foreground">
                  来源 {inspection.sourcePlatform} / {inspection.sourceArch} ·{' '}
                  {inspection.windows.length} 个窗口
                </p>
                <div className="max-h-52 overflow-auto">
                  <Table aria-label="快照窗口预览">
                    <TableHeader>
                      <TableRow>
                        <TableHead>窗口</TableHead>
                        <TableHead>平台</TableHead>
                        <TableHead>精确内核版本</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {inspection.windows.map((window) => (
                        <TableRow key={window.id}>
                          <TableCell
                            className="max-w-52 truncate"
                            title={`${window.name} · ${window.id}`}
                          >
                            {window.name}
                          </TableCell>
                          <TableCell>{window.platform}</TableCell>
                          <TableCell>{window.version}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="break-words text-muted-foreground">
                  所需插件：
                  {inspection.plugins.length
                    ? inspection.plugins
                        .map((plugin) => `${plugin.id} ${plugin.version}`)
                        .join('、')
                    : '无'}
                </p>
                <TransferWarnings warnings={inspection.warnings} />
                <ImportModeField
                  mode={mode}
                  disabled={busy !== null}
                  onChange={setMode}
                />
              </div>
            ) : null}
          </>
        )}
        {busy ? (
          <p role="status" aria-live="polite" className="text-muted-foreground">
            {busy}
          </p>
        ) : null}
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy !== null} onClick={onClose}>
            关闭
          </Button>
          {report === null ? (
            <>
              <Button
                type="submit"
                form="window-transfer-form"
                variant={exporting || inspection === null ? 'default' : 'outline'}
                disabled={busy !== null || issue !== null}
              >
                {busy ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : null}
                {exporting ? '加密导出' : inspection === null ? '解密预览' : '重新检查'}
              </Button>
              {!exporting && inspection !== null ? (
                <Button
                  variant={mode === 'replace' ? 'destructive' : 'default'}
                  disabled={busy !== null || inspection.windows.length === 0}
                  onClick={confirmImport}
                >
                  {mode === 'replace' ? '覆盖导入' : '导入独立副本'}
                </Button>
              ) : null}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
