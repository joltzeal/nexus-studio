import { useLayoutEffect, useRef, useState } from 'react'
import { Copy, Download, Loader2, RefreshCw, Trash2 } from 'lucide-react'
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import {
  exportRecord,
  getRecord,
  recognizeRecord,
  removeRecord,
  retryRecord,
} from './api'
import { CompareSlider } from './compare-slider'
import { RecordImage } from './record-image'
import { SourceLink } from './source-link'
import { ScenePlanRecord } from './scene-plan-record'
import { selectedRecordMedia } from './selection'
import { RecordSession } from './record-session'
import {
  MODEL_CONFIG_UPDATE_HINT,
  modelOptions,
  modelValue,
  resolveModel,
} from './model-selection'
import {
  formatDuration,
  formatTime,
  message,
  recordTitle,
  statusText,
  sceneProgress,
  viewStatusText,
  type GenerationRecord,
  type Provider,
  type ModelSelections,
} from './types'

interface RecordDetailDialogProps {
  recordId: string
  providers: Provider[]
  selections: ModelSelections
  modelConfigReady: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}

export function RecordDetailDialog(props: RecordDetailDialogProps) {
  return <RecordDetailContent key={props.recordId} {...props} />
}

function RecordDetailContent({
  recordId,
  providers,
  selections,
  modelConfigReady,
  onClose,
  onChanged,
}: RecordDetailDialogProps) {
  const [session] = useState(() => new RecordSession(getRecord))
  const changed = useRef(onChanged)
  const [record, setRecord] = useState<GenerationRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [exported, setExported] = useState<string[]>([])
  const [selected, setSelected] = useState(0)
  const [selectedViewId, setSelectedViewId] = useState('')
  const [visionChoice, setVisionChoice] = useState<string | undefined>(undefined)
  const running =
    record?.status === 'running' || record?.outputVision?.status === 'running'
  const visionProviders = providers.filter(
    (provider) => provider.hasApiKey && (provider.visionModel ?? '') !== '',
  )
  const visionValue = visionChoice ?? modelValue(selections.vision)
  const visionSelection = resolveModel(providers, 'vision', visionValue)

  useLayoutEffect(() => {
    changed.current = onChanged
  }, [onChanged])

  useLayoutEffect(() => {
    void session.open(recordId, {
      onRecord: (next) => {
        setRecord(next)
        setError(null)
        setLoading(false)
      },
      onError: (error) => {
        setError(error)
        setLoading(false)
      },
      onSettled: () => changed.current(),
    })
    return () => session.close()
  }, [recordId, session])

  function load() {
    setLoading(true)
    setError(null)
    void session.refresh()
  }

  function close() {
    session.close()
    onClose()
  }

  function finishAction(revision: number) {
    if (!session.isCurrent(revision)) return
    setBusy(false)
    session.resume(revision)
  }

  const { selectedView, output, outputIndex, reference, referenceId } =
    selectedRecordMedia(record, selected, selectedViewId)
  const progress = record ? sceneProgress(record) : null
  const meta =
    record === null
      ? []
      : [
          ['提交时间', formatTime(record.createdAt)],
          ['耗时', formatDuration(record.durationMs)],
          ['方式', record.mode === 'edit' ? '改图（带参考图）' : '文生图'],
          ['预设', record.presetLabel ?? '自由提示词'],
          [
            '服务商',
            `${record.providerName}（${record.providerKind === 'openai' ? 'OpenAI 官方' : 'OpenAI 兼容'}）`,
          ],
          ['生图模型', record.imageModel],
          [
            '参考图识图',
            record.scenePlan
              ? `${record.scenePlan.plan.providerName} · ${record.scenePlan.plan.model}`
              : record.vision
                ? `${record.vision.providerName} · ${record.vision.model}`
                : '未启用',
          ],
          [
            '识图参考图',
            referenceId
              ? `参考图 ${record.inputs.findIndex((file) => file.id === referenceId) + 1}`
              : '未选择',
          ],
          ['尺寸', record.size === 'auto' ? '由模型决定' : record.size],
          ['张数', String(record.count)],
          ['参考图', `${String(record.inputs.length)} 张`],
          ['输出', `${String(record.outputs.length)} 张`],
        ]

  async function copy(text: string, what: string) {
    if (text.trim() === '') return
    if (await copyText(text)) toast.success(`已复制${what}`)
    else toast.error('复制失败，请检查剪贴板权限')
  }

  async function retry() {
    if (record === null || busy || running) return
    if (!modelConfigReady) {
      setError(MODEL_CONFIG_UPDATE_HINT)
      return
    }
    const revision = session.beginAction()
    setBusy(true)
    setError(null)
    try {
      const result = await retryRecord(record.id)
      if (!session.accept(revision, result.record)) return
      await onChanged()
    } catch (cause) {
      if (session.isCurrent(revision)) setError(message(cause))
    } finally {
      finishAction(revision)
    }
  }

  async function recognize(retry = false) {
    if (record === null || busy || running) return
    if (!modelConfigReady) {
      setError(MODEL_CONFIG_UPDATE_HINT)
      return
    }
    if (!retry && (output === null || !visionSelection)) {
      setError('请选择可用的识图服务商、模型和一张成片。')
      return
    }
    const revision = session.beginAction()
    setBusy(true)
    setError(null)
    try {
      const result = await recognizeRecord(
        retry
          ? { id: record.id, retry: true }
          : {
              id: record.id,
              providerId: visionSelection!.providerId,
              model: visionSelection!.model,
              fileId: output?.id ?? null,
            },
      )
      session.accept(revision, result.record)
      // The accepted task remembers this model even if the detail dialog was closed.
      await onChanged()
      if (session.isCurrent(revision)) toast.success('已提交单张成片识图')
    } catch (cause) {
      if (session.isCurrent(revision)) setError(message(cause))
    } finally {
      finishAction(revision)
    }
  }

  async function exportImages() {
    if (record === null || busy) return
    const revision = session.beginAction()
    setBusy(true)
    setError(null)
    try {
      const result = await exportRecord(record.id)
      if (!session.isCurrent(revision)) return
      setExported(result.paths)
      toast.success(`已导出 ${String(result.paths.length)} 张图片`)
    } catch (cause) {
      if (session.isCurrent(revision)) setError(message(cause))
    } finally {
      finishAction(revision)
    }
  }

  async function remove() {
    if (record === null || busy || running) return
    const revision = session.beginAction()
    setBusy(true)
    setError(null)
    try {
      await removeRecord(record.id)
      if (!session.isCurrent(revision)) return
      await onChanged()
      if (!session.isCurrent(revision)) return
      setConfirming(false)
      toast.success('已删除生成记录')
      close()
    } catch (cause) {
      if (session.isCurrent(revision)) setError(message(cause))
    } finally {
      finishAction(revision)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="ai-dialog ai-detail-dialog">
        <DialogHeader>
          <DialogTitle>{record === null ? '生成详情' : recordTitle(record)}</DialogTitle>
          <DialogDescription>
            {record === null
              ? '正在读取记录…'
              : `${formatTime(record.createdAt)} · ${record.providerName}`}
          </DialogDescription>
        </DialogHeader>

        {!modelConfigReady ? <FieldError>{MODEL_CONFIG_UPDATE_HINT}</FieldError> : null}
        {loading && record === null ? <Skeleton className="h-72 w-full" /> : null}

        {record === null ? null : (
          <div className="ai-detail-body">
            <section className="ai-detail-media" aria-label="图片对比">
              {record.scenePlan ? (
                <Field>
                  <FieldLabel htmlFor="ai-detail-view">生成视角</FieldLabel>
                  <LabeledSelect
                    id="ai-detail-view"
                    ariaLabel="生成视角"
                    value={selectedView?.id ?? ''}
                    onValueChange={setSelectedViewId}
                    options={record.scenePlan.views.map((view) => ({
                      value: view.id,
                      label: `${view.label} · ${viewStatusText(view.status)}`,
                    }))}
                  />
                  <FieldDescription>
                    已完成 {progress?.completed ?? 0} / {progress?.total ?? 0} 个视角。
                    {record.status === 'failed' && record.outputs.length > 0
                      ? '已完成图片保留，可查看或导出；重试仅处理未完成视角。'
                      : ''}
                  </FieldDescription>
                </Field>
              ) : null}
              {output === null ? (
                <div className="ai-detail-placeholder">
                  {selectedView ? (
                    <>
                      {selectedView.status === 'running' ||
                      selectedView.status === 'queued' ? (
                        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                      ) : null}
                      <p>
                        {selectedView.label} · {viewStatusText(selectedView.status)}
                      </p>
                      {selectedView.error ? (
                        <FieldError>{selectedView.error}</FieldError>
                      ) : null}
                    </>
                  ) : running ? (
                    <>
                      <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                      <p>{statusText(record)}…</p>
                    </>
                  ) : (
                    <p>这次生成没有输出图片。</p>
                  )}
                </div>
              ) : (
                <CompareSlider
                  before={reference}
                  after={output}
                  beforeLabel="参考图"
                  afterLabel={selectedView?.label ?? `生成图 ${String(selected + 1)}`}
                />
              )}

              {!record.scenePlan && record.outputs.length > 1 ? (
                <div className="ai-output-strip" role="tablist" aria-label="生成结果">
                  {record.outputs.map((file, index) => (
                    <button
                      key={file.id}
                      type="button"
                      role="tab"
                      aria-label={`选择成片 ${String(index + 1)}`}
                      aria-selected={index === selected}
                      className={
                        index === selected
                          ? 'ai-output-thumb is-active'
                          : 'ai-output-thumb'
                      }
                      onClick={() => setSelected(index)}
                    >
                      <RecordImage file={file} alt={`生成图 ${String(index + 1)}`} />
                    </button>
                  ))}
                </div>
              ) : null}

              {record.inputs.length > 1 ? (
                <div className="ai-output-strip" aria-label="参考图片">
                  {record.inputs.map((file, index) => (
                    <span key={file.id} className="ai-output-thumb is-reference">
                      <RecordImage file={file} alt={`参考图 ${String(index + 1)}`} />
                    </span>
                  ))}
                </div>
              ) : null}

              {record.outputs.length === 0 ? null : (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="ai-output-vision-provider">
                      成片识图服务商 / 模型
                    </FieldLabel>
                    <LabeledSelect
                      id="ai-output-vision-provider"
                      ariaLabel="成片识图服务商 / 模型"
                      value={visionValue}
                      disabled={busy || running || !modelConfigReady}
                      options={modelOptions(providers, 'vision', visionValue)}
                      onValueChange={setVisionChoice}
                    />
                    <FieldDescription>
                      {outputIndex < 0
                        ? '当前视角尚无成片。'
                        : `当前选择成片 ${String(outputIndex + 1)}。`}
                      {record.scenePlan
                        ? '切换上方视角可换图；'
                        : '点击上方缩略图可换图；'}
                      只识别这一张，生成标题、描述和建议提示词，结果单独保留。
                      {visionProviders.length === 0
                        ? '请先在模型配置中填写识图模型。'
                        : ''}
                    </FieldDescription>
                  </Field>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy ||
                      running ||
                      !modelConfigReady ||
                      output === null ||
                      !visionSelection
                    }
                    onClick={() => void recognize()}
                  >
                    识别当前成片
                  </Button>
                  {record.outputVision ? (
                    <div className="flex flex-col gap-2 text-sm" aria-live="polite">
                      <p>
                        成片{' '}
                        {record.outputs.findIndex(
                          (file) => file.id === record.outputVision?.outputFileId,
                        ) + 1}{' '}
                        · {record.outputVision.providerName} · {record.outputVision.model}
                      </p>
                      {record.outputVision.status === 'running' ? (
                        <p>正在识别成片…</p>
                      ) : null}
                      {record.outputVision.description ? (
                        <dl className="space-y-2">
                          {record.outputVision.title ? (
                            <div>
                              <dt className="text-muted-foreground">标题</dt>
                              <dd>{record.outputVision.title}</dd>
                            </div>
                          ) : null}
                          <div>
                            <dt className="text-muted-foreground">描述</dt>
                            <dd className="whitespace-pre-wrap break-words">
                              {record.outputVision.description}
                            </dd>
                          </div>
                          {record.outputVision.prompt ? (
                            <div>
                              <dt className="text-muted-foreground">建议提示词</dt>
                              <dd className="whitespace-pre-wrap break-words">
                                {record.outputVision.prompt}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      ) : null}
                      {record.outputVision.error ? (
                        <FieldError>{record.outputVision.error}</FieldError>
                      ) : null}
                      {record.outputVision.status === 'failed' ? (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy || running || !modelConfigReady}
                          onClick={() => void recognize(true)}
                        >
                          重试成片识图（原模型与原图片）
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </FieldGroup>
              )}

              <div className="ai-detail-status">
                <Badge
                  variant={
                    record.status === 'success'
                      ? 'secondary'
                      : record.status === 'failed'
                        ? 'destructive'
                        : 'outline'
                  }
                >
                  {running ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                  ) : null}
                  {statusText(record)}
                </Badge>
                {reference === null ? null : (
                  <span className="ai-muted">拖动分割线对比参考图与生成图</span>
                )}
              </div>
            </section>

            <section className="ai-detail-side" aria-label="记录信息">
              {record.source ? <SourceLink source={record.source} /> : null}
              {record.scenePlan ? <ScenePlanRecord scene={record.scenePlan} /> : null}
              {record.error === null ? null : (
                <FieldError role="alert" className="ai-detail-error">
                  {record.error}
                </FieldError>
              )}
              {!record.copyError ? null : (
                <p className="ai-detail-warning" role="status">
                  历史任务文案未完成：{record.copyError}
                </p>
              )}

              {record.vision?.description ? (
                <div className="ai-copy-block">
                  <h3>参考图识图结果</h3>
                  <p className="ai-copy-text">{record.vision.description}</p>
                  {record.vision.prompt ? (
                    <>
                      <h3>识图生成的提示词</h3>
                      <p className="ai-copy-text">{record.vision.prompt}</p>
                    </>
                  ) : null}
                </div>
              ) : null}

              <div className="ai-copy-block">
                <div className="ai-form-head">
                  <h3>标题</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={record.title === null}
                    onClick={() => void copy(record.title ?? '', '标题')}
                  >
                    <Copy data-icon="inline-start" />
                    复制
                  </Button>
                </div>
                <p className={record.title === null ? 'ai-muted' : 'ai-copy-text'}>
                  {record.title ?? '没有生成标题'}
                </p>
              </div>

              <div className="ai-copy-block">
                <div className="ai-form-head">
                  <h3>描述</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={record.description === null}
                    onClick={() => void copy(record.description ?? '', '描述')}
                  >
                    <Copy data-icon="inline-start" />
                    复制
                  </Button>
                </div>
                <p className={record.description === null ? 'ai-muted' : 'ai-copy-text'}>
                  {record.description ?? '没有生成描述'}
                </p>
              </div>

              <div className="ai-copy-block">
                <div className="ai-form-head">
                  <h3>提示词</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void copy(record.prompt, '提示词')}
                  >
                    <Copy data-icon="inline-start" />
                    复制
                  </Button>
                </div>
                <p className="ai-copy-text is-prompt">{record.prompt}</p>
              </div>

              <dl className="ai-meta">
                {meta.map(([label, value]) => (
                  <div key={label} className="ai-meta-row">
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>

              {exported.length === 0 ? null : (
                <div className="ai-export-result">
                  <p>图片已导出，可复制完整路径：</p>
                  <code>{exported.join('\n')}</code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void copy(exported.join('\n'), '导出路径')}
                  >
                    <Copy data-icon="inline-start" />
                    复制路径
                  </Button>
                </div>
              )}

              {error === null ? null : <FieldError role="alert">{error}</FieldError>}
            </section>
          </div>
        )}

        {record === null && error !== null ? (
          <FieldError role="alert">
            {error}
            <Button type="button" variant="outline" onClick={() => void load()}>
              重试读取
            </Button>
          </FieldError>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={record === null || busy || running || record.outputs.length === 0}
            onClick={() => void exportImages()}
          >
            <Download data-icon="inline-start" />
            导出图片
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              record === null ||
              !modelConfigReady ||
              busy ||
              running ||
              record.status === 'success' ||
              (progress !== null && progress.completed === progress.total)
            }
            onClick={() => void retry()}
          >
            <RefreshCw data-icon="inline-start" />
            {record?.scenePlan ? '仅重试未完成视角' : '重试'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={record === null || busy || running}
            onClick={() => setConfirming(true)}
          >
            <Trash2 data-icon="inline-start" />
            删除
          </Button>
          <Button type="button" onClick={close}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条生成记录</AlertDialogTitle>
            <AlertDialogDescription>
              记录、提示词与输出图片会一起删除，无法恢复。已导出的文件不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void remove()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
