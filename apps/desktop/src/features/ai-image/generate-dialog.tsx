import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { ImagePlus, Loader2, Sparkles, X } from 'lucide-react'
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
import { generate, uploadImage } from './api'
import { checkReference, prepareReference } from './prepare-reference'
import { PresetPicker } from './preset-picker'
import { RecordImage } from './record-image'
import { FIRST_REFERENCE, MAX_PROMPT_CHARACTERS, selectedVisionFile } from './selection'
import {
  MAX_REFERENCES,
  ReferenceTransfers,
  transferInitialImage,
  type InitialImage,
} from './reference-transfer'
import { SourceLink } from './source-link'
import { ScenePlanEditor } from './scene-plan-editor'
import {
  plannedGeneration,
  SCENE_PLAN_UPDATE_HINT,
  applySceneRecommendation,
  visionProviderKey,
  type ScenePresetChoice,
} from './scene-plan'
import { useScenePlanner } from './use-scene-planner'
import {
  SIZES,
  message,
  type GenerationSource,
  type Provider,
  type ScenePreset,
  type StoredFile,
} from './types'

export type { InitialImage } from './reference-transfer'

interface Reference {
  key: string
  name: string
  preview: string
  state: 'uploading' | 'ready' | 'failed'
  file: StoredFile | null
  error: string | null
  initialImage?: InitialImage
}

