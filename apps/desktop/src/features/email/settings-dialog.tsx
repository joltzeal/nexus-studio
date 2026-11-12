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
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import { getSettings, saveSettings } from './api'
import { EmailResource } from './async-state'
import { useEmailAction, useEmailResource } from './hooks'
import type { EmailSettings } from './types'

export function RefreshSettingsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const [resource] = useState(
    () => new EmailResource({}, getSettings, '刷新设置读取失败，请重试。'),
  )
  const state = useEmailResource(resource)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          resource.dispose()
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>收信与 Token 设置</DialogTitle>
          <DialogDescription>
            收信与 token 刷新独立调度；退出应用后停止。关闭自动收信后仍可手动收信。
          </DialogDescription>
        </DialogHeader>
        {state.value ? (
          <RefreshSettingsForm
            initial={state.value}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : (
          <div className="flex flex-col items-start gap-3">
            {state.loading ? (
              <p className="text-sm text-muted-foreground" role="status">
                正在读取设置…
              </p>
            ) : null}
            {state.error ? (
              <>
                <FieldError>{state.error}</FieldError>
                <Button variant="outline" onClick={resource.refresh}>
                  重试
                </Button>
              </>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RefreshSettingsForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: EmailSettings
  onClose: () => void
  onSaved: () => void
}) {
  const [autoRefresh, setAutoRefresh] = useState(initial.autoRefresh)
  const [interval, setInterval] = useState(String(initial.intervalMinutes))
  const [autoReceive, setAutoReceive] = useState(initial.autoReceive)
  const [receiveInterval, setReceiveInterval] = useState(
    String(initial.receiveIntervalMinutes),
  )
  const [validation, setValidation] = useState<string | null>(null)
  const { action, busy, error } = useEmailAction('刷新设置保存失败，请重试。')
  function close() {
    action.dispose()
    onClose()
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    const intervalMinutes = Number(interval)
    const receiveIntervalMinutes = Number(receiveInterval)
    if (
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 5 ||
      intervalMinutes > 1440
    ) {
      setValidation('刷新间隔须为 5–1440 分钟的整数。')
      return
    }
    if (
      !Number.isInteger(receiveIntervalMinutes) ||
      receiveIntervalMinutes < 1 ||
      receiveIntervalMinutes > 60
    ) {
      setValidation('收信间隔须为 1–60 分钟的整数。')
      return
    }
    setValidation(null)
    void action.run(
      () =>
        saveSettings({
          autoRefresh,
          intervalMinutes,
          autoReceive,
          receiveIntervalMinutes,
        }),
      () => {
        onSaved()
        toast.success('收信与 Token 设置已保存')
        close()
      },
    )
  }
  return (
    <>
      <form id="email-settings-form" onSubmit={submit}>
        <FieldGroup>
          <FieldSet>
            <FieldLegend>邮件接收</FieldLegend>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="email-auto-receive">自动收信</FieldLabel>
              <Switch
                id="email-auto-receive"
                checked={autoReceive}
                disabled={busy}
                onCheckedChange={setAutoReceive}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email-receive-interval">收信间隔（分钟）</FieldLabel>
              <Input
                id="email-receive-interval"
                type="number"
                min={1}
                max={60}
                step={1}
                value={receiveInterval}
                disabled={busy}
                required
                onChange={(event) => setReceiveInterval(event.target.value)}
              />
              <FieldDescription>
                允许 1–60 分钟；检查收件箱与垃圾箱，不自动标记已读。
              </FieldDescription>
            </Field>
          </FieldSet>
          <FieldSet>
            <FieldLegend>Token 刷新</FieldLegend>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="email-auto-refresh">自动刷新 token</FieldLabel>
              <Switch
                id="email-auto-refresh"
                checked={autoRefresh}
                disabled={busy}
                onCheckedChange={setAutoRefresh}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email-refresh-interval">
                Token 刷新间隔（分钟）
              </FieldLabel>
              <Input
                id="email-refresh-interval"
                type="number"
                min={5}
                max={1440}
                step={1}
                value={interval}
                disabled={busy}
                required
                onChange={(event) => setInterval(event.target.value)}
              />
              <FieldDescription>
                允许 5–1440 分钟；token 临近到期时会提前刷新。
              </FieldDescription>
            </Field>
          </FieldSet>
          {validation || error ? <FieldError>{validation ?? error}</FieldError> : null}
        </FieldGroup>
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={close}>
          取消
        </Button>
        <Button type="submit" form="email-settings-form" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </DialogFooter>
    </>
  )
}
