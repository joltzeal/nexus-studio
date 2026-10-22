import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { unavailable } from '../domain/errors.js'
import type { ItemRecord, MonitorRecord, RunRecord } from '../domain/types.js'

export interface StoreDocument {
  schemaVersion: 1
  monitors: MonitorRecord[]
  runs: RunRecord[]
  items: ItemRecord[]
}

export interface PrivateStore {
  readonly kind: 'file' | 'memory'
  /** False means a restart loses data; the plugin reports this instead of hiding it. */
  readonly durable: boolean
  read(): Promise<StoreDocument>
  /**
   * Applies a mutation to a copy, persists it, then swaps it in. A failed write
   * leaves the previous document intact and rethrows, so a caller can never
   * report "saved" for data that was not written.
   */
  mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T>
}

const monitorSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  searchUrl: z.string(),
  kind: z.enum(['catalog', 'member']),
  host: z.string(),
  userId: z.string().nullable(),
  intervalMinutes: z.number(),
  maxPages: z.number(),
  perPage: z.number(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().nullable(),
  lastStatus: z
    .enum(['running', 'success', 'partial', 'failed', 'interrupted'])
    .nullable(),
})

const runSchema = z.looseObject({
  id: z.string(),
  monitorId: z.string(),
  monitorName: z.string(),
  status: z.enum(['running', 'success', 'partial', 'failed', 'interrupted']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  discovered: z.number(),
  inserted: z.number(),
  updated: z.number(),
  skipped: z.number(),
  failed: z.number(),
  truncated: z.boolean(),
  pages: z.number(),
  error: z.string().nullable(),
})

const itemSchema = z.looseObject({
  id: z.string(),
  monitorId: z.string(),
  title: z.string(),
  price: z.string(),
  currency: z.string(),
  brand: z.string(),
  size: z.string(),
  condition: z.string(),
  url: z.string(),
  imageUrl: z.string(),
  seller: z.string(),
  listedAt: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
})

const documentSchema = z.looseObject({
  schemaVersion: z.literal(1),
  monitors: z.array(monitorSchema),
  runs: z.array(runSchema),
  items: z.array(itemSchema),
})

export function emptyDocument(): StoreDocument {
  return { schemaVersion: 1, monitors: [], runs: [], items: [] }
}

function parseDocument(text: string): StoreDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw unavailable('插件私有存储不是有效 JSON，需由宿主重置该插件的存储')
  }
  const parsed = documentSchema.safeParse(raw)
  if (!parsed.success) {
    throw unavailable('插件私有存储结构无效，需由宿主重置该插件的存储')
  }
  return parsed.data as unknown as StoreDocument
}

class MemoryStore implements PrivateStore {
  readonly kind = 'memory' as const
  readonly durable = false
  private document = emptyDocument()
  private queue: Promise<unknown> = Promise.resolve()

  async read(): Promise<StoreDocument> {
    return structuredClone(this.document)
  }

  async mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const draft = structuredClone(this.document)
      const result = await apply(draft)
      this.document = draft
      return result
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }
}

class FileStore implements PrivateStore {
  readonly kind = 'file' as const
  readonly durable = true
  private document: StoreDocument | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async read(): Promise<StoreDocument> {
    await this.load()
    return structuredClone(this.document ?? emptyDocument())
  }

  async mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.load()
      const draft = structuredClone(this.document ?? emptyDocument())
      const result = await apply(draft)
      await this.persist(draft)
      this.document = draft
      return result
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<void> {
    if (this.document !== null) return
    try {
      this.document = parseDocument(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (isMissingFile(error)) {
        this.document = emptyDocument()
        return
      }
      throw error
    }
  }

  private async persist(document: StoreDocument): Promise<void> {
    const temporary = `${this.file}.tmp`
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
      })
      await rename(temporary, this.file)
    } catch (error) {
      throw unavailable('插件私有存储写入失败，本次修改未保存', error)
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export function createFileStore(directory: string): PrivateStore {
  return new FileStore(join(directory, 'vinted-monitor.json'))
}

export function createMemoryStore(): PrivateStore {
  return new MemoryStore()
}
