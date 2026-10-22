import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { unavailable } from '../domain/errors.js'

export interface StoreDocument {
  schemaVersion: 1
  maps: {
    /** Reference into the plugin's own vault; the key itself never lands here. */
    apiKeyRef: string | null
  }
}

export interface PrivateStore {
  readonly kind: 'file' | 'memory'
  /** False means a restart loses data; the plugin reports this instead of hiding it. */
  readonly durable: boolean
  /** Directory for generated files, or null when the store cannot hold files. */
  readonly exportDirectory: string | null
  read(): Promise<StoreDocument>
  /**
   * Applies a mutation to a copy, persists it, then swaps it in. A failed write
   * leaves the previous document intact and rethrows, so a caller can never
   * report "saved" for data that was not written.
   */
  mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T>
}

const documentSchema = z.looseObject({
  schemaVersion: z.literal(1),
  maps: z.looseObject({
    apiKeyRef: z.string().nullable(),
  }),
})

export function emptyDocument(): StoreDocument {
  return { schemaVersion: 1, maps: { apiKeyRef: null } }
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
  readonly exportDirectory = null
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
  readonly exportDirectory: string
  private document: StoreDocument | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {
    this.exportDirectory = join(dirname(file), 'exports')
  }

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
  return new FileStore(join(directory, 'address-generator.json'))
}

export function createMemoryStore(): PrivateStore {
  return new MemoryStore()
}
