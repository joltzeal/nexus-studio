import {
  PRODUCTS_PLUGIN_ID,
  PRODUCT_CAPABILITY,
  MAX_PRODUCT_IMAGES,
  MAX_IMAGE_BYTES,
  GenerationOriginSchema,
  ImageMimeSchema,
  ProductAiReplySchema,
  ProductDraftSchema,
  ProductImportAiSchema,
  ProductSourceFindSchema,
  ProductSourceReplySchema,
  type Product,
  type ProductImage,
} from '@nexus/plugin-contracts/products'
import { pluginApi } from '../api'
import type { PluginView } from '../types'
import { getRecord, readImageBytes } from './api'
import {
  AI_IMAGE_PLUGIN_ID,
  AI_IMAGE_CAPABILITY,
  type GenerationRecord,
  type StoredFile,
} from './types'
import { callProducts } from '../products/api'
import { discardProductImages, uploadProductBytes } from '../products/images'

export interface AiProductImportProgress {
  stage: 'checking' | 'copying' | 'saving'
  completed: number
  total: number
}

export interface ImportOptions {
  signal?: AbortSignal
  onProgress?: (progress: AiProductImportProgress) => void
}

const productMethods = [
  'products.sources.find',
  'products.importAi',
  'products.upload.begin',
  'products.upload.chunk',
  'products.upload.finish',
  'products.upload.abort',
  'products.images.discard',
]
const aiMethods = ['image.records.get', 'image.file.chunk']

function usablePlugin(
  catalog: PluginView[],
  id: string,
  capability: string,
  methods: string[],
  label: string,
): PluginView {
  const plugin = catalog.find((entry) => entry.id === id)
  if (
    !plugin ||
    !plugin.enabled ||
    plugin.state !== 'running' ||
    !plugin.capabilities.includes(capability) ||
    !plugin.granted.includes(capability) ||
    !plugin.storageDurable ||
    methods.some((method) => !plugin.methods.includes(method))
  )
    throw new Error(`请先安装并启用可用的${label}插件。`)
  return plugin
}

function identity(plugin: PluginView): string {
  const status =
    plugin.status && typeof plugin.status === 'object' && !Array.isArray(plugin.status)
      ? (plugin.status as Record<string, unknown>)
      : {}
  return JSON.stringify([
    plugin.id,
    plugin.version,
    plugin.source,
    plugin.installation ?? null,
    plugin.runtimeGeneration ?? null,
    status.pid ?? null,
    status.startedAt ?? null,
  ])
}

function snapshot(record: GenerationRecord, expectedId: string) {
  if (
    !record ||
    record.id !== expectedId ||
    !['success', 'failed'].includes(record.status) ||
    record.outputVision?.status === 'running'
  )
    throw new Error('请等待生成和识图全部完成后再导入商品。')
  if (
    !Array.isArray(record.outputs) ||
    !record.outputs.length ||
    record.outputs.length > MAX_PRODUCT_IMAGES ||
    new Set(record.outputs.map((file) => file.id)).size !== record.outputs.length
  )
    throw new Error(`请选择包含 1–${MAX_PRODUCT_IMAGES} 张成片的生成记录。`)
  const files = record.outputs.map((file) => {
    if (
      !file ||
      typeof file.id !== 'string' ||
      !file.id.trim() ||
      file.id.length > 128 ||
      typeof file.name !== 'string' ||
      !file.name.trim() ||
      file.name.length > 200 ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > MAX_IMAGE_BYTES
    )
      throw new Error('生图记录中的图片资料不完整，无法导入。')
    return { ...file, mime: ImageMimeSchema.parse(file.mime) }
  })
  const vision = record.outputVision?.status === 'success' ? record.outputVision : null
  const title = vision?.title || record.title || ''
  const description = vision?.description || record.description || ''
  const name = (title || `Generated product ${record.id}`)
    .slice(0, 200)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()
  const data = ProductDraftSchema.parse({
    name,
    title,
    description,
    status: 'draft',
    imageIds: [],
  })
  const origin = record.source ? GenerationOriginSchema.parse(record.source) : null
  return { data, files, origin }
}

async function readGenerationFile(
  file: StoredFile,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const bytes = await readImageBytes(file.id, signal)
  if (bytes.length !== file.bytes)
    throw new Error('生成图片大小与记录不一致，请刷新后重试。')
  return bytes
}

