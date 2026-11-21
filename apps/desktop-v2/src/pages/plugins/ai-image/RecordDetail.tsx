import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Alert, AlertModal, Button, Modal, Slider } from '@proxyshard/shardx-ui-kit'
import {
  exportRecord,
  getRecord,
  recognizeRecord,
  removeRecord,
  retryRecord,
} from '../../../raccoon/plugins/ai-image/api'
import { importGenerationProduct } from '../../../raccoon/plugins/ai-image/product-import'
import {
  modelOptions,
  modelValue,
  resolveModel,
} from '../../../raccoon/plugins/ai-image/model-selection'
import { RecordSession } from '../../../raccoon/plugins/ai-image/record-session'
import { selectedRecordMedia } from '../../../raccoon/plugins/ai-image/selection'
import { safeSourceUrl } from '../../../raccoon/plugins/ai-image/source'
import {
  AGING_LEVEL_OPTIONS,
  formatDuration,
  formatTime,
  message,
  recordTitle,
  statusText,
  viewStatusText,
  type GenerationRecord,
  type ProviderCatalog,
} from '../../../raccoon/plugins/ai-image/types'
import { toast } from '../../../shared/model/toast'
import { usePluginTask } from '../usePluginTask'
import { AiSelect, Failure, FullText, Section, RECOGNITION_LABELS } from './fields'
import { RecordImage } from './RecordImage'

