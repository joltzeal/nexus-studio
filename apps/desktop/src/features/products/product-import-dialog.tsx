import { useEffect, useRef, useState } from 'react'
import type { ProductImportReport } from '@nexus/plugin-products/contracts'
import { Download, Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { importProductText } from './api'
import { productError } from './product-form'

const MAX_IMPORT_BYTES = 512 * 1024
const TEMPLATE_FIELDS = [
  'name',
  'title',
  'description',
  'sku',
  'price',
  'currency',
  'category',
  'condition',
  'brand',
  'size',
  'tags',
  'note',
  'status',
] as const

function downloadTemplate(format: 'csv' | 'json') {
  const content =
    format === 'csv'
      ? `\uFEFF${TEMPLATE_FIELDS.join(',')}\r\n`
      : JSON.stringify(
          [
            {
              name: '',
              title: '',
              description: '',
              sku: '',
              price: null,
              currency: 'USD',
              category: '',
              condition: '',
              brand: '',
              size: '',
              tags: [],
              note: '',
              status: 'draft',
            },
          ],
          null,
          2,
        )
  const url = URL.createObjectURL(
    new Blob([content], {
      type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
    }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `raccoon-products-template.${format}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ProductImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [content, setContent] = useState('')
  const [fileName, setFileName] = useState('')
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ProductImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const readSequence = useRef(0)
  const pending = useRef(false)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      readSequence.current += 1
    }
  }, [])

  async function readFile(file: File) {
    const sequence = ++readSequence.current
    setReading(true)
    setReport(null)
    setError(null)
    try {
      if (file.size > MAX_IMPORT_BYTES)
        throw new Error('文件不能超过 512 KB，请拆分后导入。')
      const value = await file.text()
      if (!active.current || sequence !== readSequence.current) return
      if (new TextEncoder().encode(value).byteLength > MAX_IMPORT_BYTES)
        throw new Error('文件内容不能超过 512 KB，请拆分后导入。')
      setContent(value)
      setFileName(file.name)
      if (/\.json$/i.test(file.name)) setFormat('json')
      else if (/\.csv$/i.test(file.name)) setFormat('csv')
    } catch (cause) {
      if (active.current && sequence === readSequence.current)
        setError(productError(cause))
    } finally {
      if (active.current && sequence === readSequence.current) setReading(false)
    }
  }

  async function submit() {
    if (pending.current || reading) return
    if (!content.trim()) {
      setError('请选择文件或粘贴需要导入的商品资料。')
      return
    }
    if (new TextEncoder().encode(content).byteLength > MAX_IMPORT_BYTES) {
      setError('导入内容不能超过 512 KB，请拆分后导入。')
      return
    }
    pending.current = true
    setBusy(true)
    setError(null)
    setReport(null)
    try {
      const result = await importProductText(format, content)
      if (!active.current) return
      setReport(result)
      onImported()
    } catch (cause) {
      if (active.current) setError(productError(cause))
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-3xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>导入商品资料</DialogTitle>
          <DialogDescription>
            仅导入 CSV / JSON 中的文字资料，不读取图片路径、下载远程图片或调用 AI。
            图片请在导入后的商品编辑器中添加。单次内容不超过 512 KB。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-disabled={busy || reading || undefined}>
            <FieldLabel htmlFor="product-import-format">文件格式</FieldLabel>
            <LabeledSelect
              id="product-import-format"
              ariaLabel="商品导入格式"
              value={format}
              options={[
                { value: 'csv', label: 'CSV' },
                { value: 'json', label: 'JSON' },
              ]}
              disabled={busy || reading}
              onValueChange={(value) => {
                if (value === 'csv' || value === 'json') {
                  setFormat(value)
                  setReport(null)
                }
              }}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {(['csv', 'json'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                variant="outline"
                onClick={() => {
                  try {
                    downloadTemplate(value)
                  } catch (cause) {
                    setError(`模板下载失败：${productError(cause)}`)
                  }
                }}
              >
                <Download data-icon="inline-start" />
                下载 {value.toUpperCase()} 模板
              </Button>
            ))}
          </div>
          <Field data-disabled={busy || reading || undefined}>
            <FieldLabel htmlFor="product-import-file">选择文件</FieldLabel>
            <Input
              id="product-import-file"
              type="file"
              accept=".csv,.json,text/csv,application/json"
              disabled={busy || reading}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void readFile(file)
              }}
            />
            <FieldDescription>
              CSV 需包含表头；JSON 为商品对象数组。名称必填、分类选填，
              草稿可暂不填写英文标题、描述与价格。
              {fileName && ` 当前文件：${fileName}`}
            </FieldDescription>
          </Field>
          <Field data-disabled={busy || reading || undefined}>
            <FieldLabel htmlFor="product-import-content">导入内容</FieldLabel>
            <Textarea
              id="product-import-content"
              value={content}
              rows={7}
              disabled={busy || reading}
              onChange={(event) => {
                setContent(event.target.value)
                setFileName('')
                setReport(null)
              }}
              placeholder={
                format === 'csv' ? '粘贴带表头的 CSV 内容' : '粘贴 JSON 商品数组'
              }
            />
            <FieldDescription>
              price 留空或为 null；currency 支持 USD / GBP / EUR； status 支持 draft /
              ready / archived。标签在 JSON 中使用数组，CSV 中使用分号分隔。
              文件不带图片，待上架记录需先作为草稿导入后补图。
            </FieldDescription>
          </Field>
        </FieldGroup>
        {reading && (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取文件…
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>导入未完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {report && (
          <div className="flex min-w-0 flex-col gap-3">
            <Alert role="status">
              <AlertTitle>导入结果</AlertTitle>
              <AlertDescription>
                共 {report.total} 行 · 新增 {report.inserted} · 跳过（含错误）
                {report.skipped}
                {'（其中错误 '}
                {report.errors.length}
                {' 行）'}
              </AlertDescription>
            </Alert>
            {report.errors.length > 0 && (
              <div className="max-h-48 overflow-auto">
                <Table aria-label="商品导入逐行错误">
                  <TableHeader>
                    <TableRow>
                      <TableHead>行号</TableHead>
                      <TableHead>原因</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.errors.map((item, index) => (
                      <TableRow key={`${String(item.row)}:${String(index)}`}>
                        <TableCell>{item.row}</TableCell>
                        <TableCell className="whitespace-normal break-words">
                          {item.message}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          <Button
            type="button"
            disabled={busy || reading || !content.trim()}
            onClick={() => void submit()}
          >
            {busy && <Loader2 data-icon="inline-start" className="animate-spin" />}
            {busy ? '导入中…' : '导入资料'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
