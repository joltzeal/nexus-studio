import { useState, type FormEvent } from 'react'
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
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from '@/components/ui/toast'
import { importMailboxes } from './api'
import { useEmailAction } from './hooks'
import type { ImportReport, MailTransport } from './types'

export function ImportMailboxesDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [text, setText] = useState('')
  const [transport, setTransport] = useState<MailTransport>('graph')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [validation, setValidation] = useState<string | null>(null)
  const { action, busy, error } = useEmailAction(
    '邮箱导入失败，请检查格式或插件状态后重试。',
  )

  function close() {
    action.dispose()
    onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const lines = text.split(/\r?\n/).filter((line) => line.trim())
    if (
      !lines.length ||
      lines.length > 500 ||
      new TextEncoder().encode(text).byteLength > 512 * 1024
    ) {
      setValidation('每批请输入 1–500 行，内容不超过 512 KiB。')
      return
    }
    setValidation(null)
    setReport(null)
    void action.run(
      () => importMailboxes(text, transport),
      (result) => {
        setReport(result)
        setText('')
        onImported()
        toast.success(`已导入 ${result.inserted} 个邮箱`)
      },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>批量导入邮箱</DialogTitle>
          <DialogDescription>重复邮箱跳过，不覆盖已有或已轮换的凭据。</DialogDescription>
        </DialogHeader>
        <form id="email-import-form" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel>导入通道</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={transport}
                disabled={busy}
                aria-label="导入收信通道"
                onValueChange={(value) => {
                  if (value === 'graph' || value === 'imap') setTransport(value)
                }}
              >
                <ToggleGroupItem value="graph">Graph</ToggleGroupItem>
                <ToggleGroupItem value="imap">IMAP</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                默认 Graph。仅导入已获得所选通道权限的凭据。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="email-import-text">邮箱资料（每行一条）</FieldLabel>
              <Textarea
                id="email-import-text"
                value={text}
                rows={8}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="邮箱----密码----client_id----refresh_token"
                onChange={(event) => setText(event.target.value)}
              />
              <FieldDescription>
                四段以 ---- 分隔。凭据明文保存在插件私有目录。
              </FieldDescription>
            </Field>
            {validation || error ? <FieldError>{validation ?? error}</FieldError> : null}
          </FieldGroup>
        </form>
        {report ? (
          <div className="flex min-w-0 flex-col gap-2 text-sm" role="status">
            <p>
              共 {report.total} 行 · 已导入 {report.inserted} · 已跳过 {report.skipped}
            </p>
            {report.errors.length ? (
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-destructive">
                {report.errors.map((entry, index) => (
                  <li key={`${entry.row}-${index}`}>
                    第 {entry.row} 行：{entry.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            关闭
          </Button>
          <Button type="submit" form="email-import-form" disabled={busy || !text.trim()}>
            {busy ? '导入中…' : '导入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
