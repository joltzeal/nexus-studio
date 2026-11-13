import { createHash } from 'node:crypto'
import {
  ProductDraftSchema,
  type ProductDraft,
  type ProductImportReport,
} from '../contracts.js'
import { invalidRequest } from './errors.js'

const MAX_ROWS = 1000
const MAX_BYTES = 512 * 1024
const aliases: Record<string, string> = {
  name: 'name',
  productname: 'name',
  名称: 'name',
  商品名称: 'name',
  商品名: 'name',
  title: 'title',
  标题: 'title',
  商品标题: 'title',
  description: 'description',
  描述: 'description',
  商品描述: 'description',
  sku: 'sku',
  货号: 'sku',
  商品编码: 'sku',
  price: 'price',
  价格: 'price',
  售价: 'price',
  currency: 'currency',
  币种: 'currency',
  货币: 'currency',
  category: 'category',
  分类: 'category',
  类别: 'category',
  condition: 'condition',
  成色: 'condition',
  新旧程度: 'condition',
  brand: 'brand',
  品牌: 'brand',
  size: 'size',
  尺码: 'size',
  尺寸: 'size',
  tags: 'tags',
  标签: 'tags',
  note: 'note',
  备注: 'note',
  status: 'status',
  状态: 'status',
  商品状态: 'status',
}

interface ImportRow {
  row: number
  key: string
  data: ProductDraft
}
export interface ParsedImport {
  rows: ImportRow[]
  report: ProductImportReport
}

function canonicalHeader(header: string): string | undefined {
  return aliases[
    header
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
  ]
}

function csvRows(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closed = false
  const endField = () => {
    row.push(field)
    field = ''
    closed = false
  }
  const endRow = () => {
    endField()
    if (row.some((entry) => entry.trim() !== '')) rows.push(row)
    row = []
    if (rows.length > MAX_ROWS + 1) throw invalidRequest('每次最多导入 1000 行商品资料')
  }
  for (let index = 0; index < content.length; index++) {
    const character = content[index]!
    if (quoted) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
          closed = true
        }
      } else field += character
      continue
    }
    if (character === ',') {
      endField()
      continue
    }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && content[index + 1] === '\n') index++
      endRow()
      continue
    }
    if (closed) throw invalidRequest('CSV 引号结束后只能接逗号或换行')
    if (character === '"') {
      if (field.length) throw invalidRequest('CSV 引号必须位于字段开头')
      quoted = true
    } else field += character
  }
  if (quoted) throw invalidRequest('CSV 引号未闭合')
  if (field.length || row.length || closed) endRow()
  return rows
}

function rowData(input: unknown): ProductDraft {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw invalidRequest('每行必须为商品资料对象')
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const canonical = canonicalHeader(key)
    if (!canonical)
      throw invalidRequest('文件仅支持商品资料字段，不能导入图片、路径或内部标识')
    if (Object.hasOwn(data, canonical)) throw invalidRequest('商品资料列重复')
    data[canonical] = value
  }
  if (typeof data.price === 'string') {
    const price = data.price.trim()
    if (price === '') data.price = null
    else if (/^\d+(?:\.\d+)?$/.test(price)) data.price = Number(price)
    else throw invalidRequest('价格必须为有效的正数')
  }
  if (typeof data.tags === 'string') {
    const tags = data.tags.trim()
    if (tags.startsWith('[')) {
      try {
        data.tags = JSON.parse(tags) as unknown
      } catch {
        throw invalidRequest('标签数组格式无效')
      }
    } else
      data.tags = tags
        .split(/[;,|]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
  }
  if (typeof data.currency === 'string')
    data.currency = data.currency.trim().toUpperCase() || undefined
  if (typeof data.status === 'string') {
    const statuses: Record<string, string> = {
      草稿: 'draft',
      待上架: 'ready',
      已归档: 'archived',
    }
    const status = data.status.trim().toLowerCase()
    data.status = statuses[status] ?? (status || undefined)
  }
  const parsed = ProductDraftSchema.safeParse({ ...data, imageIds: [] })
  if (!parsed.success)
    throw invalidRequest(
      `商品资料无效：${parsed.error.issues[0]?.message ?? '字段格式错误'}`.slice(0, 500),
    )
  return parsed.data
}

export function parseProductImport(format: 'csv' | 'json', raw: string): ParsedImport {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES)
    throw invalidRequest('商品导入文件不能超过 512 KiB')
  const content = raw.replace(/^\uFEFF/, '')
  const fingerprint = createHash('sha256').update(`${format}\0${content}`).digest('hex')
  let inputs: { row: number; data: unknown; error?: string }[]
  if (format === 'csv') {
    const rows = csvRows(content)
    const header = rows.shift()
    if (!header) throw invalidRequest('CSV 缺少商品资料表头')
    const fields = header.map(canonicalHeader)
    if (!fields.includes('name')) throw invalidRequest('CSV 表头必须包含商品名称')
    if (fields.some((field) => field === undefined))
      throw invalidRequest('CSV 仅支持商品资料列，图片请单独上传')
    if (new Set(fields).size !== fields.length) throw invalidRequest('CSV 表头列重复')
    inputs = rows.map((row, index) => ({
      row: index + 2,
      data: Object.fromEntries(
        fields.map((field, column) => [field!, row[column] ?? '']),
      ),
      ...(row.length !== fields.length ? { error: 'CSV 列数与表头不一致' } : {}),
    }))
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(content) as unknown
    } catch {
      throw invalidRequest('JSON 格式无效')
    }
    if (!Array.isArray(parsed)) throw invalidRequest('JSON 必须为商品资料数组')
    inputs = parsed.map((data: unknown, index: number) => ({ row: index + 1, data }))
  }
  if (inputs.length > MAX_ROWS) throw invalidRequest('每次最多导入 1000 行商品资料')
  const rows: ImportRow[] = []
  const report: ProductImportReport = {
    total: inputs.length,
    inserted: 0,
    skipped: 0,
    errors: [],
  }
  for (const input of inputs) {
    try {
      if (input.error) throw invalidRequest(input.error)
      rows.push({
        row: input.row,
        key: `${fingerprint}:${input.row}`,
        data: rowData(input.data),
      })
    } catch (error) {
      report.skipped++
      report.errors.push({
        row: input.row,
        message: (error instanceof Error ? error.message : '商品资料无效').slice(0, 500),
      })
    }
  }
  return { rows, report }
}
