import { randomUUID } from 'node:crypto'

import {
  PluginFailure,
  invalidRequest,
  notConfigured,
  unavailable,
  upstreamFailure,
  UpstreamError,
} from '../domain/errors.js'
import {
  SCENE_PRESETS,
  composePrompt,
  presetById,
  presetLabel,
} from '../domain/presets.js'
import {
  FileChunkInputSchema,
  GenerateInputSchema,
  ProviderIdInputSchema,
  ProviderSaveInputSchema,
  RecordIdInputSchema,
  RecordsListInputSchema,
  RemoteUploadInputSchema,
  UploadAbortInputSchema,
  UploadBeginInputSchema,
  UploadChunkInputSchema,
  UploadFinishInputSchema,
  normalizeBaseUrl,
  parseOrThrow,
} from '../domain/schemas.js'
import {
  MAX_INPUT_BYTES,
  MAX_RECORDS,
  UPLOAD_CHUNK_BYTES,
  extensionFor,
  providerView,
  sniffImageMime,
  type GenerationRecord,
  type ProviderRecord,
  type StoredFile,
} from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import { checkProvider, requestCopy, requestImages } from '../services/openai.js'
import type { PrivateStore } from '../store/private-store.js'
import type { ImageStore } from '../store/image-files.js'

export const AI_IMAGE_METHODS = [
  'image.providers.list',
  'image.providers.save',
  'image.providers.remove',
  'image.providers.test',
  'image.presets',
  'image.upload.begin',
  'image.upload.chunk',
  'image.upload.finish',
  'image.upload.abort',
  'image.upload.remote',
  'image.file.chunk',
  'image.records.list',
  'image.records.get',
  'image.records.remove',
  'image.records.retry',
  'image.records.export',
  'image.generate',
] as const

/** Image generation is slow; the copy call is quick enough to fail fast. */
const IMAGE_TIMEOUT_MS = 180_000
const COPY_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 20_000
/** A product photo on a CDN either arrives quickly or the host is unreachable. */
const REMOTE_TIMEOUT_MS = 20_000
const MAX_PENDING_UPLOADS = 6

export interface AiImageOptions {
  store: PrivateStore
  images: ImageStore
  logger: Logger
  now?: () => Date
  idFactory?: () => string
  /** Injected so a test can answer a remote image without a network. */
  fetchImpl?: typeof fetch
}

interface Upload {
  mime: string
  size: number
  received: number
  chunks: Buffer[]
}

/** Keeps the CDN's own file stem so a record's inputs read like the product. */
function remoteName(url: string, mime: string): string {
  const extension = extensionFor(mime) ?? 'png'
  try {
    const path = new URL(url).pathname
    const last = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
    const stem = last.replace(/\.[^.]+$/, '').slice(0, 60)
    return stem === '' ? `remote.${extension}` : `${stem}.${extension}`
  } catch {
    return `remote.${extension}`
  }
}

/**
 * `image.provider`: OpenAI and OpenAI-compatible image generation, plus the copy
 * model that turns a reference photo into a title and description. Every
 * generation is a stored record; the images themselves live as files next to the
 * private document.
 */
export class AiImage {
  readonly id = 'image.provider'
  readonly name = 'AI 生图'

  private readonly store: PrivateStore
  private readonly images: ImageStore
  private readonly logger: Logger
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly fetchImpl: typeof fetch | null
  private readonly uploads = new Map<string, Upload>()
  private readonly running = new Set<string>()

  constructor(options: AiImageOptions) {
    this.store = options.store
    this.images = options.images
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
    this.fetchImpl = options.fetchImpl ?? null
  }

  status(): Record<string, unknown> {
    return {
      storage: this.store.kind,
      storageDurable: this.store.durable && this.images.durable,
      running: this.running.size,
      pendingUploads: this.uploads.size,
    }
  }

