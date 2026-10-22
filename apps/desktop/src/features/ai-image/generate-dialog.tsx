import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { ImagePlus, Loader2, X } from 'lucide-react'
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
import { toast } from '@/components/ui/toast'
import { generate, uploadImage } from './api'
import { checkReference, prepareReference } from './prepare-reference'
import { SIZES, message, type Provider, type ScenePreset, type StoredFile } from './types'

interface Reference {
  key: string
  name: string
  preview: string
  state: 'uploading' | 'ready' | 'failed'
  file: StoredFile | null
  error: string | null
}

const MAX_REFERENCES = 6

export function GenerateDialog({
  providers,
  presets,
  onOpenChange,
  onSubmitted,
  onConfigure,
}: {
  providers: Provider[]
  presets: ScenePreset[]
  onOpenChange: (open: boolean) => void
  onSubmitted: () => Promise<void>
  onConfigure: () => void
}) {
  const usable = providers.filter((provider) => provider.hasApiKey)
  const [references, setReferences] = useState<Reference[]>([])
  const [presetId, setPresetId] = useState<string | null>(presets[0]?.id ?? null)
  const [prompt, setPrompt] = useState('')
  const [providerId, setProviderId] = useState(usable[0]?.id ?? '')
  const [size, setSize] = useState('1024x1024')
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const uploading = references.some((entry) => entry.state === 'uploading')
  const mode = references.length > 0 ? 'edit' : 'generate'
  const preset = useMemo(
    () => presets.find((entry) => entry.id === presetId) ?? null,
    [presets, presetId],
  )

  async function addFiles(files: File[]) {
    const room = MAX_REFERENCES - references.length
    if (room <= 0) {
      setError(`最多 ${String(MAX_REFERENCES)} 张参考图片。`)
      return
    }
    setError(null)
    for (const file of files.slice(0, room)) {
      const invalid = checkReference(file)
      const key = `${file.name}-${String(file.lastModified)}-${Math.random().toString(36).slice(2)}`
      const preview = URL.createObjectURL(file)
      if (invalid !== null) {
        setReferences((current) => [
          ...current,
          { key, name: file.name, preview, state: 'failed', file: null, error: invalid },
        ])
        continue
      }
      setReferences((current) => [
        ...current,
        { key, name: file.name, preview, state: 'uploading', file: null, error: null },
      ])
      try {
        const prepared = await prepareReference(file)
        const stored = await uploadImage(prepared)
        setReferences((current) =>
          current.map((entry) =>
            entry.key === key
              ? { ...entry, state: 'ready', file: stored, name: prepared.name }
              : entry,
          ),
        )
      } catch (cause) {
        setReferences((current) =>
          current.map((entry) =>
            entry.key === key
              ? { ...entry, state: 'failed', error: message(cause) }
              : entry,
          ),
        )
      }
    }
  }

  function remove(key: string) {
    setReferences((current) => {
      const target = current.find((entry) => entry.key === key)
      if (target !== undefined) URL.revokeObjectURL(target.preview)
      return current.filter((entry) => entry.key !== key)
    })
  }

  async function submit() {
    if (busy || uploading) return
    if (providerId === '') {
      setError('请先在模型配置中保存一个服务商。')
      return
    }
    if (presetId === null && prompt.trim() === '') {
      setError('自由提示词不能为空；也可以选择一个场景预设。')
      return
    }
    const files = references
      .map((entry) => entry.file)
      .filter((entry): entry is StoredFile => entry !== null)
    if (references.length > 0 && files.length === 0) {
      setError('参考图片没有上传成功，请重新选择。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await generate({
        providerId,
        mode,
        presetId,
        prompt: prompt.trim(),
        size,
        count,
        inputFileIds: files.map((entry) => entry.id),
      })
      await onSubmitted()
      toast.success('已提交生成任务，记录里可以查看进度')
      onOpenChange(false)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (busy ? undefined : onOpenChange(open))}>
      <DialogContent className="ai-dialog">
        <DialogHeader>
          <DialogTitle>AI 生图</DialogTitle>
          <DialogDescription>
            上传一张或多张参考图会走改图接口；不上传图片则按提示词直接生成。每次生成都会写入记录。
          </DialogDescription>
        </DialogHeader>

        <div className="ai-dialog-body">
          <section className="ai-dialog-column" aria-label="参考图片">
            <div className="ai-form-head">
              <h3>参考图片</h3>
              <span className="ai-muted">
                {references.length} / {MAX_REFERENCES}
              </span>
            </div>
            <div className="ai-dropzone">
              {references.map((entry) => (
                <div key={entry.key} className="ai-thumb">
                  <img src={entry.preview} alt={entry.name} />
                  {entry.state === 'uploading' ? (
                    <span className="ai-thumb-state">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    </span>
                  ) : null}
                  {entry.state === 'failed' ? (
                    <span className="ai-thumb-state is-error">失败</span>
                  ) : null}
                  <button
                    type="button"
                    className="ai-thumb-remove"
                    aria-label={`移除 ${entry.name}`}
                    disabled={busy}
                    onClick={() => remove(entry.key)}
                  >
                    <X />
                  </button>
                </div>
              ))}
              {references.length < MAX_REFERENCES ? (
                <button
                  type="button"
                  className="ai-thumb is-add"
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  <ImagePlus aria-hidden="true" />
                  <span>选择图片</span>
                </button>
              ) : null}
            </div>
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-label="选择参考图片"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (files.length > 0) void addFiles(files)
              }}
            />
            <FieldDescription>
              支持 JPEG、PNG、WebP，单张不超过 8 MB；页面会先缩到最长边 1536 像素再上传。
              不上传图片时按文生图处理。
            </FieldDescription>
            {references.some((entry) => entry.error !== null) ? (
              <FieldError>
                {references
                  .filter((entry) => entry.error !== null)
                  .map((entry) => `${entry.name}：${entry.error ?? ''}`)
                  .join('；')}
              </FieldError>
            ) : null}
          </section>

          <section className="ai-dialog-column" aria-label="生成设置">
            <div className="ai-form-head">
              <h3>场景预设</h3>
              <span className="ai-muted">点选后自动补充说明</span>
            </div>
            <div className="ai-preset-grid" role="radiogroup" aria-label="场景预设">
              <button
                type="button"
                role="radio"
                aria-checked={presetId === null}
                className={presetId === null ? 'ai-preset is-active' : 'ai-preset'}
                disabled={busy}
                onClick={() => setPresetId(null)}
              >
                <strong>自由提示词</strong>
                <span>完全按你写的内容生成</span>
              </button>
              {presets.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={presetId === entry.id}
                  className={presetId === entry.id ? 'ai-preset is-active' : 'ai-preset'}
                  disabled={busy}
                  onClick={() => setPresetId(entry.id)}
                >
                  <strong>{entry.label}</strong>
                  <span>{entry.hint}</span>
                </button>
              ))}
            </div>

            <Field>
              <FieldLabel htmlFor="ai-prompt">
                {presetId === null ? '提示词' : '附加要求（可选）'}
              </FieldLabel>
              <Textarea
                id="ai-prompt"
                rows={4}
                maxLength={4000}
                disabled={busy}
                placeholder={
                  presetId === null
                    ? '例如：把商品放在浅灰背景前，正面平视，柔和侧光。'
                    : '例如：背景再暖一点，商品靠左放置。'
                }
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <FieldDescription>
                {preset === null
                  ? '这段文字会原样发给生图模型。'
                  : `预设「${preset.label}」会先加入商品重建说明，再追加你写的要求。`}
              </FieldDescription>
            </Field>

            <div className="ai-form-grid">
              <Field>
                <FieldLabel htmlFor="ai-provider">服务商</FieldLabel>
                <LabeledSelect
                  id="ai-provider"
                  ariaLabel="服务商"
                  value={providerId}
                  disabled={busy}
                  options={usable.map((entry) => ({
                    value: entry.id,
                    label: `${entry.name} · ${entry.imageModel}`,
                  }))}
                  onValueChange={setProviderId}
                />
                {usable.length === 0 ? (
                  <FieldDescription>
                    还没有可用的服务商。
                    <button type="button" className="ai-link" onClick={onConfigure}>
                      去配置
                    </button>
                  </FieldDescription>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="ai-size">尺寸</FieldLabel>
                <LabeledSelect
                  id="ai-size"
                  ariaLabel="尺寸"
                  value={size}
                  disabled={busy}
                  options={SIZES}
                  onValueChange={setSize}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="ai-count">生成张数</FieldLabel>
              <Input
                id="ai-count"
                type="number"
                min={1}
                max={4}
                className="ai-count-input"
                disabled={busy}
                value={count}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  setCount(Number.isFinite(next) ? Math.min(4, Math.max(1, next)) : 1)
                }}
              />
              <FieldDescription>
                {mode === 'edit'
                  ? '部分兼容接口的改图一次只返回一张，多张会被服务商拒绝。'
                  : '一次请求生成 1–4 张，费用按张计算。'}
              </FieldDescription>
            </Field>

            {error === null ? null : <FieldError role="alert">{error}</FieldError>}
          </section>
        </div>

        <DialogFooter>
          <p className="ai-muted me-auto">
            提交后会请求外部接口并可能产生费用；失败不会自动重试。
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || uploading || providerId === ''}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy ? '提交中…' : uploading ? '图片上传中…' : '开始生成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
