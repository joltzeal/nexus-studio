import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  DialogModal,
  Input,
  Select,
  Textarea,
} from '@proxyshard/shardx-ui-kit'
import type { ProductImportReport } from '@nexus/plugin-contracts/products'
import { productApi } from '../../../raccoon/plugins/products/api'
import { productError } from '../../../raccoon/plugins/products/form'

const templates = {
  csv: 'name,title,description,price,currency,category,condition,brand,size,tags,note,status\n',
  json: '[\n  { "name": "", "title": "", "description": "", "price": null, "currency": "USD", "status": "draft" }\n]\n',
}

function downloadTemplate(format: keyof typeof templates) {
  const url = URL.createObjectURL(
    new Blob([templates[format]], { type: 'text/plain;charset=utf-8' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `products-template.${format}`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [content, setContent] = useState('')
  const [report, setReport] = useState<ProductImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError(null)
    try {
      await action(controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted) setError(productError(cause))
    } finally {
      operation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <DialogModal
      open
      size="lg"
      title="导入商品资料"
      isLoading={busy}
      isDisabled={!content.trim()}
      confirmLabel="导入资料"
      onOpenChange={(open) => {
        if (!open && !operation.current) onClose()
      }}
      onConfirm={() =>
        void run(async (signal) => {
          const result = await productApi.import(format, content)
          if (signal.aborted) return
          setReport(result)
          setContent('')
          onImported()
        })
      }
    >
      <div className="flex flex-col gap-3 py-inset">
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {report && (
          <div
            role="status"
            className="flex flex-col gap-2 text-secondary text-text-sub-600"
          >
            <p className="m-0">
              共 {report.total} 行 · 新增 {report.inserted} · 跳过 {report.skipped}
            </p>
            {report.errors.length > 0 && (
              <ul className="m-0 max-h-40 overflow-auto ps-5">
                {report.errors.map((entry) => (
                  <li key={entry.row}>
                    第 {entry.row} 行：{entry.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Select
            size="xsmall"
            label="文件格式"
            value={format}
            disabled={busy}
            options={[
              { value: 'csv', label: 'CSV' },
              { value: 'json', label: 'JSON' },
            ]}
            onChange={(value) => setFormat(value === 'json' ? 'json' : 'csv')}
          />
          <Input
            inputSize="xsmall"
            label="本地文件"
            disabled={busy}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              void run(async (signal) => {
                if (file.size > 512 * 1024) throw new Error('导入文件不能超过 512 KiB。')
                const extension = file.name.split('.').at(-1)?.toLowerCase()
                if (extension !== 'csv' && extension !== 'json')
                  throw new Error('请选择 CSV 或 JSON 文件。')
                const text = await file.text()
                if (signal.aborted) return
                setFormat(extension)
                setContent(text)
                setReport(null)
              })
            }}
          />
          <Button
            type="button"
            size="xsmall"
            mode="ghost"
            variant="neutral"
            onClick={() => downloadTemplate(format)}
          >
            下载模板
          </Button>
        </div>
        <Textarea
          label="商品资料"
          rows={8}
          hint="支持 CSV 或 JSON 文本，最多 512 KiB，不含图片。"
          value={content}
          maxLength={512 * 1024}
          disabled={busy}
          onChange={(event) => setContent(event.target.value)}
        />
      </div>
    </DialogModal>
  )
}
