import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { FieldError } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import { exportRecord, getRecord, removeRecord, retryRecord } from './api'
import { CompareSlider } from './compare-slider'
import { RecordImage } from './record-image'
import {
  formatDuration,
  formatTime,
  message,
  recordTitle,
  statusText,
  type GenerationRecord,
} from './types'

export function RecordDetailDialog({
  recordId,
  onClose,
  onChanged,
}: {
  recordId: string
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [record, setRecord] = useState<GenerationRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [exported, setExported] = useState<string[]>([])
  const [selected, setSelected] = useState(0)
  const running = record?.status === 'running'

  const load = useCallback(async () => {
    try {
      const result = await getRecord(recordId)
      setRecord(result.record)
      setError(null)
      return result.record
    } catch (cause) {
      setError(message(cause))
      return null
    } finally {
      setLoading(false)
    }
  }, [recordId])

  // The dialog is mounted per record (`key` in the list page), so the initial
  // state is already correct for this record and the first effect only loads it.
  useEffect(() => {
    let active = true
    void getRecord(recordId).then(
      (result) => {
        if (!active) return
        setRecord(result.record)
        setError(null)
        setLoading(false)
      },
      (cause: unknown) => {
        if (!active) return
        setError(message(cause))
        setLoading(false)
      },
    )
    return () => {
      active = false
    }
  }, [recordId])

  // Poll only while the job is still running; a finished record is static.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      void load().then((next) => {
        if (next !== null && next.status !== 'running') void onChanged()
      })
    }, 2500)
    return () => clearInterval(timer)
  }, [running, load, onChanged])

  const output = record?.outputs[selected] ?? record?.outputs[0] ?? null
  const reference = record?.inputs[0] ?? null
  const meta = useMemo(() => {
    if (record === null) return []
    return [
      ['提交时间', formatTime(record.createdAt)],
      ['耗时', formatDuration(record.durationMs)],
      ['方式', record.mode === 'edit' ? '改图（带参考图）' : '文生图'],
      ['预设', record.presetLabel ?? '自由提示词'],
      [
        '服务商',
        `${record.providerName}（${record.providerKind === 'openai' ? 'OpenAI 官方' : 'OpenAI 兼容'}）`,
      ],
      ['生图模型', record.imageModel],
      ['文案模型', record.textModel === '' ? '未配置' : record.textModel],
      ['尺寸', record.size === 'auto' ? '由模型决定' : record.size],
      ['张数', String(record.count)],
      ['参考图', `${String(record.inputs.length)} 张`],
      ['输出', `${String(record.outputs.length)} 张`],
    ]
  }, [record])

  async function copy(text: string, what: string) {
    if (text.trim() === '') return
    if (await copyText(text)) toast.success(`已复制${what}`)
    else toast.error('复制失败，请检查剪贴板权限')
  }

  async function retry() {
    if (record === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await retryRecord(record.id)
      setRecord(result.record)
      await onChanged()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  async function exportImages() {
    if (record === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await exportRecord(record.id)
      setExported(result.paths)
      toast.success(`已导出 ${String(result.paths.length)} 张图片`)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (record === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await removeRecord(record.id)
      await onChanged()
      setConfirming(false)
      onClose()
      toast.success('已删除生成记录')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="ai-dialog ai-detail-dialog">
        <DialogHeader>
          <DialogTitle>{record === null ? '生成详情' : recordTitle(record)}</DialogTitle>
          <DialogDescription>
            {record === null
              ? '正在读取记录…'
              : `${formatTime(record.createdAt)} · ${record.providerName}`}
          </DialogDescription>
        </DialogHeader>

        {loading && record === null ? <Skeleton className="h-72 w-full" /> : null}

        {record === null ? null : (
          <div className="ai-detail-body">
            <section className="ai-detail-media" aria-label="图片对比">
              {output === null ? (
                <div className="ai-detail-placeholder">
                  {running ? (
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
                  afterLabel={`生成图 ${String(selected + 1)}`}
                />
              )}

              {record.outputs.length > 1 ? (
                <div className="ai-output-strip" role="tablist" aria-label="生成结果">
                  {record.outputs.map((file, index) => (
                    <button
                      key={file.id}
                      type="button"
                      role="tab"
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
              {record.error === null ? null : (
                <FieldError role="alert" className="ai-detail-error">
                  {record.error}
                </FieldError>
              )}
              {record.copyError === null ? null : (
                <p className="ai-detail-warning" role="status">
                  文案没有生成：{record.copyError}
                </p>
              )}

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
                  <p>已导出到插件私有目录，可复制路径：</p>
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
            disabled={record === null || busy || running || record.status === 'success'}
            onClick={() => void retry()}
          >
            <RefreshCw data-icon="inline-start" />
            重试
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
          <Button type="button" onClick={onClose}>
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
