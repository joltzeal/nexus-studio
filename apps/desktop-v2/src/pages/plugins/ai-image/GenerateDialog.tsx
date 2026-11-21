import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Modal } from '@proxyshard/shardx-ui-kit'
import { PluginFilterRow, PluginSearch } from '../PluginFilterRow'
import {
  generate,
  testProviderImage,
  uploadImage,
} from '../../../raccoon/plugins/ai-image/api'
import {
  modelValue,
  modelOptions,
  resolveModel,
} from '../../../raccoon/plugins/ai-image/model-selection'
import {
  loadPhotoMetadata,
  parsePhotoMetadata,
  savePhotoMetadata,
} from '../../../raccoon/plugins/ai-image/photo-metadata'
import {
  checkReference,
  prepareReference,
} from '../../../raccoon/plugins/ai-image/prepare-reference'
import {
  ReferenceTransfers,
  transferInitialImage,
  MAX_REFERENCES,
  type InitialImage,
} from '../../../raccoon/plugins/ai-image/reference-transfer'
import {
  filterPresets,
  FIRST_REFERENCE,
  MAX_PROMPT_CHARACTERS,
  selectedVisionFile,
} from '../../../raccoon/plugins/ai-image/selection'
import {
  applySceneRecommendation,
  plannedGeneration,
  visionProviderKey,
  type ScenePresetChoice,
} from '../../../raccoon/plugins/ai-image/scene-plan'
import { useScenePlanner } from '../../../raccoon/plugins/ai-image/use-scene-planner'
import {
  AGING_LEVEL_HINT,
  AGING_LEVEL_OPTIONS,
  DEFAULT_AGING_LEVEL,
  SIZES,
  isAgingLevel,
  message,
  type GenerationRecord,
  type GenerationSource,
  type ImageSize,
  type Provider,
  type ProviderCatalog,
  type ScenePreset,
  type StoredFile,
} from '../../../raccoon/plugins/ai-image/types'
import { trackGeneratedProduct } from './import-runtime'
import { usePluginTask } from '../usePluginTask'
import { toast } from '../../../shared/model/toast'
import {
  AiInput,
  AiSelect,
  AiTextarea,
  Failure,
  FullText,
  Section,
  RECOGNITION_LABELS,
} from './fields'
import { PhotoMetadataEditor } from './PhotoMetadataEditor'
import { RecordImage } from './RecordImage'
import { transferSelection } from './transfer-selection'

interface Reference {
  key: string
  name: string
  state: 'uploading' | 'ready' | 'failed'
  file: StoredFile | null
  error: string | null
  local?: File
  remote?: InitialImage
}

