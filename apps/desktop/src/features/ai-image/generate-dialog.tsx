import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toast'
import { generate, uploadImage, uploadRemoteImage } from './api'
import { checkReference, prepareReference } from './prepare-reference'
import { PresetPicker } from './preset-picker'
import { RecordImage } from './record-image'
import { FIRST_REFERENCE, MAX_PROMPT_CHARACTERS, selectedVisionFile } from './selection'
import { SIZES, message, type Provider, type ScenePreset, type StoredFile } from './types'

interface Reference {
  key: string
  name: string
  preview: string
  state: 'uploading' | 'ready' | 'failed'
  file: StoredFile | null
  error: string | null
}

/** A picture another page already chose, e.g. a product's photos. */
export interface InitialImage {
  url: string
  name: string
}

const MAX_REFERENCES = 6

export function GenerateDialog({
  providers,
  presets,
  initialImages,
  onOpenChange,
  onSubmitted,
  onConfigure,
}: {
  providers: Provider[]
  presets: ScenePreset[]
  /** Uploaded as soon as the dialog opens, so the user only writes the prompt. */
  initialImages?: InitialImage[]
  onOpenChange: (open: boolean) => void
  onSubmitted: () => Promise<void>
  onConfigure: () => void
}) {
  const usable = providers.filter(
    (provider) => provider.hasApiKey && provider.imageModel.trim() !== '',
  )
  const visionProviders = providers.filter(
    (provider) => provider.hasApiKey && (provider.visionModel ?? '').trim() !== '',
  )
  const [references, setReferences] = useState<Reference[]>([])
  const [presetId, setPresetId] = useState<string | null>(presets[0]?.id ?? null)
  const [prompt, setPrompt] = useState('')
  const [providerChoice, setProviderChoice] = useState('')
  const [visionProviderId, setVisionProviderId] = useState('__none__')
  const [visionChoice, setVisionChoice] = useState(FIRST_REFERENCE)
  const [size, setSize] = useState('1024x1024')
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  /**
   * A handoff can open this dialog before the provider list has arrived, so the
   * first usable provider is a fallback rather than an initial value.
   */
  const providerId = providerChoice === '' ? (usable[0]?.id ?? '') : providerChoice

  const uploading = references.some((entry) => entry.state === 'uploading')
  const mode = references.length > 0 ? 'edit' : 'generate'
  const preset = useMemo(
    () => presets.find((entry) => entry.id === presetId) ?? null,
    [presets, presetId],
  )

  /**
   * Remote pictures are downloaded by the plugin and previewed through its file
   * API after upload. `room` is read from the functional update so
   * a batch never depends on a stale render.
   */
  const addRemote = useCallback(async (images: InitialImage[]) => {
    if (images.length > MAX_REFERENCES) {
      setError(
        `收到 ${images.length} 张图片，本次只载入前 ${MAX_REFERENCES} 张；可移除后重新选择。`,
      )
    }
    const batch = images.slice(0, MAX_REFERENCES)
    setReferences((current) => {
      const room = MAX_REFERENCES - current.length
      return [
        ...current,
        ...batch.slice(0, Math.max(0, room)).map((image, position) => ({
          key: `remote-${image.url}-${String(position)}`,
          name: image.name,
          preview: image.url,
          state: 'uploading' as const,
          file: null,
          error: null,
        })),
      ]
    })
    for (const [index, image] of batch.entries()) {
      const key = `remote-${image.url}-${String(index)}`
      try {
        const stored = await uploadRemoteImage(image.url, image.name)
        setReferences((current) =>
          current.map((entry) =>
            entry.key === key ? { ...entry, state: 'ready', file: stored } : entry,
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
  }, [])

  // Only the first mount of this dialog instance carries a payload: reopening it
  // by hand must not re-upload the same pictures.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    if (initialImages === undefined || initialImages.length === 0) return
    void addRemote(initialImages)
  }, [initialImages, addRemote])

  async function addFiles(files: File[]) {
    const room = MAX_REFERENCES - references.length
    if (room <= 0) {
      setError(`最多 ${String(MAX_REFERENCES)} 张参考图片。`)
      return
    }
    setError(
      files.length > room ? `本次最多再加入 ${room} 张图片，其余图片未加入。` : null,
    )
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
    if (!usable.some((provider) => provider.id === providerId)) {
      setError('请先在模型配置中保存一个服务商。')
      return
    }
    if (presetId === null && prompt.trim() === '') {
      setError('自由提示词不能为空；也可以选择一个场景预设。')
      return
    }
    if (prompt.length > MAX_PROMPT_CHARACTERS) {
      setError(
        `提示词最多 ${MAX_PROMPT_CHARACTERS} 字符，超出内容仍保留在输入框，请自行精简。`,
      )
      return
    }
    if (references.some((entry) => entry.state !== 'ready' || entry.file === null)) {
      setError('有参考图片未上传成功，请重新选择或明确移除后再提交。')
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
      const recognize = visionProviderId !== '__none__'
      if (
        recognize &&
        !visionProviders.some((provider) => provider.id === visionProviderId)
      ) {
        throw new Error('已选识图服务商不可用，请重新选择或明确关闭识图。')
      }
      await generate({
        providerId,
        mode,
        presetId,
        prompt,
        size,
        count,
        inputFileIds: files.map((entry) => entry.id),
        ...(recognize
          ? {
              visionProviderId,
              visionFileId: selectedVisionFile(references, visionChoice),
            }
          : {}),
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
              {references.map((entry, index) => (
                <div key={entry.key} className="ai-thumb">
                  {entry.state === 'ready' && entry.file !== null ? (
                    <RecordImage file={entry.file} alt={entry.name} />
                  ) : entry.preview.startsWith('blob:') ? (
                    <img src={entry.preview} alt={entry.name} />
                  ) : (
                    <span
                      className="flex size-full items-center justify-center text-xs text-muted-foreground"
                      role="img"
                      aria-label={`${entry.name}：${entry.state === 'failed' ? '上传失败' : '正在上传'}`}
                    >
                      {entry.state === 'failed' ? '上传失败' : '正在上传'}
                    </span>
                  )}
                  <span className="absolute bottom-1 left-1 rounded bg-background px-1 text-xs text-foreground">
                    参考图 {index + 1}
                  </span>
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
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="ai-vision-provider">识图服务商 / 模型</FieldLabel>
                <LabeledSelect
                  id="ai-vision-provider"
                  ariaLabel="识图服务商 / 模型"
                  value={visionProviderId}
                  disabled={busy}
                  options={[
                    { value: '__none__', label: '不识图' },
                    ...visionProviders.map((provider) => ({
                      value: provider.id,
                      label: `${provider.name} · ${provider.visionModel ?? ''}`,
                    })),
                    ...(visionProviderId !== '__none__' &&
                    !visionProviders.some((provider) => provider.id === visionProviderId)
                      ? [
                          {
                            value: visionProviderId,
                            label: '已选服务商不可用，请重新选择',
                          },
                        ]
                      : []),
                  ]}
                  onValueChange={setVisionProviderId}
                />
                <FieldDescription>
                  可在模型配置中单独填写识图模型。开启后先识别一张参考图，将观察结果用于生图与文案；失败会停止，不自动换模型。
                </FieldDescription>
              </Field>
              {visionProviderId === '__none__' ? null : (
                <Field>
                  <FieldLabel htmlFor="ai-vision-file">用于识图的参考图</FieldLabel>
                  <LabeledSelect
                    id="ai-vision-file"
                    ariaLabel="用于识图的参考图"
                    value={visionChoice}
                    disabled={busy}
                    options={[
                      { value: FIRST_REFERENCE, label: '第一张参考图' },
                      ...references.map((entry, index) => ({
                        value: entry.key,
                        label: `参考图 ${index + 1} · ${entry.name}${entry.state === 'ready' ? '' : '（尚未上传成功）'}`,
                      })),
                      ...(visionChoice !== FIRST_REFERENCE &&
                      !references.some((entry) => entry.key === visionChoice)
                        ? [{ value: visionChoice, label: '已选图片已移除，请重新选择' }]
                        : []),
                    ]}
                    onValueChange={setVisionChoice}
                  />
                  <FieldDescription>
                    仅这一张发给识图模型；改图仍使用全部已上传参考图。生成完成后也可在详情选择某一张成片重新识图。
                  </FieldDescription>
                </Field>
              )}
            </FieldGroup>
          </section>

          <section className="ai-dialog-column" aria-label="生成设置">
            <PresetPicker
              presets={presets}
              value={presetId}
              disabled={busy}
              onChange={setPresetId}
            />

            <Field data-invalid={prompt.length > MAX_PROMPT_CHARACTERS}>
              <FieldLabel htmlFor="ai-prompt">
                {presetId === null ? '提示词' : '附加要求（可选）'}
              </FieldLabel>
              <Textarea
                id="ai-prompt"
                rows={4}
                aria-invalid={prompt.length > MAX_PROMPT_CHARACTERS}
                aria-describedby="ai-prompt-description"
                disabled={busy}
                placeholder={
                  presetId === null
                    ? '例如：商品放在家用餐桌上，用窗边自然光，保留标签和边角磨损。'
                    : '例如：商品靠左，保留右侧划痕和标签文字，不添加配件。'
                }
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <FieldDescription id="ai-prompt-description">
                {preset === null
                  ? '自由提示词不加预设；开启独立识图时会另附观察结果。'
                  : `预设「${preset.label}」保留实际标识、瑕疵与成色，并完整追加你写的要求。`}{' '}
                {prompt.length} / {MAX_PROMPT_CHARACTERS} 字符，不自动截断。
              </FieldDescription>
              {prompt.length > MAX_PROMPT_CHARACTERS ? (
                <FieldError>超出长度限制，请自行精简；原文已保留。</FieldError>
              ) : null}
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
                  onValueChange={setProviderChoice}
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
            disabled={
              busy ||
              uploading ||
              providerId === '' ||
              prompt.length > MAX_PROMPT_CHARACTERS
            }
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
