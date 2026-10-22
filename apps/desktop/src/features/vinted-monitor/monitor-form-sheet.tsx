import { useState, type FormEvent } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import { inspectUrl, saveMonitor } from './api'
import {
  DEFAULT_MONITOR,
  intervalText,
  kindText,
  message,
  type Monitor,
  type MonitorInput,
} from './types'

const INTERVAL_PRESETS = [5, 10, 30, 60, 180, 720]

interface Inspection {
  url: string
  kind: 'catalog' | 'member'
  host: string
}

export interface MonitorFormSheetProps {
  /** `null` creates a new monitor. */
  monitor: Monitor | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

function initial(monitor: Monitor | null): MonitorInput {
  if (monitor === null) return { ...DEFAULT_MONITOR }
  return {
    id: monitor.id,
    name: monitor.name,
    searchUrl: monitor.searchUrl,
    intervalMinutes: monitor.intervalMinutes,
    maxPages: monitor.maxPages,
    perPage: monitor.perPage,
    enabled: monitor.enabled,
  }
}

function numberIn(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

export function MonitorFormSheet({
  monitor,
  onOpenChange,
  onSaved,
}: MonitorFormSheetProps) {
  const [form, setForm] = useState<MonitorInput>(() => initial(monitor))
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update<K extends keyof MonitorInput>(key: K, value: MonitorInput[K]) {
    setForm((current) => ({ ...current, [key]: value }))
    if (key === 'searchUrl') {
      // The previous verdict no longer applies to the edited URL.
      setInspection(null)
      setUrlError(null)
    }
  }

  async function checkUrl() {
    const url = form.searchUrl.trim()
    if (url === '') {
      setInspection(null)
      setUrlError(null)
      return
    }
    try {
      const result = await inspectUrl(url)
      setInspection({ url: result.url, kind: result.kind, host: result.host })
      setUrlError(null)
    } catch (cause) {
      setInspection(null)
      setUrlError(message(cause))
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    if (form.name.trim() === '') {
      setError('请填写监控名称')
      return
    }
    if (form.searchUrl.trim() === '') {
      setError('请填写 Vinted 监控 URL')
      return
    }
    setPending(true)
    setError(null)
    try {
      await saveMonitor({
        ...form,
        name: form.name.trim(),
        searchUrl: form.searchUrl.trim(),
      })
      toast.success(monitor === null ? '监控已创建' : '监控已更新')
      onSaved()
      onOpenChange(false)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{monitor === null ? '新增监控' : '编辑监控'}</SheetTitle>
          <SheetDescription>
            粘贴 Vinted 的 /catalog 搜索页或 /member/&lt;id&gt;
            衣柜页；采集按页数上限从最新商品往回翻。
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          <form id="vinted-monitor-form" className="vinted-form" onSubmit={submit}>
            <Field>
              <FieldLabel htmlFor="vinted-monitor-name">名称</FieldLabel>
              <Input
                id="vinted-monitor-name"
                maxLength={64}
                placeholder="例如 Nike 女装新品"
                value={form.name}
                disabled={pending}
                onChange={(event) => update('name', event.target.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="vinted-monitor-url">监控 URL</FieldLabel>
              <Input
                id="vinted-monitor-url"
                maxLength={2048}
                spellCheck={false}
                placeholder="https://www.vinted.fr/catalog?search_text=nike"
                value={form.searchUrl}
                disabled={pending}
                onChange={(event) => update('searchUrl', event.target.value)}
                onBlur={() => void checkUrl()}
              />
              {inspection === null ? (
                <FieldDescription>
                  只支持 /catalog 搜索页与 /member/&lt;id&gt;
                  衣柜页，其他页面没有采集接口。
                </FieldDescription>
              ) : (
                <FieldDescription>
                  {kindText(inspection.kind)} · {inspection.host} · 实际采集{' '}
                  <code>{inspection.url}</code>
                </FieldDescription>
              )}
              {urlError === null ? null : (
                <FieldError role="alert">{urlError}</FieldError>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="vinted-monitor-interval">采集间隔（分钟）</FieldLabel>
              <Input
                id="vinted-monitor-interval"
                type="number"
                min={1}
                max={1440}
                value={form.intervalMinutes}
                disabled={pending}
                onChange={(event) =>
                  update('intervalMinutes', numberIn(event.target.value, 1, 1440, 10))
                }
              />
              <div className="vinted-presets" role="group" aria-label="常用间隔">
                {INTERVAL_PRESETS.map((minutes) => (
                  <Button
                    key={minutes}
                    type="button"
                    size="sm"
                    variant={form.intervalMinutes === minutes ? 'default' : 'outline'}
                    disabled={pending}
                    onClick={() => update('intervalMinutes', minutes)}
                  >
                    {intervalText(minutes)}
                  </Button>
                ))}
              </div>
              <FieldDescription>
                应用运行时按此间隔自动采集；关掉应用就不会继续。
              </FieldDescription>
            </Field>

            <div className="vinted-form-grid">
              <Field>
                <FieldLabel htmlFor="vinted-monitor-pages">最多页数</FieldLabel>
                <Input
                  id="vinted-monitor-pages"
                  type="number"
                  min={1}
                  max={20}
                  value={form.maxPages}
                  disabled={pending}
                  onChange={(event) =>
                    update('maxPages', numberIn(event.target.value, 1, 20, 3))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="vinted-monitor-per-page">每页商品数</FieldLabel>
                <Input
                  id="vinted-monitor-per-page"
                  type="number"
                  min={1}
                  max={96}
                  value={form.perPage}
                  disabled={pending}
                  onChange={(event) =>
                    update('perPage', numberIn(event.target.value, 1, 96, 20))
                  }
                />
              </Field>
            </div>
            <FieldDescription>
              一次最多采集 {form.maxPages} × {form.perPage} ={' '}
              {form.maxPages * form.perPage} 件，超出部分留到下一次。
            </FieldDescription>

            <div className="vinted-switch-row">
              <Switch
                id="vinted-monitor-enabled"
                checked={form.enabled}
                disabled={pending}
                onCheckedChange={(checked) => update('enabled', checked)}
              />
              <div>
                <label htmlFor="vinted-monitor-enabled">启用定时采集</label>
                <p className="vinted-muted">
                  关闭后仍可手动点「立即采集」，只是不再按间隔自动运行。
                </p>
              </div>
            </div>

            {error === null ? null : (
              <FieldError role="alert" className="vinted-inline-status">
                <XCircle aria-hidden="true" />
                {error}
              </FieldError>
            )}
            {inspection === null ? null : (
              <p className="vinted-inline-status" role="status">
                <CheckCircle2 aria-hidden="true" />
                URL 可以采集
              </p>
            )}
          </form>
        </SheetBody>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" form="vinted-monitor-form" disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {pending ? '保存中…' : '保存监控'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
