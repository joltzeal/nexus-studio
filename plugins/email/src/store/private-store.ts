import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { unavailable } from '../domain/errors.js'
import { StoreDocumentSchema } from '../domain/schemas.js'
import type { EmailSettings, MailboxRecord, MailReceptionState } from '../domain/types.js'

export interface StoreDocument {
  schemaVersion: 1
  settings: EmailSettings
  accounts: MailboxRecord[]
}

export interface EmailStore {
  readonly durable: boolean
  read(): Promise<StoreDocument>
  mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T>
}

export function emptyDocument(): StoreDocument {
  return {
    schemaVersion: 1,
    settings: {
      autoRefresh: true,
      intervalMinutes: 60,
      autoReceive: true,
      receiveIntervalMinutes: 1,
    },
    accounts: [],
  }
}

export function emptyReception(): MailReceptionState {
  return {
    lastCheckedAt: null,
    nextCheckAt: null,
    latestReceivedAt: null,
    lastError: null,
    lastErrorCode: null,
    inbox: null,
    junkemail: null,
  }
}

function normalizeLoaded(document: unknown): unknown {
  if (!document || typeof document !== 'object') return document
  const source = document as Record<string, unknown>
  const settings = source.settings
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const current = settings as Record<string, unknown>
    if (!Object.hasOwn(current, 'autoReceive')) current.autoReceive = true
    if (!Object.hasOwn(current, 'receiveIntervalMinutes'))
      current.receiveIntervalMinutes = 1
  }
  if (Array.isArray(source.accounts))
    for (const account of source.accounts) {
      if (!account || typeof account !== 'object' || Array.isArray(account)) continue
      const current = account as Record<string, unknown>
      if (!Object.hasOwn(current, 'reception')) current.reception = emptyReception()
      if (!Object.hasOwn(current, 'receiveRequested')) current.receiveRequested = false
      if (!Object.hasOwn(current, 'receiveFailures')) current.receiveFailures = 0
    }
  return source
}

function validate(document: unknown): StoreDocument {
  const result = StoreDocumentSchema.safeParse(document)
  if (!result.success) throw unavailable('邮箱存储结构无效，请检查插件数据文件')
  return result.data
}

class PrivateStore implements EmailStore {
  readonly durable: boolean
  private document: StoreDocument | null = null
  private loading: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string | null) {
    this.durable = file !== null
  }

  async read(): Promise<StoreDocument> {
    await this.load()
    return structuredClone(this.document!)
  }

  mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.load()
      const draft = structuredClone(this.document!)
      const result = await apply(draft)
      const valid = validate(draft)
      if (this.file !== null) await this.persist(valid)
      this.document = valid
      return structuredClone(result)
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<void> {
    if (this.document !== null) return
    const loading = (this.loading ??= this.loadDocument())
    try {
      await loading
    } finally {
      if (this.loading === loading) this.loading = null
    }
  }

  private async loadDocument(): Promise<void> {
    if (this.file === null) {
      this.document = emptyDocument()
      return
    }
    try {
      if ((await stat(this.file)).size > 128 * 1024 * 1024)
        throw unavailable('邮箱存储文件超过读取上限')
      this.document = validate(
        normalizeLoaded(JSON.parse(await readFile(this.file, 'utf8'))),
      )
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        this.document = emptyDocument()
        return
      }
      throw unavailable('邮箱存储读取失败，请检查插件数据文件；原数据未被清空')
    }
  }

  private async persist(document: StoreDocument): Promise<void> {
    const file = this.file!
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 })
      await rename(temporary, file)
    } catch {
      throw unavailable('邮箱存储写入失败，本次修改未保存')
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

export function createFileStore(directory: string): EmailStore {
  return new PrivateStore(join(directory, 'email.json'))
}

export function createMemoryStore(): EmailStore {
  return new PrivateStore(null)
}