export function GenerateDialog({
  providers,
  presets,
  initialImages,
  source,
  initialPrompt,
  pluginMethods,
  onOpenChange,
  onSubmitted,
  onConfigure,
}: {
  providers: Provider[]
  presets: ScenePreset[]
  /** Uploaded as soon as the dialog opens, so the user only writes the prompt. */
  initialImages?: InitialImage[]
  source?: GenerationSource
  initialPrompt?: string
  pluginMethods?: readonly string[]
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
  const [origin] = useState(source)
  const [initialReferences] = useState<Reference[]>(() =>
    (initialImages ?? []).map((image, index) => ({
      key: crypto.randomUUID(),
      name: image.name,
      preview: '',
      state: index < MAX_REFERENCES ? 'uploading' : 'failed',
      file: null,
      error:
        index < MAX_REFERENCES ? null : '超过六张上限，尚未传输；移除多余图片后可重试。',
      initialImage: image,
    })),
  )
  const [references, setReferences] = useState<Reference[]>(initialReferences)
  const [transfers] = useState(() => new ReferenceTransfers())
  const previews = useRef(new Set<string>())
  const removed = useRef(new Set<string>())
  const mounted = useRef(false)
  const [presetChoice, setPresetChoice] = useState<ScenePresetChoice>({
    id: presets[0]?.id ?? null,
    revision: 0,
  })
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
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
  const planningProviderId =
    visionProviderId === '__none__' ? (visionProviders[0]?.id ?? '') : visionProviderId
  const planningProvider = visionProviders.find(
    (provider) => provider.id === planningProviderId,
  )
  let planningFileId = ''
  let planningFileError: string | null = null
  try {
    planningFileId = selectedVisionFile(references, visionChoice)
  } catch (cause) {
    planningFileError = message(cause)
  }
  const planContext = {
    providerId: planningProviderId,
    providerKey: visionProviderKey(planningProvider),
    inputFileId: planningFileId,
    requirements: prompt,
    count,
  }
  const planner = useScenePlanner(planContext, pluginMethods, (draft) => {
    setPresetChoice((current) => applySceneRecommendation(current, draft))
  })
  const presetId = presetChoice.id
  function setPresetId(id: string | null) {
    setPresetChoice((current) => ({
      id,
      revision: current.revision + 1,
    }))
  }
  const preset = useMemo(
    () => presets.find((entry) => entry.id === presetId) ?? null,
    [presets, presetId],
  )

  const transfer = useCallback(
    (entry: Reference) =>
      transfers.start(
        entry.key,
        (signal) => {
          if (entry.initialImage === undefined) {
            return Promise.reject(new Error('请重新选择本地图片。'))
          }
          return transferInitialImage(entry.initialImage, origin, signal)
        },
        (stored) =>
          setReferences((current) =>
            current.map((item) =>
              item.key === entry.key
                ? { ...item, state: 'ready', file: stored, error: null }
                : item,
            ),
          ),
        (cause) =>
          setReferences((current) =>
            current.map((item) =>
              item.key === entry.key
                ? { ...item, state: 'failed', error: message(cause) }
                : item,
            ),
          ),
      ),
    [origin, transfers],
  )

  useEffect(() => {
    mounted.current = true
    let active = true
    void (async () => {
      for (const entry of initialReferences.slice(0, MAX_REFERENCES)) {
        if (!active) break
        if (removed.current.has(entry.key)) continue
        await transfer(entry)
      }
    })()
    const urls = previews.current
    return () => {
      mounted.current = false
      active = false
      transfers.cancelAll()
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [initialReferences, transfer, transfers])

  function retryTransfer(entry: Reference) {
    if (busy || references.length > MAX_REFERENCES) return
    setReferences((current) =>
      current.map((item) =>
        item.key === entry.key ? { ...item, state: 'uploading', error: null } : item,
      ),
    )
    void transfer(entry)
  }

  async function addFiles(files: File[]) {
    const room = MAX_REFERENCES - references.length
    if (room <= 0) {
      setError(`最多 ${String(MAX_REFERENCES)} 张参考图片。`)
      return
    }
    setError(
      files.length > room ? `本次最多再加入 ${room} 张图片，其余图片未加入。` : null,
    )
    // Reserve the whole batch before awaiting so removal and another selection
    // cannot reintroduce a removed file or overbook the six slots.
    const batch = files.slice(0, room).map((file) => {
      const invalid = checkReference(file)
      const preview = URL.createObjectURL(file)
      previews.current.add(preview)
      const entry: Reference = {
        key: crypto.randomUUID(),
        name: file.name,
        preview,
        state: invalid === null ? 'uploading' : 'failed',
        file: null,
        error: invalid,
      }
      return { file, entry }
    })
    setReferences((current) => [...current, ...batch.map(({ entry }) => entry)])
    await Promise.all(
      batch.map(({ file, entry }) => {
        if (entry.error !== null) return Promise.resolve()
        return transfers.start(
          entry.key,
          async (signal) => {
            const prepared = await prepareReference(file, signal)
            signal.throwIfAborted()
            return uploadImage(prepared, signal)
          },
          (stored) =>
            setReferences((current) =>
              current.map((item) =>
                item.key === entry.key ? { ...item, state: 'ready', file: stored } : item,
              ),
            ),
          (cause) =>
            setReferences((current) =>
              current.map((item) =>
                item.key === entry.key
                  ? { ...item, state: 'failed', error: message(cause) }
                  : item,
              ),
            ),
        )
      }),
    )
  }

  function remove(key: string) {
    const selectedKey =
      visionChoice === FIRST_REFERENCE ? references[0]?.key : visionChoice
    if (key === selectedKey) planner.cancel()
    removed.current.add(key)
    transfers.cancel(key)
    const target = references.find((entry) => entry.key === key)
    if (target?.preview.startsWith('blob:')) {
      URL.revokeObjectURL(target.preview)
      previews.current.delete(target.preview)
    }
    setReferences((current) => current.filter((entry) => entry.key !== key))
  }

  async function submit() {
    if (busy || uploading || planner.pending) return
    if (planner.smart && !planner.ready) {
      setError(planner.current?.error ?? planner.problem ?? '请等待场景方案完成。')
      return
    }
    if (references.length > MAX_REFERENCES) {
      setError('最多六张参考图片，请明确移除多余图片后再提交。')
      return
    }
    if (!usable.some((provider) => provider.id === providerId)) {
      setError('请先在模型配置中保存一个服务商。')
      return
    }
    if (!planner.smart && presetId === null && prompt.trim() === '') {
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
      const recognize = !planner.smart && visionProviderId !== '__none__'
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
        ...(origin === undefined ? {} : { source: origin }),
        ...(planner.smart && planner.draft
          ? plannedGeneration(
              planner.draft,
              planContext,
              files.map((entry) => entry.id),
            )
          : {}),
        ...(recognize
          ? {
              visionProviderId,
              visionFileId: selectedVisionFile(references, visionChoice),
            }
          : {}),
      })
      if (!mounted.current) return
      await onSubmitted()
      if (!mounted.current) return
      toast.success('已提交生成任务，记录里可以查看进度')
      onOpenChange(false)
    } catch (cause) {
      if (mounted.current) setError(message(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!busy) {
          if (!open) planner.cancel()
          onOpenChange(open)
        }
      }}
    >
      <DialogContent className="ai-dialog">
        <DialogHeader>
          <DialogTitle>AI 生图</DialogTitle>
          <DialogDescription>
            上传一张或多张参考图会走改图接口；不上传图片则按提示词直接生成。每次生成都会写入记录。
          </DialogDescription>
        </DialogHeader>

        {origin === undefined ? null : <SourceLink source={origin} />}

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
              支持 JPEG、PNG、WebP，单张不超过 8 MB；本地选图会缩到最长边 1536 像素。
              Vinted 商品图会先下载到本机并转为 JPEG，再作为参考图改图。
              不上传图片时按文生图处理。
            </FieldDescription>
            {references.length > MAX_REFERENCES ? (
              <FieldError role="alert">
                收到 {references.length} 张图片，最多使用六张；请移除多余图片。
                尚未传输的图片保留在列表中，选择完成后可重试传输。
              </FieldError>
            ) : null}
            {references.some((entry) => entry.error !== null) ? (
              <FieldError>
                {references
                  .filter((entry) => entry.error !== null)
                  .map((entry) => `${entry.name}：${entry.error ?? ''}`)
                  .join('；')}
              </FieldError>
            ) : null}
            {references
              .filter((entry) => entry.state === 'failed' && entry.initialImage)
              .map((entry) => (
                <Button
                  key={entry.key}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || references.length > MAX_REFERENCES}
                  onClick={() => retryTransfer(entry)}
                >
                  重试传输 {entry.name}
                </Button>
              ))}
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="ai-vision-provider">识图服务商 / 模型</FieldLabel>
                <LabeledSelect
                  id="ai-vision-provider"
                  ariaLabel="识图服务商 / 模型"
                  value={planner.smart ? planningProviderId : visionProviderId}
                  disabled={busy}
                  options={[
                    ...(planner.smart ? [] : [{ value: '__none__', label: '不识图' }]),
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
                  onValueChange={(value) => {
                    const nextId =
                      value === '__none__' ? (visionProviders[0]?.id ?? '') : value
                    if (nextId !== planningProviderId) planner.cancel()
                    setVisionProviderId(value)
                  }}
                />
                <FieldDescription>
                  {planner.smart
                    ? '用于识别商品并推荐场景和视角，完成后可编辑方案。'
                    : '手动模式可选择先识图再生成；也可点击智能识图，先编辑推荐的场景与视角。'}{' '}
                  <button
                    type="button"
                    className="ai-link"
                    disabled={busy}
                    onClick={onConfigure}
                  >
                    模型配置
                  </button>
                </FieldDescription>
              </Field>
              {references.length === 0 &&
              visionProviderId === '__none__' &&
              !planner.smart ? null : (
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
                    onValueChange={(value) => {
                      const next =
                        value === FIRST_REFERENCE
                          ? references[0]
                          : references.find((entry) => entry.key === value)
                      if ((next?.file?.id ?? '') !== planningFileId) planner.cancel()
                      setVisionChoice(value)
                    }}
                  />
                  <FieldDescription>
                    仅这一张发给识图模型；生成时保留已上传的参考图。
                  </FieldDescription>
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="ai-count">
                  {planner.smart ? '生成视角数' : '生成张数'}
                </FieldLabel>
                <Input
                  id="ai-count"
                  type="number"
                  min={1}
                  max={4}
                  step={1}
                  className="ai-count-input"
                  disabled={busy}
                  value={count}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    const value = Number.isFinite(next)
                      ? Math.min(4, Math.max(1, Math.trunc(next)))
                      : 1
                    if (value !== count) planner.cancel()
                    setCount(value)
                  }}
                />
                <FieldDescription>
                  {planner.smart
                    ? '每个视角生成一张；更改数量后需重新识图，已完成的成片会分别保留。'
                    : '智能识图按此数量规划 1–4 个视角；手动生成沿用服务商的张数设置。'}
                </FieldDescription>
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    busy ||
                    planner.pending ||
                    !planner.supported ||
                    !planningProvider ||
                    !planningFileId ||
                    prompt.length > MAX_PROMPT_CHARACTERS
                  }
                  onClick={() => {
                    setError(null)
                    if (!planner.smart && planner.ready) planner.useExisting()
                    else void planner.start(presetChoice.revision)
                  }}
                >
                  {planner.pending ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <Sparkles data-icon="inline-start" />
                  )}
                  {planner.pending
                    ? '正在智能识图…'
                    : !planner.smart && planner.ready
                      ? '使用已有智能方案'
                      : planner.smart
                        ? '重新识图 / 推荐场景'
                        : '智能识图 / 推荐场景'}
                </Button>
                {planner.smart ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={planner.manual}
                  >
                    返回手动模式
                  </Button>
                ) : null}
              </div>
              <FieldDescription>
                {!planner.supported
                  ? SCENE_PLAN_UPDATE_HINT
                  : planningFileError
                    ? planningFileError
                    : !planningProvider
                      ? '请先配置独立识图模型。'
                      : `智能识图使用 ${planningProvider.name} · ${planningProvider.visionModel ?? ''}；点击后请求一次识图模型。`}
              </FieldDescription>
              {planner.smart && planner.pending ? (
                <p role="status" className="text-xs text-muted-foreground">
                  正在识别商品、材质并规划 {count} 个视角…
                </p>
              ) : null}
              {planner.smart && planner.current?.error ? (
                <FieldError>{planner.current.error}</FieldError>
              ) : null}
              {planner.smart && planner.current?.status === 'read-error' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={planner.resume}
                >
                  重新读取方案
                </Button>
              ) : null}
              {planner.smart && !planner.pending && planner.draft && planner.problem ? (
                <FieldError>{planner.problem}</FieldError>
              ) : null}
              {planner.smart && planner.stale && !planner.draft ? (
                <FieldError>参考图、识图模型、要求或张数已变化，请重新识图。</FieldError>
              ) : null}
            </FieldGroup>
          </section>

          <section className="ai-dialog-column" aria-label="生成设置">
            <PresetPicker
              presets={presets}
              value={presetId}
              disabled={busy}
              onChange={setPresetId}
            />
            {planner.smart && planner.draft ? (
              <ScenePlanEditor
                key={planner.draft.plan.id}
                draft={planner.draft}
                disabled={busy || planner.pending}
                onChange={planner.setDraft}
              />
            ) : null}

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
                onChange={(event) => {
                  if (event.target.value !== prompt) planner.cancel()
                  setPrompt(event.target.value)
                }}
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
            onClick={() => {
              planner.cancel()
              onOpenChange(false)
            }}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={
              busy ||
              uploading ||
              references.some(
                (entry) => entry.state !== 'ready' || entry.file === null,
              ) ||
              references.length > MAX_REFERENCES ||
              providerId === '' ||
              prompt.length > MAX_PROMPT_CHARACTERS ||
              (planner.smart && !planner.ready)
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
