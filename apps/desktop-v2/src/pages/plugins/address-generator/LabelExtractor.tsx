import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Button, Input, Select } from '@proxyshard/shardx-ui-kit'
import {
  LABEL_MAX_FILES,
  LabelBeginSchema,
  LabelOptionsSchema,
  type LabelJob,
  type LabelOptions,
} from '@nexus/plugin-contracts/vinted-helper'
import { callPlugin } from '../../../raccoon/plugins/call'
import { createLabelsApi } from '../../../raccoon/plugins/address-generator/labels'
import { saveLabelPdf } from '../../../raccoon/plugins/address-generator/label-download'
import {
  DeleteIcon,
  DisplayIcon,
  DocsIcon,
  DownloadIcon,
  RefreshIcon,
  UploadIcon,
} from '../../../shared/icons'
import { PluginRowAction } from '../PluginRowAction'
import { toast } from '../../../shared/model/toast'

const api = createLabelsApi(callPlugin)
const maxBytes = 100 * 1024 * 1024
type LabelFile = {
  id: string
  file: File
  result: { job: LabelJob; bytes: Uint8Array } | null
  error: string | null
}

function retainedBytes(files: LabelFile[]) {
  return files.reduce(
    (total, item) => total + item.file.size + (item.result?.bytes.length ?? 0),
    0,
  )
}