export function RecordDetail({
  id,
  catalog,
  canExport,
  canImport,
  onClose,
  onChanged,
}: {
  id: string
  catalog: ProviderCatalog | null
  canExport: boolean
  canImport: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [record, setRecord] = useState<GenerationRecord | null>(null)
  const [session] = useState(() => new RecordSession(getRecord))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [selected, setSelected] = useState(0)
  const [selectedView, setSelectedView] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [paths, setPaths] = useState<string[]>([])
  const [compare, setCompare] = useState(false)
  const [reveal, setReveal] = useState(50)
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const changed = useRef(onChanged)
  const task = usePluginTask()
  useEffect(() => {
    changed.current = onChanged
  }, [onChanged])
  useEffect(() => {
    void session.open(id, {
      onRecord: setRecord,
      onError: setError,
      onSettled: () =>
        changed
          .current()
          .catch((cause) => setError(`任务已结束，但列表刷新失败：${message(cause)}`)),
    })
    return () => session.close()
  }, [id, session])
  const running =
    record?.status === 'running' || record?.outputVision?.status === 'running'
  const media = selectedRecordMedia(record, selected, selectedView)
  const visionValue = model ?? modelValue(catalog?.selections.vision ?? null)
  const vision = resolveModel(catalog?.items ?? [], 'vision', visionValue)
  const configReady = catalog?.modelConfigVersion === 2

  async function action(run: (revision: number) => Promise<void>) {
    if (!task.acquire()) return
    const token = task.begin()
    const revision = session.beginAction()
    setBusy(true)
    setError(null)
    try {
      await run(revision)
    } catch (cause) {
      if (task.current(token)) setError(message(cause))
    } finally {
      task.release()
      session.resume(revision)
      if (task.current(token)) setBusy(false)
    }
  }
  async function refreshList() {
    try {
      await onChanged()
    } catch (cause) {
      throw new Error(
        `操作已接受，但列表刷新失败：${message(cause)}。请重新读取，勿重复提交`,
      )
    }
  }
  async function recognize(retry: boolean, revision: number) {
    if (!record || running) return
    if (!retry && (!vision || !media.output)) throw new Error('请选择识图模型和一张成片')
    const result = await recognizeRecord(
      retry
        ? { id, retry: true }
        : {
            id,
            providerId: vision!.providerId,
            model: vision!.model,
            fileId: media.output!.id,
          },
    )
    session.accept(revision, result.record)
    await refreshList()
  }
  async function remove(revision: number) {
    const result = await removeRecord(id)
    if (!session.isCurrent(revision)) return
    if (!result.removed) throw new Error('记录未删除，请重新读取后核对')
    setConfirming(false)
    await onChanged().catch(() => toast.err('记录已删除，但列表刷新失败'))
    onClose()
  }
  async function importProduct(revision: number) {
    const result = await importGenerationProduct(id)
    if (session.isCurrent(revision))
      setImportStatus(
        result.alreadyImported
          ? '该批次已在商品库中，保留现有商品资料'
          : '整组图片及英文文案已加入商品库草稿',
      )
  }
  const sourceUrl = record?.source ? safeSourceUrl(record.source.url) : null
  const facts = record
    ? [
        ['批次标识', record.id],
        ['提交时间', formatTime(record.createdAt)],
        ['耗时', formatDuration(record.durationMs)],
        ['生图模型', `${record.providerName} · ${record.imageModel}`],
        ['图片尺寸', record.size],
        ['方式', record.mode === 'edit' ? '参考图生成' : '文生图'],
        [
          '做旧程度',
          AGING_LEVEL_OPTIONS.find((option) => option.value === record.agingLevel)
            ?.label ?? '旧记录未保存',
        ],
        ['输出图片', `${record.outputs.length}/${record.count}`],
      ]
    : []

  return (
    <>
      <Modal
        open
        size="lg"
        title={record ? recordTitle(record) : '生成记录'}
        description={record ? statusText(record) : '正在读取完整记录'}
        onClose={onClose}
        footer={
          <>
            <Button
              size="xsmall"
              mode="ghost"
              variant="error"
              disabled={busy || running || !record}
              onClick={() => setConfirming(true)}
            >
              删除记录
            </Button>
            {canExport && (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={busy || !record?.outputs.length}
                onClick={() =>
                  void action(async (revision) => {
                    const result = await exportRecord(id)
                    if (session.isCurrent(revision)) setPaths(result.paths)
                  })
                }
              >
                导出图片
              </Button>
            )}
            {record?.status === 'failed' && (
              <Button
                size="xsmall"
                disabled={busy || running || !configReady}
                onClick={() =>
                  void action(async (revision) => {
                    const result = await retryRecord(id)
                    session.accept(revision, result.record)
                    await refreshList()
                  })
                }
              >
                按原任务重试
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <Failure error={error} />
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            className="self-start"
            disabled={busy}
            onClick={() => {
              setError(null)
              void session.refresh()
            }}
          >
            重新读取记录
          </Button>
          {record && (
            <>
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-secondary">
                {facts.map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-text-sub-600">{key}</dt>
                    <dd className="m-0 break-words text-text-strong-950">{value}</dd>
                  </div>
                ))}
              </dl>
              {record.error && (
                <Alert status="error" variant="lighter">
                  {record.error}
                </Alert>
              )}
              {record.copyError && (
                <Alert status="warning" variant="lighter">
                  文案：{record.copyError}
                </Alert>
              )}
              {record.exportError && (
                <Alert status="warning" variant="lighter">
                  成片已保留，自动导出失败：{record.exportError}。可点击导出图片补写。
                </Alert>
              )}
              {record.source && (
                <div className="flex flex-col gap-2">
                  <FullText
                    label="来源商品"
                    text={`${record.source.title}\n${record.source.pluginId}/${record.source.itemId}`}
                  />
                  {sourceUrl && (
                    <Button
                      size="xsmall"
                      mode="stroke"
                      variant="neutral"
                      className="self-start"
                      onClick={() =>
                        void invoke('external_url_open', { url: sourceUrl }).catch(
                          (cause) => toast.err(`打开来源失败：${message(cause)}`),
                        )
                      }
                    >
                      在浏览器查看来源
                    </Button>
                  )}
                </div>
              )}
              <Section title="生成图片">
                {record.scenePlan ? (
                  <AiSelect
                    label="查看视角"
                    value={media.selectedView?.id ?? ''}
                    onChange={setSelectedView}
                    options={record.scenePlan.views.map((view) => ({
                      value: view.id,
                      label: `${view.label} · ${viewStatusText(view.status)}`,
                    }))}
                  />
                ) : (
                  record.outputs.length > 1 && (
                    <AiSelect
                      label="查看成片"
                      value={String(selected)}
                      onChange={(value) => setSelected(Number(value))}
                      options={record.outputs.map((file, index) => ({
                        value: String(index),
                        label: `${index + 1} · ${file.name}`,
                      }))}
                    />
                  )
                )}
                {media.output ? (
                  <RecordImage
                    file={media.output}
                    alt={media.output.name}
                    className="h-80 w-full"
                  />
                ) : (
                  <p className="m-0 text-secondary text-text-sub-600">
                    {media.selectedView?.error ??
                      (running ? '任务尚未返回当前成片' : '此视角没有成片')}
                  </p>
                )}
                {media.reference && media.output && (
                  <>
                    <Button
                      size="xsmall"
                      mode="stroke"
                      variant="neutral"
                      className="self-start"
                      onClick={() => setCompare((current) => !current)}
                    >
                      {compare ? '收起对比' : '对比参考图与成片'}
                    </Button>
                    {compare && (
                      <div className="flex flex-col gap-3">
                        <div className="relative h-64 overflow-hidden rounded-control">
                          <RecordImage
                            file={media.reference}
                            alt="识图参考图"
                            className="h-64 w-full"
                          />
                          <div
                            className="absolute inset-0"
                            style={{ clipPath: `inset(0 ${100 - reveal}% 0 0)` }}
                          >
                            <RecordImage
                              file={media.output}
                              alt="生成成片"
                              className="h-64 w-full"
                            />
                          </div>
                        </div>
                        <Slider
                          value={reveal}
                          onChange={setReveal}
                          label="拖动对比 · 左侧成片 / 右侧参考图"
                        />
                      </div>
                    )}
                  </>
                )}
                {record.inputs.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-secondary">
                      查看全部参考图 · {record.inputs.length} 张
                    </summary>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      {record.inputs.map((file) => (
                        <div key={file.id}>
                          <RecordImage
                            file={file}
                            alt={file.name}
                            className="h-32 w-full"
                          />
                          <p className="my-1 break-words text-help">{file.name}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </Section>
              <Section title="英文商品文案">
                <FullText label="标题" text={record.title} />
                <FullText label="描述" text={record.description} />
              </Section>
              {record.vision && (
                <details>
                  <summary className="cursor-pointer text-panel-title">
                    参考图识别结果 · {record.vision.providerName} / {record.vision.model}
                  </summary>
                  <div className="mt-3 flex flex-col gap-3">
                    {(
                      [
                        'title',
                        'description',
                        'product',
                        'visibleDesign',
                        'confirmedWear',
                        'uncertainties',
                        'translatedRequirements',
                        'prompt',
                      ] as const
                    ).map((key) => (
                      <FullText
                        key={key}
                        label={RECOGNITION_LABELS[key] ?? key}
                        text={record.vision?.[key]}
                      />
                    ))}
                  </div>
                </details>
              )}
              <Section title="成片识图">
                <AiSelect
                  label="识图服务商 / 模型"
                  value={visionValue}
                  options={modelOptions(catalog?.items ?? [], 'vision', visionValue)}
                  onChange={setModel}
                  disabled={busy || running}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xsmall"
                    mode="stroke"
                    variant="neutral"
                    disabled={busy || running || !media.output || !vision || !configReady}
                    onClick={() => void action((revision) => recognize(false, revision))}
                  >
                    识别当前成片
                  </Button>
                  {record.outputVision?.status === 'failed' && (
                    <Button
                      size="xsmall"
                      mode="ghost"
                      variant="neutral"
                      disabled={busy || running || !configReady}
                      onClick={() => void action((revision) => recognize(true, revision))}
                    >
                      按原模型重试识图
                    </Button>
                  )}
                </div>
                {record.outputVision && (
                  <>
                    <p className="m-0 text-secondary text-text-sub-600">
                      {record.outputVision.providerName} · {record.outputVision.model} ·{' '}
                      {record.outputVision.status} · 图片{' '}
                      {record.outputVision.outputFileId}
                    </p>
                    <Failure error={record.outputVision.error} />
                    {(
                      [
                        'title',
                        'description',
                        'product',
                        'visibleDesign',
                        'confirmedWear',
                        'uncertainties',
                        'translatedRequirements',
                        'prompt',
                      ] as const
                    ).map((key) => (
                      <FullText
                        key={key}
                        label={RECOGNITION_LABELS[key] ?? key}
                        text={record.outputVision?.[key]}
                      />
                    ))}
                  </>
                )}
              </Section>
              <details>
                <summary className="cursor-pointer text-panel-title">
                  完整任务提示词与场景方案
                </summary>
                <div className="mt-3 flex flex-col gap-4">
                  <FullText label="任务提示词" text={record.prompt} />
                  <FullText label="原始要求" text={record.userRequirements} />
                  <FullText label="基础提示词" text={record.basePrompt} />
                  {record.scenePlan && (
                    <>
                      <FullText label="共享场景提示词" text={record.scenePlan.prompt} />
                      {record.scenePlan.plan.result && (
                        <FullText
                          label="原始完整识图方案"
                          text={JSON.stringify(record.scenePlan.plan.result, null, 2)}
                        />
                      )}
                      {record.scenePlan.views.map((view) => (
                        <div
                          key={view.id}
                          className="flex flex-col gap-2 rounded-control border border-stroke-soft-200 p-3"
                        >
                          <p className="m-0 text-secondary">
                            {view.label} · {viewStatusText(view.status)}
                          </p>
                          <FullText label="视角提示词" text={view.prompt} />
                          <FullText label="实际完整提示词" text={view.effectivePrompt} />
                          <Failure error={view.error} />
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </details>
              {record.photoMetadata && (
                <details>
                  <summary className="cursor-pointer text-secondary">
                    任务相机模板快照
                  </summary>
                  <FullText
                    label="EXIF 模板"
                    text={JSON.stringify(record.photoMetadata, null, 2)}
                  />
                </details>
              )}
              <Section title="商品库与导出">
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  className="self-start"
                  disabled={!canImport || busy || running || !record.outputs.length}
                  onClick={() => void action(importProduct)}
                >
                  将整组图片与文案导入商品库
                </Button>
                {!canImport && (
                  <p className="m-0 text-secondary text-text-sub-600">
                    需要已启用、运行中且支持生图导入的商品管理插件
                  </p>
                )}
                {importStatus && (
                  <Alert status="success" variant="lighter">
                    {importStatus}
                  </Alert>
                )}
                <p className="m-0 text-help text-text-sub-600">
                  重试导入按批次核对已有商品，不覆盖手动资料；导出只复制成片，不再次调用模型。
                </p>
                <FullText
                  label="导出路径"
                  text={(paths.length ? paths : (record.exportedPaths ?? [])).join('\n')}
                />
              </Section>
            </>
          )}
        </div>
      </Modal>
      <AlertModal
        open={confirming}
        status="warning"
        title="删除生成记录及其插件图片？"
        description="已导出的图片和已导入的商品不会删除；此操作无法撤销。"
        confirmLabel="删除记录"
        confirmVariant="error"
        isLoading={busy}
        onClose={() => {
          if (!busy) setConfirming(false)
        }}
        onConfirm={() => void action(remove)}
      />
    </>
  )
}
