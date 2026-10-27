import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Textarea } from '@/components/ui/textarea'
import { getRecord, testProviderImage, uploadImage } from './api'
import { checkReference, prepareReference } from './prepare-reference'
import { RecordImage } from './record-image'
import { RecordSession } from './record-session'
import { MAX_PROMPT_CHARACTERS } from './selection'
import {
  formatDuration,
  message,
  PROVIDER_IMAGE_TEST_METHOD,
  PROVIDER_IMAGE_TEST_UPDATE_HINT,
  SIZES,
  statusText,
  type GenerationMode,
  type GenerationRecord,
  type ImageSize,
  type Provider,
  type StoredFile,
} from './types'

export function ProviderImageTestDialog({
  provider,
  pluginMethods,
  modelConfigReady,
  onClose,
  onChanged,
}: {
  provider: Provider
  pluginMethods?: string[] | undefined
  modelConfigReady: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [saved] = useState(() => ({ ...provider }))
  const [session] = useState(() => new RecordSession(getRecord))
  const active = useRef(true)
  const requestLocked = useRef(false)
  const upload = useRef<AbortController | null>(null)
  const changed = useRef(onChanged)
  const [mode, setMode] = useState<GenerationMode>('generate')
  const [prompt, setPrompt] = useState(
    'A blue ceramic cup on a plain wooden table in natural daylight.',
  )
  const [size, setSize] = useState<ImageSize>('1024x1024')
  const [reference, setReference] = useState<StoredFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [record, setRecord] = useState<GenerationRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const supported = pluginMethods?.includes(PROVIDER_IMAGE_TEST_METHOD) === true
  const available =
    supported && modelConfigReady && saved.hasApiKey && !!saved.imageModel.trim()
  const locked = submitting || record !== null
  const invalidPrompt = !prompt.trim() || prompt.length > MAX_PROMPT_CHARACTERS

  useLayoutEffect(() => {
    changed.current = onChanged
  }, [onChanged])

  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
      upload.current?.abort()
      session.close()
    }
  }, [session])

  function close() {
    active.current = false
    upload.current?.abort()
    session.close()
    onClose()
  }

  function clearReference() {
    upload.current?.abort()
    upload.current = null
    setReference(null)
    setUploading(false)
    setError(null)
  }

  async function chooseFile(files: File[]) {
    if (!active.current || requestLocked.current || !available || mode !== 'edit') return
    if (files.length === 0) return
    clearReference()
    if (files.length !== 1) {
      setError('图生图测试需要且只能选择一张参考图。')
      return
    }
    const file = files[0]!
    const invalid = checkReference(file)
    if (invalid !== null) {
      setError(invalid)
      return
    }
    const controller = new AbortController()
    upload.current = controller
    const current = () =>
      active.current && upload.current === controller && !controller.signal.aborted
    setUploading(true)
    try {
      const prepared = await prepareReference(file, controller.signal)
      if (!current()) return
      const stored = await uploadImage(prepared, controller.signal)
      if (current()) setReference(stored)
    } catch (cause) {
      if (current()) setError(message(cause))
    } finally {
      if (current()) {
        upload.current = null
        setUploading(false)
      }
    }
  }

  async function notifyChanged(callback = changed.current) {
    try {
      await callback()
      if (active.current) setHistoryError(null)
    } catch (cause) {
      if (active.current) {
        setHistoryError(
          `测试任务已提交，但历史记录刷新失败：${message(cause)}。请刷新结果，勿重复提交。`,
        )
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!active.current || requestLocked.current) return
    if (!supported || !modelConfigReady) {
      setError(PROVIDER_IMAGE_TEST_UPDATE_HINT)
      return
    }
    if (!available) {
      setError('请先保存服务商的 API Key 和生图模型。')
      return
    }
    if (invalidPrompt) {
      setError(
        `请填写测试提示词，最多 ${MAX_PROMPT_CHARACTERS} 字符；超出内容仍保留，请自行精简。`,
      )
      return
    }
    if (uploading || (mode === 'edit' && reference === null)) {
      setError('请先上传成功一张参考图，再开始图生图测试。')
      return
    }
    // The ref locks synchronously, including two clicks before React renders.
    requestLocked.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await testProviderImage({
        id: saved.id,
        model: saved.imageModel,
        mode,
        prompt,
        size,
        inputFileIds: mode === 'edit' && reference !== null ? [reference.id] : [],
      })
      // Acceptance belongs to history even if this dialog has already closed.
      void notifyChanged(onChanged)
      if (!active.current) return
      setRecord(result.record)
      let settled = result.record.status !== 'running'
      const notifySettled = () => {
        if (settled) return
        settled = true
        void notifyChanged()
      }
      void session.open(result.record.id, {
        onRecord: (next) => {
          setRecord(next)
          setReadError(null)
          // The first read can already be complete, before RecordSession saw running.
          if (next.status !== 'running') notifySettled()
        },
        onError: (failure) => setReadError(failure),
        onSettled: notifySettled,
      })
    } catch (cause) {
      if (active.current) {
        requestLocked.current = false
        setError(message(cause))
      }
    } finally {
      if (active.current) setSubmitting(false)
    }
  }

  function refresh() {
    if (!active.current || record === null) return
    setReadError(null)
    void session.refresh()
    if (historyError !== null) void notifyChanged()
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="flex max-h-[90svh] flex-col gap-4 p-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>测试生图</DialogTitle>
          <DialogDescription>
            每次测试实际生成 1 张图片，按服务商规则计费，仅使用生图模型。
          </DialogDescription>
        </DialogHeader>

        <form
          id="ai-provider-image-test"
          className="min-h-0 space-y-4 overflow-y-auto p-1"
          onSubmit={submit}
        >
          <div className="space-y-1 break-words text-sm">
            <p>
              {saved.name} · {saved.imageModel || '未配置生图模型'}
            </p>
            <p className="ai-muted">{saved.baseUrl}</p>
            <FieldDescription>
              使用已保存的配置测试，不更改常用模型选择。
            </FieldDescription>
          </div>
          {!supported || !modelConfigReady ? (
            <FieldError role="alert">{PROVIDER_IMAGE_TEST_UPDATE_HINT}</FieldError>
          ) : !available ? (
            <FieldError role="alert">请先保存 API Key 和生图模型。</FieldError>
          ) : null}

          <div className="ai-form-grid">
            <Field>
              <FieldLabel htmlFor="ai-test-mode">测试方式</FieldLabel>
              <LabeledSelect
                id="ai-test-mode"
                ariaLabel="测试方式"
                value={mode}
                disabled={locked || !available}
                options={[
                  { value: 'generate', label: '文生图' },
                  { value: 'edit', label: '图生图' },
                ]}
                onValueChange={(value) => {
                  if (!active.current || requestLocked.current || !available) return
                  if ((value !== 'generate' && value !== 'edit') || value === mode) return
                  clearReference()
                  setMode(value)
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ai-test-size">输出尺寸</FieldLabel>
              <LabeledSelect
                id="ai-test-size"
                ariaLabel="输出尺寸"
                value={size}
                disabled={locked || !available}
                options={SIZES}
                onValueChange={(value) => {
                  if (!active.current || requestLocked.current || !available) return
                  const selected = SIZES.find((entry) => entry.value === value)
                  if (selected) setSize(selected.value)
                }}
              />
            </Field>
          </div>

          <Field data-invalid={invalidPrompt}>
            <FieldLabel htmlFor="ai-test-prompt">测试提示词</FieldLabel>
            <Textarea
              id="ai-test-prompt"
              rows={3}
              value={prompt}
              disabled={locked || !available}
              aria-invalid={invalidPrompt}
              onChange={(event) => {
                if (active.current && !requestLocked.current && available)
                  setPrompt(event.target.value)
              }}
            />
            <FieldDescription>
              {prompt.length} / {MAX_PROMPT_CHARACTERS} 字符
            </FieldDescription>
          </Field>

          {mode === 'edit' ? (
            <Field>
              <FieldLabel htmlFor="ai-test-reference">参考图片</FieldLabel>
              <Input
                id="ai-test-reference"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={locked || !available}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? [])
                  event.currentTarget.value = ''
                  void chooseFile(files)
                }}
              />
              <FieldDescription>
                选择一张 JPEG、PNG 或 WebP，最多 8 MB；本机转为 JPEG 后上传。
              </FieldDescription>
              {uploading ? (
                <p className="ai-muted" role="status">
                  正在处理并上传参考图…
                </p>
              ) : null}
              {reference === null ? null : (
                <RecordImage
                  file={reference}
                  alt="测试参考图"
                  className="max-h-40 w-full rounded-md object-contain"
                />
              )}
              {reference === null && !uploading ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    if (active.current && !requestLocked.current) clearReference()
                  }}
                >
                  移除参考图
                </Button>
              )}
            </Field>
          ) : null}

          {submitting ? (
            <p role="status" className="ai-muted">
              正在提交测试，请勿重复提交…
            </p>
          ) : null}
          {record === null ? null : (
            <section className="space-y-2" aria-label="测试结果" aria-live="polite">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>测试任务已提交</span>
                <Badge variant={record.status === 'failed' ? 'destructive' : 'secondary'}>
                  {record.status === 'running' ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : null}
                  {statusText(record)}
                </Badge>
                {record.durationMs === null ? null : (
                  <span className="ai-muted">
                    耗时 {formatDuration(record.durationMs)}
                  </span>
                )}
              </div>
              {record.outputs[0] === undefined ? null : (
                <RecordImage
                  file={record.outputs[0]}
                  alt="测试生成图片"
                  className="max-h-64 w-full rounded-md object-contain"
                />
              )}
              {record.error === null ? null : (
                <FieldError role="alert" className="whitespace-pre-wrap break-words">
                  {record.error}
                </FieldError>
              )}
              {record.status === 'failed' ? (
                <FieldDescription>
                  修改配置后请重新测试；历史记录中的重试沿用原模型。
                </FieldDescription>
              ) : null}
            </section>
          )}
          {error === null ? null : (
            <FieldError role="alert" className="whitespace-pre-wrap break-words">
              {error}
            </FieldError>
          )}
          {readError === null ? null : (
            <FieldError role="alert" className="whitespace-pre-wrap break-words">
              测试已提交，读取结果失败：{readError}。请刷新结果，勿重复提交。
            </FieldError>
          )}
          {historyError === null ? null : (
            <FieldError role="alert" className="whitespace-pre-wrap break-words">
              {historyError}
            </FieldError>
          )}
          <FieldDescription>
            关闭后任务继续运行，可在历史记录中查看结果、重试或导出。
          </FieldDescription>
        </form>

        <DialogFooter>
          {record === null ? null : (
            <Button type="button" variant="outline" onClick={refresh}>
              <RefreshCw data-icon="inline-start" />
              刷新结果
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={close}>
            关闭
          </Button>
          <Button
            type="submit"
            form="ai-provider-image-test"
            disabled={
              locked ||
              !available ||
              invalidPrompt ||
              uploading ||
              (mode === 'edit' && reference === null)
            }
          >
            {submitting ? (
              <Loader2
                className="animate-spin"
                data-icon="inline-start"
                aria-hidden="true"
              />
            ) : null}
            {submitting ? '提交中…' : '开始测试'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