export function GenerateDialog({
  catalog,
  presets,
  methods,
  initialImages = [],
  initialPrompt = '',
  source,
  testProvider,
  loadVintedImage,
  onClose,
  onConfigure,
  onModelsChanged,
  onSubmitted,
}: {
  catalog: ProviderCatalog
  presets: ScenePreset[]
  methods: string[]
  initialImages?: InitialImage[]
  initialPrompt?: string
  source?: GenerationSource
  testProvider?: Provider
  loadVintedImage?: (itemId: string, url: string, signal: AbortSignal) => Promise<Blob>
  onClose: () => void
  onConfigure: () => void
  onModelsChanged: () => Promise<void>
  onSubmitted: (record: GenerationRecord) => void
}) {
  const [startingPrompt] = useState(
    initialPrompt ||
      (testProvider
        ? 'A blue ceramic cup on a plain wooden table in natural daylight.'
        : ''),
  )
  const [prompt, setPrompt] = useState(startingPrompt)
  const [origin] = useState(source)
  const [loadSourceImage] = useState(() => loadVintedImage)
  const [imageChoice, setImageChoice] = useState<string | null>(null)
  const [visionChoice, setVisionChoice] = useState<string | null>(null)
  const [visionFile, setVisionFile] = useState(FIRST_REFERENCE)
  const [size, setSize] = useState<ImageSize>('1024x1024')
  const [count, setCount] = useState(1)
  const [aging, setAging] = useState(DEFAULT_AGING_LEVEL)
  const [preset, setPreset] = useState<ScenePresetChoice>({ id: null, revision: 0 })
  const [presetQuery, setPresetQuery] = useState('')
  const [category, setCategory] = useState('')
  const [initialMetadata] = useState(loadPhotoMetadata)
  const [metadataEnabled, setMetadataEnabled] = useState(initialMetadata.enabled)
  const [metadataForm, setMetadataForm] = useState(initialMetadata.form)
  const metadataRef = useRef({ enabled: metadataEnabled, form: metadataForm })
  const [references, setReferences] = useState<Reference[]>(() =>
    initialImages.map((remote, index) => ({
      key: crypto.randomUUID(),
      name: remote.name,
      state: index < MAX_REFERENCES ? 'uploading' : 'failed',
      file: null,
      error: index < MAX_REFERENCES ? null : '超过六张上限，尚未传输，请先移除多余图片',
      remote,
    })),
  )
  const referencesRef = useRef(references)
  const [transfers] = useState(() => new ReferenceTransfers())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const task = usePluginTask()
  const test = !!testProvider
  const canRemote = methods.includes('image.upload.remote')
  const imageValue = testProvider
    ? modelValue({ providerId: testProvider.id, model: testProvider.imageModel })
    : (imageChoice ?? modelValue(catalog.selections.image))
  const visionValue = visionChoice ?? modelValue(catalog.selections.vision)
  const image = resolveModel(catalog.items, 'image', imageValue)
  const vision = resolveModel(catalog.items, 'vision', visionValue)
  const mode = references.length ? 'edit' : 'generate'
  const uploading = references.some((reference) => reference.state === 'uploading')
  let planningFileId = ''
  try {
    planningFileId = selectedVisionFile(references, visionFile)
  } catch {
    planningFileId = ''
  }
  const planContext = {
    providerId: vision?.providerId ?? '',
    model: vision?.model ?? '',
    providerKey: visionProviderKey(vision?.provider),
    inputFileId: planningFileId,
    requirements: prompt,
    count,
    agingLevel: aging,
  }
  const planner = useScenePlanner(
    planContext,
    methods,
    (draft) => setPreset((current) => applySceneRecommendation(current, draft)),
    onModelsChanged,
  )
  const shownPresets = useMemo(
    () => filterPresets(presets, presetQuery, category),
    [presets, presetQuery, category],
  )
  const selectedPreset = presets.find((entry) => entry.id === preset.id)
  const categories = [
    ...new Set(
      presets.map((entry) => entry.category).filter((entry): entry is string => !!entry),
    ),
  ]

  const updateReferences = useCallback(
    (next: Reference[] | ((current: Reference[]) => Reference[])) => {
      const value = typeof next === 'function' ? next(referencesRef.current) : next
      referencesRef.current = value
      setReferences(value)
    },
    [],
  )

  const transfer = useCallback(
    (reference: Reference) => {
      return transfers.start(
        reference.key,
        async (signal) => {
          const metadata = metadataRef.current.enabled
            ? parsePhotoMetadata(metadataRef.current.form)
            : undefined
          if (reference.local) {
            const prepared = await prepareReference(reference.local, signal)
            signal.throwIfAborted()
            return uploadImage(prepared, signal, metadata)
          }
          if (!reference.remote) throw new Error('请重新选择图片')
          if (origin?.pluginId !== 'studio.vinted-monitor' && !canRemote)
            throw new Error('当前插件未提供远程参考图上传，请更新插件或重新选择本地图片')
          return transferInitialImage(
            reference.remote,
            origin,
            signal,
            metadata,
            loadSourceImage ? { loadVintedImage: loadSourceImage } : undefined,
          )
        },
        (file) =>
          updateReferences((current) =>
            current.map((entry) =>
              entry.key === reference.key
                ? { ...entry, file, error: null, state: 'ready' }
                : entry,
            ),
          ),
        (cause) =>
          updateReferences((current) =>
            current.map((entry) =>
              entry.key === reference.key
                ? { ...entry, error: message(cause), state: 'failed' }
                : entry,
            ),
          ),
      )
    },
    [transfers, origin, loadSourceImage, updateReferences, canRemote],
  )
  useEffect(() => {
    metadataRef.current = { enabled: metadataEnabled, form: metadataForm }
    try {
      savePhotoMetadata(metadataEnabled, metadataForm)
    } catch {
      setPreferenceError('相机模板偏好未能保存，本次任务仍使用当前表单')
    }
  }, [metadataEnabled, metadataForm])
  useEffect(() => {
    let active = true
    void transferSelection(
      referencesRef.current
        .slice(0, MAX_REFERENCES)
        .filter((reference) => reference.remote),
      () => active,
      (key) => referencesRef.current.some((reference) => reference.key === key),
      transfer,
    )
    return () => {
      active = false
      transfers.cancelAll()
    }
  }, [transfers, transfer])

  function addFiles(files: File[]) {
    const limit = test ? 1 : MAX_REFERENCES
    if (referencesRef.current.length + files.length > limit) {
      setError(`最多选择 ${limit} 张参考图，本次选择未加入，请重新选择`)
      return
    }
    const entries: Reference[] = files.map((local) => {
      const error = checkReference(local)
      return {
        key: crypto.randomUUID(),
        name: local.name,
        state: error ? 'failed' : 'uploading',
        file: null,
        error,
        local,
      }
    })
    updateReferences((current) => [...current, ...entries])
    setError(null)
    const token = task.begin()
    void transferSelection(
      entries.filter((entry) => !entry.error),
      () => task.current(token),
      (key) => referencesRef.current.some((reference) => reference.key === key),
      transfer,
    )
  }
  function removeReference(key: string) {
    transfers.cancel(key)
    updateReferences((current) => current.filter((entry) => entry.key !== key))
    planner.cancel()
  }
  function retryReference(reference: Reference) {
    if (referencesRef.current.length > (test ? 1 : MAX_REFERENCES)) return
    updateReferences((current) =>
      current.map((entry) =>
        entry.key === reference.key
          ? { ...entry, state: 'uploading', error: null }
          : entry,
      ),
    )
    void transfer(reference)
  }
  async function submit() {
    if (busy || uploading || planner.pending || !task.acquire()) return
    const token = task.begin()
    try {
      setError(null)
      if (catalog.modelConfigVersion !== 2 || !image)
        throw new Error('请选择有效的生图服务商和模型')
      if (prompt.length > MAX_PROMPT_CHARACTERS)
        throw new Error(
          `提示词超过 ${MAX_PROMPT_CHARACTERS} 字符，原文已保留，请自行调整`,
        )
      if (
        references.length > (test ? 1 : MAX_REFERENCES) ||
        references.some((reference) => reference.state !== 'ready' || !reference.file)
      )
        throw new Error('请等待图片上传成功，或明确移除失败及超量的图片')
      if (!test && mode === 'edit' && !vision)
        throw new Error('请选择有效的识图服务商和模型')
      if ((test || mode === 'generate') && !prompt.trim() && !selectedPreset)
        throw new Error('请填写英文提示词或选择场景预设')
      if (!test && planner.smart && !planner.ready)
        throw new Error(
          planner.problem ?? planner.current?.error ?? '请完成场景规划后再提交',
        )
      const ids = references.map((reference) => reference.file!.id)
      setBusy(true)
      const accepted = testProvider
        ? await testProviderImage({
            id: testProvider.id,
            model: testProvider.imageModel,
            mode,
            prompt,
            size,
            agingLevel: aging,
            inputFileIds: ids,
          })
        : await generate({
            ...(planner.smart && planner.draft
              ? plannedGeneration(planner.draft, planContext, ids)
              : mode === 'edit' && vision
                ? {
                    visionProviderId: vision.providerId,
                    visionModel: vision.model,
                    visionFileId: selectedVisionFile(references, visionFile),
                  }
                : {}),
            providerId: image.providerId,
            imageModel: image.model,
            mode,
            presetId: preset.id,
            prompt,
            size,
            count,
            agingLevel: aging,
            inputFileIds: ids,
            ...(metadataEnabled
              ? { photoMetadata: parsePhotoMetadata(metadataForm) }
              : {}),
            ...(origin ? { source: origin } : {}),
          })
      if (!test && mode === 'edit') {
        try {
          trackGeneratedProduct(accepted.record.id)
        } catch (cause) {
          toast.err(
            `任务 ${accepted.record.id} 已提交，自动入库登记失败：${message(cause)}。请从历史手动入库，勿重复生成`,
          )
        }
      }
      void onModelsChanged().catch(() => undefined)
      if (task.current(token)) onSubmitted(accepted.record)
    } catch (cause) {
      if (task.current(token)) setError(message(cause))
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }

  const dirty =
    prompt !== startingPrompt ||
    references.length > 0 ||
    !!imageChoice ||
    !!visionChoice ||
    size !== '1024x1024' ||
    count !== 1 ||
    aging !== DEFAULT_AGING_LEVEL ||
    !!preset.id ||
    metadataEnabled !== initialMetadata.enabled ||
    JSON.stringify(metadataForm) !== JSON.stringify(initialMetadata.form)
  return (
    <Modal
      open
      size="lg"
      title={test ? `测试生图 · ${testProvider.name}` : '创建生图任务'}
      description="任务由插件在后台执行；关闭页面不会取消已接受的任务。真实模型调用可能产生费用，失败不会自动重发。"
      dirty={!busy && dirty}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <Button
            size="xsmall"
            mode="ghost"
            variant="neutral"
            disabled={busy}
            onClick={onConfigure}
          >
            模型配置
          </Button>
          <Button
            size="xsmall"
            disabled={busy || uploading || planner.pending}
            isLoading={busy}
            onClick={() => void submit()}
          >
            {test ? '提交测试生图' : '提交生成'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Failure error={error} />
        <Section title="模型与输出">
          <div className="grid gap-3 sm:grid-cols-2">
            <AiSelect
              label="生图服务商 / 模型"
              value={imageValue}
              options={modelOptions(catalog.items, 'image', imageValue)}
              onChange={setImageChoice}
              disabled={busy || test}
            />
            {!test && (
              <AiSelect
                label="识图服务商 / 模型"
                value={visionValue}
                options={modelOptions(catalog.items, 'vision', visionValue)}
                onChange={setVisionChoice}
                disabled={busy}
                hint="参考图任务需要先识图；也可用智能规划生成多视角方案"
              />
            )}
            <AiSelect
              label="图片尺寸"
              value={size}
              options={SIZES}
              disabled={busy}
              onChange={(value) => {
                if (SIZES.some((size) => size.value === value))
                  setSize(value as ImageSize)
              }}
            />
            {!test && (
              <AiSelect
                label="生成张数"
                value={String(count)}
                options={[1, 2, 3, 4].map((value) => ({
                  value: String(value),
                  label: `${value} 张`,
                }))}
                disabled={busy}
                onChange={(value) => setCount(Number(value))}
              />
            )}
            <AiSelect
              label="做旧程度"
              value={aging}
              options={AGING_LEVEL_OPTIONS}
              disabled={busy}
              onChange={(value) => {
                if (isAgingLevel(value)) setAging(value)
              }}
            />
          </div>
          <p className="m-0 text-secondary text-text-sub-600">{AGING_LEVEL_HINT}</p>
        </Section>
        <Section title={`参考图片 · ${references.length}/${test ? 1 : MAX_REFERENCES}`}>
          <AiInput
            label="添加参考图片"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple={!test}
            disabled={busy || uploading}
            hint="PNG、JPEG、WebP，单张最多 8 MiB"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              addFiles(files)
            }}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {references.map((reference) => (
              <div
                key={reference.key}
                className="min-w-0 rounded-control border border-stroke-soft-200 p-2"
              >
                {reference.file && (
                  <RecordImage
                    file={reference.file}
                    alt={reference.name}
                    className="h-28 w-full"
                  />
                )}
                <p className="my-2 break-words text-secondary">{reference.name}</p>
                <p className="my-2 break-words text-help text-text-sub-600">
                  {reference.error ??
                    (reference.state === 'ready' ? '已上传' : '正在上传')}
                </p>
                <div className="flex gap-2">
                  {reference.state === 'failed' && (
                    <Button
                      size="xsmall"
                      mode="stroke"
                      variant="neutral"
                      disabled={busy}
                      onClick={() => retryReference(reference)}
                    >
                      重试上传
                    </Button>
                  )}
                  <Button
                    size="xsmall"
                    mode="ghost"
                    variant="neutral"
                    disabled={busy}
                    onClick={() => removeReference(reference.key)}
                  >
                    移除
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {!test && references.length > 0 && (
            <AiSelect
              label="用于识图的参考图"
              value={visionFile}
              options={[
                { value: FIRST_REFERENCE, label: '第一张参考图' },
                ...references.map((reference) => ({
                  value: reference.key,
                  label: reference.name,
                })),
              ]}
              onChange={setVisionFile}
              disabled={busy}
            />
          )}
        </Section>
        {!test && (
          <Section title="场景预设">
            <PluginFilterRow label="场景预设筛选">
              <PluginSearch
                className="border border-stroke-soft-200"
                label="搜索场景"
                placeholder="名称、分类、英文提示词"
                value={presetQuery}
                onChange={(event) => setPresetQuery(event.target.value)}
              />
              <AiSelect
                className="w-[144px]!"
                label="场景分类"
                value={category}
                options={[
                  { value: '', label: '全部分类' },
                  ...categories.map((value) => ({ value, label: value })),
                ]}
                onChange={setCategory}
              />
            </PluginFilterRow>
            <AiSelect
              label={`场景预设 · ${shownPresets.length} 个匹配`}
              value={preset.id ?? ''}
              options={[
                { value: '', label: '自动场景 / 自由提示词' },
                ...shownPresets.map((entry) => ({
                  value: entry.id,
                  label: entry.label,
                  hint: entry.hint,
                })),
                ...(selectedPreset &&
                !shownPresets.some((entry) => entry.id === selectedPreset.id)
                  ? [
                      {
                        value: selectedPreset.id,
                        label: selectedPreset.label,
                        hint: '当前选择不在筛选结果中',
                      },
                    ]
                  : []),
              ]}
              onChange={(id) =>
                setPreset((current) => ({
                  id: id || null,
                  revision: current.revision + 1,
                }))
              }
              disabled={busy}
            />
            {selectedPreset && (
              <details className="rounded-control bg-bg-weak-50 p-3">
                <summary className="cursor-pointer text-secondary">
                  查看完整场景提示词 · {selectedPreset.label}
                </summary>
                <FullText label="场景提示词" text={selectedPreset.prompt} />
              </details>
            )}
          </Section>
        )}
        <AiTextarea
          label={test ? '英文测试提示词' : '商品要求 / 英文自由提示词'}
          rows={6}
          value={prompt}
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          error={
            prompt.length > MAX_PROMPT_CHARACTERS
              ? `超出 ${MAX_PROMPT_CHARACTERS} 字符；原文已保留`
              : undefined
          }
          hint={`${prompt.length}/${MAX_PROMPT_CHARACTERS} 字符；参考图任务会识别商品并转换要求，纯文生图请使用英文`}
        />
        {!test && mode === 'edit' && (
          <Section title="智能识图与多视角规划">
            <div className="flex flex-wrap gap-2">
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={
                  busy ||
                  uploading ||
                  !planner.supported ||
                  !planningFileId ||
                  !vision ||
                  planner.pending
                }
                onClick={() => void planner.start(preset.revision)}
              >
                {planner.pending ? '正在规划' : '识图并推荐场景'}
              </Button>
              {planner.smart && (
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  disabled={busy}
                  onClick={planner.manual}
                >
                  改用普通生成
                </Button>
              )}
              {planner.current?.status === 'read-error' && (
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  onClick={planner.resume}
                >
                  继续读取规划
                </Button>
              )}
              {!planner.smart && planner.ready && (
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  onClick={planner.useExisting}
                >
                  使用已有方案
                </Button>
              )}
            </div>
            {!planner.supported && (
              <p className="m-0 text-secondary text-text-sub-600">
                当前插件未提供场景规划方法，普通生成仍可使用
              </p>
            )}
            {planner.smart && (
              <Failure error={planner.current?.error ?? planner.problem} />
            )}
            {planner.smart && planner.draft && (
              <>
                {planner.draft.plan.result && (
                  <details>
                    <summary className="cursor-pointer text-secondary">
                      查看完整识图结果
                    </summary>
                    {Object.entries(planner.draft.plan.result)
                      .filter(([, value]) => typeof value === 'string')
                      .map(([key, value]) => (
                        <FullText
                          key={key}
                          label={RECOGNITION_LABELS[key] ?? key}
                          text={String(value)}
                        />
                      ))}
                  </details>
                )}
                <AiTextarea
                  label="共享场景提示词"
                  rows={5}
                  disabled={busy}
                  value={planner.draft.prompt}
                  onChange={(event) => {
                    if (planner.draft)
                      planner.setDraft({ ...planner.draft, prompt: event.target.value })
                  }}
                />
                {planner.draft.views.map((view, index) => (
                  <div
                    key={view.id}
                    className="flex flex-col gap-3 rounded-control border border-stroke-soft-200 p-3"
                  >
                    <AiInput
                      label={`视角 ${index + 1} 名称`}
                      value={view.label}
                      disabled={busy}
                      onChange={(event) => {
                        if (planner.draft)
                          planner.setDraft({
                            ...planner.draft,
                            views: planner.draft.views.map((entry) =>
                              entry.id === view.id
                                ? { ...entry, label: event.target.value }
                                : entry,
                            ),
                          })
                      }}
                    />
                    <AiTextarea
                      label="完整视角要求"
                      rows={4}
                      value={view.prompt}
                      disabled={busy}
                      onChange={(event) => {
                        if (planner.draft)
                          planner.setDraft({
                            ...planner.draft,
                            views: planner.draft.views.map((entry) =>
                              entry.id === view.id
                                ? { ...entry, prompt: event.target.value }
                                : entry,
                            ),
                          })
                      }}
                    />
                  </div>
                ))}
              </>
            )}
          </Section>
        )}
        {!test && (
          <Section title="图片元数据">
            <PhotoMetadataEditor
              enabled={metadataEnabled}
              form={metadataForm}
              disabled={busy}
              supported={catalog.photoMetadataVersion === 1}
              onEnabled={setMetadataEnabled}
              onChange={setMetadataForm}
            />
            <Failure error={preferenceError} />
            {catalog.photoMetadataVersion !== 1 && (
              <p className="m-0 text-secondary text-text-sub-600">
                当前插件未声明 EXIF 模板支持
              </p>
            )}
          </Section>
        )}
        {origin && (
          <Alert status="information" variant="lighter">
            来源：{origin.title} · {origin.pluginId}/{origin.itemId}
          </Alert>
        )}
      </div>
    </Modal>
  )
}