  async call(context: DispatchContext): Promise<unknown> {
    switch (context.method) {
      case 'image.providers.list':
        return await this.listProviders(context)
      case 'image.providers.save':
        return await this.saveProvider(context)
      case 'image.providers.remove':
        return await this.removeProvider(context)
      case 'image.providers.test':
        return await this.testProvider(context)
      case 'image.presets':
        context.assertAlive()
        return { presets: SCENE_PRESETS.map((preset) => ({ ...preset })) }
      case 'image.upload.begin':
        return this.beginUpload(context)
      case 'image.upload.chunk':
        return this.appendUpload(context)
      case 'image.upload.finish':
        return await this.finishUpload(context)
      case 'image.upload.abort':
        return this.abortUpload(context)
      case 'image.upload.remote':
        return await this.uploadRemote(context)
      case 'image.file.chunk':
        return await this.readFileChunk(context)
      case 'image.records.list':
        return await this.listRecords(context)
      case 'image.records.get':
        return await this.getRecord(context)
      case 'image.records.remove':
        return await this.removeRecord(context)
      case 'image.records.retry':
        return await this.retryRecord(context)
      case 'image.records.export':
        return await this.exportRecord(context)
      case 'image.generate':
        return await this.generate(context)
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }

  // ---- providers ----

  private async listProviders(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const document = await this.store.read()
    return {
      items: document.providers.map(providerView),
      storageDurable: this.store.durable,
    }
  }

  private async saveProvider(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(ProviderSaveInputSchema, context.payload)
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const timestamp = this.now().toISOString()
    return await this.store.mutate((document) => {
      const existing =
        input.id === undefined
          ? undefined
          : document.providers.find((entry) => entry.id === input.id)
      if (input.id !== undefined && existing === undefined) {
        throw invalidRequest('要修改的模型配置不存在')
      }
      const apiKey = input.apiKey === undefined ? (existing?.apiKey ?? '') : input.apiKey
      const record: ProviderRecord = {
        id: existing?.id ?? this.idFactory(),
        name: input.name,
        kind: input.kind,
        baseUrl,
        apiKey,
        imageModel: input.imageModel,
        textModel: input.textModel,
        supportsVision: input.supportsVision,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      if (existing === undefined) document.providers.push(record)
      else document.providers[document.providers.indexOf(existing)] = record
      return providerView(record)
    })
  }

  private async removeProvider(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(ProviderIdInputSchema, context.payload)
    return await this.store.mutate((document) => {
      const before = document.providers.length
      document.providers = document.providers.filter((entry) => entry.id !== input.id)
      return { id: input.id, removed: document.providers.length < before }
    })
  }

  private async testProvider(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(ProviderIdInputSchema, context.payload)
    const provider = await this.provider(input.id)
    const started = Date.now()
    try {
      const result = await checkProvider(
        provider.baseUrl,
        provider.apiKey,
        TEST_TIMEOUT_MS,
      )
      return { ...result, durationMs: Date.now() - started }
    } catch (error) {
      throw this.mapUpstream(error)
    }
  }

  // ---- uploads ----

  private beginUpload(context: DispatchContext): unknown {
    context.assertAlive()
    const input = parseOrThrow(UploadBeginInputSchema, context.payload)
    if (this.uploads.size >= MAX_PENDING_UPLOADS) {
      throw invalidRequest('同时进行的图片上传过多，请稍后再试')
    }
    const uploadId = this.idFactory()
    this.uploads.set(uploadId, {
      mime: input.mime,
      size: input.size,
      received: 0,
      chunks: [],
    })
    return { uploadId, chunkSize: UPLOAD_CHUNK_BYTES }
  }

  private appendUpload(context: DispatchContext): unknown {
    context.assertAlive()
    const input = parseOrThrow(UploadChunkInputSchema, context.payload)
    const upload = this.uploads.get(input.uploadId)
    if (upload === undefined) throw invalidRequest('上传会话已失效，请重新选择图片')
    const bytes = Buffer.from(input.data, 'base64')
    if (bytes.byteLength === 0) throw invalidRequest('图片分块内容为空')
    if (upload.received + bytes.byteLength > upload.size) {
      throw invalidRequest('图片分块总大小超过声明的尺寸')
    }
    upload.chunks.push(bytes)
    upload.received += bytes.byteLength
    return { uploadId: input.uploadId, received: upload.received, size: upload.size }
  }

  private async finishUpload(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(UploadFinishInputSchema, context.payload)
    const upload = this.uploads.get(input.uploadId)
    if (upload === undefined) throw invalidRequest('上传会话已失效，请重新选择图片')
    if (upload.received !== upload.size) {
      throw invalidRequest('图片上传未完成，请重新上传')
    }
    this.uploads.delete(input.uploadId)
    const bytes = Buffer.concat(upload.chunks)
    const file = await this.images.write(
      this.idFactory(),
      upload.mime,
      new Uint8Array(bytes),
    )
    return { file: { ...file, name: input.name } }
  }

  private abortUpload(context: DispatchContext): unknown {
    context.assertAlive()
    const input = parseOrThrow(UploadAbortInputSchema, context.payload)
    this.uploads.delete(input.uploadId)
    return { aborted: true }
  }

  private async readFileChunk(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(FileChunkInputSchema, context.payload)
    return await this.images.readChunk(input.fileId, input.offset, input.length)
  }

  /**
   * Downloads a picture that the page cannot reach itself and stores it exactly
   * like a chosen file, so the rest of the flow (records, retry, export) does
   * not need to know where the bytes came from.
   */
  private async uploadRemote(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(RemoteUploadInputSchema, context.payload)
    const doFetch = this.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
      response = await doFetch(input.url, {
        redirect: 'follow',
        headers: { accept: 'image/*' },
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      })
    } catch (error) {
      throw unavailable('图片下载失败，请检查链接是否可以访问', error)
    }
    if (!response.ok) {
      throw unavailable(`图片链接返回 ${String(response.status)}，无法下载`)
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_INPUT_BYTES) {
      throw invalidRequest('图片超过 8 MB，请换一张')
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) throw invalidRequest('图片内容为空')
    if (bytes.byteLength > MAX_INPUT_BYTES) {
      throw invalidRequest('图片超过 8 MB，请换一张')
    }
    const mime = sniffImageMime(bytes)
    if (mime === null) {
      throw invalidRequest('链接指向的不是 JPEG、PNG 或 WebP 图片')
    }
    const file = await this.images.write(this.idFactory(), mime, bytes)
    const name = input.name === undefined ? '' : input.name
    return { file: { ...file, name: name === '' ? remoteName(input.url, mime) : name } }
  }

  private async listRecords(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(RecordsListInputSchema, context.payload)
    const document = await this.store.read()
    const filtered =
      input.status === undefined
        ? document.records
        : document.records.filter((record) => record.status === input.status)
    const sorted = [...filtered].sort((left, right) =>
      left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0,
    )
    const start = input.page * input.size
    return {
      items: sorted.slice(start, start + input.size),
      total: sorted.length,
      page: input.page,
      pageSize: input.size,
      storageDurable: this.store.durable && this.images.durable,
    }
  }

  private async getRecord(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(RecordIdInputSchema, context.payload)
    const document = await this.store.read()
    const record = document.records.find((entry) => entry.id === input.id)
    if (record === undefined) throw invalidRequest('生成记录不存在')
    return { record }
  }

  private async removeRecord(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(RecordIdInputSchema, context.payload)
    if (this.running.has(input.id)) {
      throw invalidRequest('这条记录仍在生成中，完成后再删除')
    }
    const removed = await this.store.mutate((document) => {
      const index = document.records.findIndex((entry) => entry.id === input.id)
      if (index === -1) return null
      const [record] = document.records.splice(index, 1)
      return record ?? null
    })
    if (removed === null) throw invalidRequest('生成记录不存在')
    await this.deleteFiles([...removed.inputs, ...removed.outputs])
    return { id: input.id, removed: true }
  }

  private async retryRecord(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(RecordIdInputSchema, context.payload)
    if (this.running.has(input.id)) throw invalidRequest('这条记录仍在生成中')
    const record = await this.store.mutate((document) => {
      const found = document.records.find((entry) => entry.id === input.id)
      if (found === undefined) throw invalidRequest('生成记录不存在')
      found.status = 'running'
      found.stage = 'queued'
      found.error = null
      found.copyError = null
      found.durationMs = null
      found.updatedAt = this.now().toISOString()
      return found
    })
    this.run(record.id)
    return { record }
  }

  /**
   * Writes the record's outputs into the plugin's `exports` directory and hands
   * back the paths: the desktop shell has no save dialog, so this is how an
   * image leaves the app without promising a download the webview cannot do.
   */
  private async exportRecord(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(RecordIdInputSchema, context.payload)
    const record = await this.record(input.id)
    if (record.outputs.length === 0) throw invalidRequest('这条记录还没有可导出的图片')
    const paths: string[] = []
    for (const [index, file] of record.outputs.entries()) {
      const stored = await this.images.readAll(file.id)
      const path = await this.images.exportCopy(
        stored.bytes,
        stored.mime,
        `nexus-ai-${record.id.slice(0, 8)}-${String(index + 1)}`,
      )
      if (path === null) throw notConfigured('宿主未提供私有目录，无法导出图片')
      paths.push(path)
    }
    return { paths }
  }

  // ---- generation ----

  private async generate(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(GenerateInputSchema, context.payload)
    const provider = await this.provider(input.providerId)
    if (input.mode === 'edit' && input.inputFileIds.length === 0) {
      throw invalidRequest('改图至少需要一张参考图片')
    }
    if (input.presetId !== null && presetById(input.presetId) === null) {
      throw invalidRequest('场景预设不存在')
    }
    const prompt = composePrompt(input.presetId, input.prompt)
    if (prompt === '') throw invalidRequest('请填写提示词或选择一个场景预设')

    const files: StoredFile[] = []
    for (const fileId of input.inputFileIds) {
      const stored = await this.images.readAll(fileId)
      files.push({
        id: fileId,
        name: `${fileId}.${extensionFor(stored.mime) ?? 'png'}`,
        mime: stored.mime,
        bytes: stored.bytes.byteLength,
      })
    }

    const timestamp = this.now().toISOString()
    const record: GenerationRecord = {
      id: this.idFactory(),
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'running',
      stage: 'queued',
      mode: input.mode,
      prompt,
      presetId: input.presetId,
      presetLabel: presetLabel(input.presetId),
      size: input.size,
      count: input.count,
      providerId: provider.id,
      providerName: provider.name,
      providerKind: provider.kind,
      imageModel: provider.imageModel,
      textModel: provider.textModel,
      inputs: files,
      outputs: [],
      title: null,
      description: null,
      error: null,
      copyError: null,
      durationMs: null,
    }

    const pruned = await this.store.mutate((document) => {
      document.records.unshift(record)
      const overflow = document.records.splice(MAX_RECORDS)
      return overflow
    })
    if (pruned.length > 0) {
      await this.deleteFiles(
        pruned.flatMap((entry) => [...entry.inputs, ...entry.outputs]),
      )
    }
    this.run(record.id)
    return { record }
  }

  /**
   * Runs outside the request deadline: a slow provider must not fail the call
   * that started it. Progress is written to the record, which the page polls.
   */
  private run(recordId: string): void {
    if (this.running.has(recordId)) return
    this.running.add(recordId)
    void this.execute(recordId)
      .catch((error: unknown) => {
        this.logger.error('生成任务异常结束', {
          recordId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        this.running.delete(recordId)
      })
  }

  private async execute(recordId: string): Promise<void> {
    const started = Date.now()
    const snapshot = await this.record(recordId)
    const provider = await this.provider(snapshot.providerId).catch(() => null)
    if (provider === null) {
      await this.settle(recordId, {
        status: 'failed',
        stage: 'done',
        error: '模型配置已被删除，无法继续生成',
        durationMs: Date.now() - started,
      })
      return
    }

    const inputs: { mime: string; bytes: Uint8Array; name: string }[] = []
    for (const file of snapshot.inputs) {
      try {
        const stored = await this.images.readAll(file.id)
        inputs.push({ mime: stored.mime, bytes: stored.bytes, name: file.name })
      } catch {
        // A pruned or hand-deleted file leaves the record with fewer references
        // rather than failing the whole job.
        this.logger.warn('参考图片缺失', { recordId, fileId: file.id })
      }
    }

    await this.settle(recordId, { stage: 'image' })
    const stored: StoredFile[] = []
    try {
      const outputs = await requestImages({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.imageModel,
        prompt: snapshot.prompt,
        size: snapshot.size,
        count: snapshot.count,
        inputs: snapshot.mode === 'edit' ? inputs : [],
        timeoutMs: IMAGE_TIMEOUT_MS,
      })
      for (const output of outputs) {
        stored.push(await this.images.write(this.idFactory(), output.mime, output.bytes))
      }
    } catch (error) {
      const message = this.message(error)
      this.logger.warn('生图失败', { recordId, error: message })
      await this.settle(recordId, {
        status: 'failed',
        stage: 'done',
        error: message,
        durationMs: Date.now() - started,
      })
      return
    }

    // The copy model describes a real photo, so it runs on the result rather than
    // on the prompt: for an edit that is the touched-up product, for a generation
    // it is the only picture that exists. Without a vision-capable model there is
    // nothing to look at, so the stage is skipped instead of billed for a guess.
    let title: string | null = null
    let description: string | null = null
    let copyError: string | null = null
    if (provider.textModel !== '' && provider.supportsVision && stored.length > 0) {
      await this.settle(recordId, { stage: 'copy' })
      try {
        const references: { mime: string; bytes: Uint8Array }[] = []
        for (const file of stored.slice(0, 2)) {
          const image = await this.images.readAll(file.id)
          references.push({ mime: image.mime, bytes: image.bytes })
        }
        const copy = await requestCopy({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.textModel,
          prompt: snapshot.presetLabel ?? '',
          images: references,
          timeoutMs: COPY_TIMEOUT_MS,
        })
        title = copy.title
        description = copy.description
      } catch (error) {
        copyError = this.message(error)
        this.logger.warn('文案生成失败', { recordId, error: copyError })
      }
    }

    await this.settle(recordId, {
      status: 'success',
      stage: 'done',
      outputs: stored,
      title,
      description,
      copyError,
      error: null,
      durationMs: Date.now() - started,
    })
  }

  private async settle(
    recordId: string,
    patch: Partial<GenerationRecord>,
  ): Promise<void> {
    await this.store.mutate((document) => {
      const record = document.records.find((entry) => entry.id === recordId)
      if (record === undefined) return
      Object.assign(record, patch, { updatedAt: this.now().toISOString() })
    })
  }

  // ---- helpers ----

  private async provider(id: string): Promise<ProviderRecord> {
    const document = await this.store.read()
    const provider = document.providers.find((entry) => entry.id === id)
    if (provider === undefined) throw notConfigured('请先在模型配置中保存一个服务商')
    if (provider.apiKey === '') throw notConfigured('该服务商还没有填写 API Key')
    return provider
  }

  private async record(id: string): Promise<GenerationRecord> {
    const document = await this.store.read()
    const record = document.records.find((entry) => entry.id === id)
    if (record === undefined) throw invalidRequest('生成记录不存在')
    return record
  }

  private async deleteFiles(files: StoredFile[]): Promise<void> {
    for (const file of files) {
      await this.images.remove(file.id).catch(() => undefined)
    }
  }

  private mapUpstream(error: unknown): unknown {
    if (error instanceof UpstreamError) return upstreamFailure(error)
    return error
  }

  /** Upstream messages are already user-facing; anything else stays generic. */
  private message(error: unknown): string {
    if (error instanceof UpstreamError) return upstreamFailure(error).message
    if (error instanceof PluginFailure) return error.message
    return '生成失败，请稍后重试'
  }
}
