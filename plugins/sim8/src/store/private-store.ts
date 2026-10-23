import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { unavailable } from '../domain/errors.js'
import { DEFAULT_BASE_URL } from '../services/client.js'
import type { ProfileInfo, SmsRecord } from '../domain/types.js'

export interface StoreConfig {
  baseUrl: string
  /** Reference into the plugin's own vault; the token itself never lands here. */
  tokenRef: string | null
  /** Last successful `profile/info`, so the page can show a balance offline. */
  profile: ProfileInfo | null
  profileAt: string | null
}

export interface StoreDocument {
  schemaVersion: 1
  config: StoreConfig
  records: SmsRecord[]
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

/**
 * Every field carries a default: a record written by an older build must still
 * load after an upgrade, because the alternative is losing the number list.
 */
const profileSchema = z.looseObject({
  username: z.string().default(''),
  nickname: z.string().default(''),
  avatar: z.string().default(''),
  money: z.number().default(0),
})

const readSchema = z.looseObject({
  code: z.string().nullable().default(null),
  body: z.string().default(''),
  truncated: z.boolean().default(false),
  contentType: z.string().default(''),
  fetchedAt: z.string().default(''),
})

const recordSchema = z.looseObject({
  tel: z.string(),
  token: z.string().default(''),
  api: z.string().default(''),
  apiId: z.number().nullable().default(null),
  ordernum: z.string().default(''),
  appId: z.number().nullable().default(null),
  cateId: z.number().nullable().default(null),
  type: z.number().nullable().default(null),
  endTime: z.string().default(''),
  remark: z.string().default(''),
  status: z.number().nullable().default(null),
  renew: z.number().nullable().default(null),
  smsCount: z.number().nullable().default(null),
  voiceCount: z.number().nullable().default(null),
  addedAt: z.string().default(''),
  updatedAt: z.string().default(''),
  lastRead: readSchema.nullable().default(null),
})

const configSchema = z.looseObject({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  tokenRef: z.string().nullable().default(null),
  profile: profileSchema.nullable().default(null),
  profileAt: z.string().nullable().default(null),
})

const documentSchema = z.looseObject({
  schemaVersion: z.literal(1),
  // A document written before the config existed still loads, with no token.
  config: configSchema.default({
    baseUrl: DEFAULT_BASE_URL,
    tokenRef: null,
    profile: null,
    profileAt: null,
  }),
  records: z.array(recordSchema).default([]),
})

export function emptyDocument(): StoreDocument {
  return {
    schemaVersion: 1,
    config: { baseUrl: DEFAULT_BASE_URL, tokenRef: null, profile: null, profileAt: null },
    records: [],
  }
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
  return new FileStore(join(directory, 'sim8.json'))
}

export function createMemoryStore(): PrivateStore {
  return new MemoryStore()
}