export function LabelExtractor() {
  const [files, setFiles] = useState<LabelFile[]>([])
  const [margin, setMargin] = useState('3')
  const [mode, setMode] = useState('auto')
  const [crop, setCrop] = useState(['0', '0', '105', '148'])
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const optionsId = useId()
  const input = useRef<HTMLInputElement>(null)
  const currentFiles = useRef<LabelFile[]>([])
  const controller = useRef<AbortController | null>(null)
  const sessions = useRef(new Set<string>())
  const alive = useRef(true)
  const locked = useRef(false)
  const savingFile = useRef<string | null>(null)

  useEffect(() => {
    alive.current = true
    const activeSessions = sessions.current
    return () => {
      alive.current = false
      controller.current?.abort()
      for (const id of activeSessions) void api.close(id).catch(() => undefined)
      activeSessions.clear()
      currentFiles.current = []
    }
  }, [])

  function update(next: LabelFile[]) {
    if (!alive.current) return
    currentFiles.current = next
    setFiles(next)
  }
  function patch(id: string, change: Partial<LabelFile>) {
    update(
      currentFiles.current.map((item) =>
        item.id === id ? { ...item, ...change } : item,
      ),
    )
  }
  function options(): LabelOptions | null {
    const parsed = LabelOptionsSchema.safeParse({
      marginMm: margin.trim() ? Number(margin) : NaN,
      cropMm:
        mode === 'manual'
          ? crop.map((value) => (value.trim() ? Number(value) : NaN))
          : null,
    })
    if (!parsed.success) {
      setError('请检查选项：边距须为 0 至小于 52.5 mm，裁剪区右下角须大于左上角')
      setOptionsOpen(true)
      return null
    }
    return parsed.data
  }
  function add(selected: FileList | File[]) {
    if (locked.current || savingFile.current) return
    const next = Array.from(selected)
    if (!next.length) return
    const settings = options()
    if (!settings) return
    if (next.length + currentFiles.current.length > LABEL_MAX_FILES) {
      setError(`最多保留 ${LABEL_MAX_FILES} 个文件，请先移除部分面单`)
      return
    }
    if (
      next.some(
        (file) =>
          !LabelBeginSchema.safeParse({
            filename: file.name,
            size: file.size,
            ...settings,
          }).success,
      )
    ) {
      setError('请选择有效 PDF，每个文件不超过 10 MiB，文件名不超过 240 个字符')
      return
    }
    if (
      retainedBytes(currentFiles.current) +
        next.reduce((total, file) => total + file.size, 0) >
      maxBytes
    ) {
      setError('文件与结果合计不能超过 100 MiB，请先下载并移除部分面单')
      return
    }
    const additions = next.map((file) => ({
      id: crypto.randomUUID(),
      file,
      result: null,
      error: null,
    }))
    update([...currentFiles.current, ...additions])
    void process(additions, settings)
  }
  async function process(targets: LabelFile[], settings: LabelOptions) {
    if (locked.current || savingFile.current || !alive.current) return
    locked.current = true
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setError(null)
    try {
      for (const item of targets) {
        if (abort.signal.aborted) {
          patch(item.id, { error: '处理已取消，可重新提取' })
          continue
        }
        patch(item.id, { result: null, error: null })
        let sessionId: string | null = null
        try {
          const bytes = new Uint8Array(await item.file.arrayBuffer())
          abort.signal.throwIfAborted()
          const job = await api.process(
            { name: item.file.name, bytes },
            settings,
            abort.signal,
            undefined,
            (id) => {
              sessionId = id
              sessions.current.add(id)
            },
          )
          abort.signal.throwIfAborted()
          if (retainedBytes(currentFiles.current) + job.outputSize > maxBytes)
            throw new Error('结果超过 100 MiB 缓存上限，请下载并移除其他面单后重试')
          const output = await api.download(job, abort.signal)
          abort.signal.throwIfAborted()
          patch(item.id, { result: { job, bytes: output } })
        } catch (cause) {
          patch(item.id, {
            error: abort.signal.aborted
              ? '处理已取消，可重新提取'
              : cause instanceof Error
                ? cause.message
                : '面单处理失败，请重试',
          })
        } finally {
          if (sessionId) {
            await api.close(sessionId).catch(() => undefined)
            sessions.current.delete(sessionId)
          }
        }
      }
    } finally {
      controller.current = null
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  function retry(item: LabelFile) {
    if (locked.current || savingFile.current) return
    const settings = options()
    if (settings) void process([item], settings)
  }
  function remove(id: string) {
    if (!locked.current && !savingFile.current)
      update(currentFiles.current.filter((item) => item.id !== id))
  }
  async function download(item: LabelFile) {
    if (!item.result || savingFile.current) return
    savingFile.current = item.id
    setSaving(item.id)
    setError(null)
    try {
      const path = await saveLabelPdf(
        item.file.name,
        item.result.bytes,
        item.result.job.sha256!,
      )
      if (alive.current && path) toast.saved('A6 面单已保存')
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : '保存失败，请重试')
    } finally {
      savingFile.current = null
      if (alive.current) setSaving(null)
    }
  }

  const results = files.filter((item) => item.result || item.error)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h2 className="m-0 text-panel-title text-text-strong-950">面单提取</h2>
        <Button
          size="xsmall"
          mode="ghost"
          variant="neutral"
          leftIcon={<DisplayIcon className="size-3.5" />}
          aria-expanded={optionsOpen}
          aria-controls={optionsId}
          onClick={() => setOptionsOpen((open) => !open)}
        >
          选项
        </Button>
      </div>
      <div id={optionsId} hidden={!optionsOpen}>
        <div className="flex flex-col gap-3 rounded-control bg-bg-weak-50 p-3">
          <div className="grid grid-cols-2 gap-3">
            <Select
              size="xsmall"
              label="提取方式"
              value={mode}
              disabled={busy || !!saving}
              onChange={setMode}
              options={[
                { value: 'auto', label: '自动识别面单' },
                { value: 'manual', label: '指定裁剪区' },
              ]}
            />
            <Input
              label="A6 边距（mm）"
              inputSize="xsmall"
              type="number"
              min={0}
              max={52.4}
              step={0.5}
              value={margin}
              disabled={busy || !!saving}
              onChange={(event) => setMargin(event.target.value)}
            />
          </div>
          {mode === 'manual' && (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {['左（mm）', '上（mm）', '右（mm）', '下（mm）'].map((label, index) => (
                  <Input
                    key={label}
                    label={label}
                    type="number"
                    inputSize="xsmall"
                    min={0}
                    max={2000}
                    step={0.5}
                    value={crop[index]}
                    disabled={busy || !!saving}
                    onChange={(event) =>
                      setCrop((current) =>
                        current.map((value, position) =>
                          position === index ? event.target.value : value,
                        ),
                      )
                    }
                  />
                ))}
              </div>
              <p className="m-0 text-help text-text-soft-400">
                以页面左上角为原点，应用于所选文件的每一页
              </p>
            </div>
          )}
        </div>
      </div>
      {error && (
        <Alert status="error" variant="lighter" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <section
        aria-label="上传面单"
        aria-busy={busy}
        className="flex shrink-0 flex-wrap items-center gap-4 rounded-control border border-dashed border-stroke-soft-200 p-4"
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = busy || saving ? 'none' : 'copy'
        }}
        onDrop={(event) => {
          event.preventDefault()
          add(event.dataTransfer.files)
        }}
      >
        <UploadIcon className="size-5 shrink-0 text-text-soft-400" />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-body text-text-strong-950">
            拖入 PDF 面单，自动提取为 A6
          </p>
          <p className="m-0 mt-1 text-help text-text-soft-400">
            支持多选 · 每个文件不超过 10 MiB
          </p>
        </div>
        <div className="flex items-center gap-2">
          {busy && (
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              onClick={() => controller.current?.abort()}
            >
              取消
            </Button>
          )}
          <Button
            size="xsmall"
            isLoading={busy}
            disabled={busy || !!saving}
            onClick={() => input.current?.click()}
          >
            选择 PDF
          </Button>
        </div>
        <Input
          ref={input}
          wrapperClassName="sr-only"
          type="file"
          accept=".pdf,application/pdf"
          multiple
          aria-label="上传 PDF 面单"
          disabled={busy || !!saving}
          onChange={(event) => {
            if (event.target.files) add(event.target.files)
            event.target.value = ''
          }}
        />
      </section>
      {results.length > 0 && (
        <section aria-label="面单文件" className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <h3 className="m-0 text-body font-medium text-text-strong-950">面单文件</h3>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy || !!saving}
              onClick={() => {
                if (!locked.current && !savingFile.current) update([])
              }}
            >
              清空
            </Button>
          </div>
          <ul className="m-0 flex min-h-0 list-none flex-col gap-1 overflow-y-auto p-0">
            {results.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-3 rounded-control px-3 py-3 hover:bg-bg-hover"
              >
                <DocsIcon className="mt-0.5 size-4 shrink-0 text-text-soft-400" />
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-body text-text-strong-950">
                    {item.file.name}
                  </p>
                  {item.result && (
                    <p className="m-0 mt-1 text-help text-text-soft-400 tabular-nums">
                      A6 · {item.result.job.pageCount} 页 ·{' '}
                      {(item.result.bytes.length / 1024).toFixed(1)} KiB
                    </p>
                  )}
                  {item.result?.job.notes.some(
                    (note) => note.mode === 'full_content',
                  ) && (
                    <p className="m-0 mt-1 text-help text-text-sub-600">
                      部分页面未能隔离面单，已保留整页；可在选项中指定裁剪区后重试
                    </p>
                  )}
                  {item.error && (
                    <p
                      role="alert"
                      className="m-0 mt-1 break-words text-help text-error-text"
                    >
                      {item.error}
                    </p>
                  )}
                </div>
                <div
                  role="group"
                  aria-label={`${item.file.name} 操作`}
                  className="flex shrink-0 items-center gap-1"
                >
                  {item.result && (
                    <PluginRowAction
                      label="下载 A6 面单"
                      icon={<DownloadIcon className="size-3.5" />}
                      disabled={!!saving}
                      isLoading={saving === item.id}
                      onClick={() => void download(item)}
                    />
                  )}
                  <PluginRowAction
                    label="按当前设置重新提取"
                    icon={<RefreshIcon className="size-3.5" />}
                    disabled={busy || !!saving}
                    onClick={() => retry(item)}
                  />
                  <PluginRowAction
                    label="移除面单"
                    icon={<DeleteIcon className="size-3.5" />}
                    variant="error"
                    disabled={busy || !!saving}
                    onClick={() => remove(item.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