export async function importGenerationProduct(
  recordId: string,
  options: ImportOptions = {},
): Promise<{ product: Product; alreadyImported: boolean }> {
  const { signal, onProgress } = options
  signal?.throwIfAborted()
  const source = ProductSourceFindSchema.parse({ recordId })
  onProgress?.({ stage: 'checking', completed: 0, total: 0 })
  const catalog = await pluginApi.list()
  signal?.throwIfAborted()
  const target = usablePlugin(
    catalog,
    PRODUCTS_PLUGIN_ID,
    PRODUCT_CAPABILITY,
    productMethods,
    '商品',
  )
  const existing = ProductSourceReplySchema.parse(
    await callProducts('products.sources.find', source),
  ).product
  if (existing !== null) {
    if (
      existing.source.kind !== 'ai-image' ||
      existing.source.recordId !== source.recordId
    )
      throw new Error('商品来源核对失败，请刷新后重试。')
    return { product: existing, alreadyImported: true }
  }
  signal?.throwIfAborted()
  const from = usablePlugin(
    catalog,
    AI_IMAGE_PLUGIN_ID,
    AI_IMAGE_CAPABILITY,
    aiMethods,
    'AI 生图',
  )
  const targetIdentity = identity(target)
  const fromIdentity = identity(from)
  async function checkProcesses() {
    signal?.throwIfAborted()
    const next = await pluginApi.list()
    signal?.throwIfAborted()
    const nextTarget = usablePlugin(
      next,
      PRODUCTS_PLUGIN_ID,
      PRODUCT_CAPABILITY,
      productMethods,
      '商品',
    )
    const nextFrom = usablePlugin(
      next,
      AI_IMAGE_PLUGIN_ID,
      AI_IMAGE_CAPABILITY,
      aiMethods,
      'AI 生图',
    )
    if (identity(nextTarget) !== targetIdentity || identity(nextFrom) !== fromIdentity)
      throw new Error('插件已重启或更新，本次导入已停止，请重新导入。')
  }
  const record = snapshot((await getRecord(source.recordId)).record, source.recordId)
  const fingerprint = JSON.stringify(record)
  const uploaded: ProductImage[] = []
  let committed = false
  try {
    for (const file of record.files) {
      await checkProcesses()
      onProgress?.({
        stage: 'copying',
        completed: uploaded.length,
        total: record.files.length,
      })
      const bytes = await readGenerationFile(file, signal)
      const image = await uploadProductBytes(
        { bytes, name: file.name, mime: file.mime },
        signal,
      )
      uploaded.push(image)
    }
    await checkProcesses()
    const current = snapshot((await getRecord(source.recordId)).record, source.recordId)
    if (JSON.stringify(current) !== fingerprint)
      throw new Error('生图记录在导入期间发生变化，请重新导入。')
    signal?.throwIfAborted()
    onProgress?.({
      stage: 'saving',
      completed: uploaded.length,
      total: record.files.length,
    })
    const input = ProductImportAiSchema.parse({
      ...source,
      origin: record.origin,
      data: { ...record.data, imageIds: uploaded.map((image) => image.id) },
    })
    const reply = ProductAiReplySchema.parse(
      await callProducts('products.importAi', input),
    )
    if (
      reply.product.source.kind !== 'ai-image' ||
      reply.product.source.recordId !== source.recordId ||
      (!reply.alreadyImported &&
        (reply.product.revision !== 1 ||
          reply.product.status !== 'draft' ||
          reply.product.name !== record.data.name ||
          reply.product.title !== record.data.title ||
          reply.product.description !== record.data.description ||
          JSON.stringify(reply.product.source.origin) !== JSON.stringify(record.origin) ||
          reply.product.images.length !== uploaded.length ||
          reply.product.images.some(
            (image, index) =>
              image.id !== uploaded[index]?.id ||
              image.sha256 !== uploaded[index]?.sha256,
          )))
    )
      throw new Error('导入结果的商品来源不一致，请刷新确认。')
    // Cancellation after a successful commit cannot undo durable product data.
    committed = true
    const ownedIds = new Set(reply.product.images.map((image) => image.id))
    const unused = uploaded
      .filter((image) => !ownedIds.has(image.id))
      .map((image) => image.id)
    if (unused.length) await discardProductImages(unused).catch(() => undefined)
    return reply
  } catch (error) {
    if (!committed && uploaded.length)
      await discardProductImages(uploaded.map((image) => image.id)).catch(() => undefined)
    throw error
  }
}
