import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { unavailable } from '../domain/errors.js'
import {
  AccountTransferReceiptSchema,
  type AccountTransferReceipt,
} from '../domain/transfer.js'
import type { AccountRecord, BindingRecord } from '../domain/types.js'

export interface StoreDocument {
  schemaVersion: 1
  accounts: AccountRecord[]
  bindings: BindingRecord[]
  transferReceipts: AccountTransferReceipt[]
}

export interface AccountStore {
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

const accountSchema = z.looseObject({
  id: z.string(),
  loginMethod: z.enum(['email', 'google', 'apple', 'facebook']),
  account: z.string(),
  password: z.string(),
  phone: z.string(),
  emailOtpUrl: z.string(),
  smsOtpUrl: z.string(),
  note: z.string(),
  status: z.enum(['active', 'pending', 'limited', 'blocked']),
  homepageUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const bindingSchema = z.looseObject({
  windowId: z.string(),
  accountId: z.string(),
  boundAt: z.string(),
})

const documentSchema = z.looseObject({
  schemaVersion: z.literal(1),
  accounts: z.array(accountSchema),
  bindings: z.array(bindingSchema),
  transferReceipts: z.array(AccountTransferReceiptSchema).default([]),
})

export function emptyDocument(): StoreDocument {
  return { schemaVersion: 1, accounts: [], bindings: [], transferReceipts: [] }
}

function parseDocument(text: string): StoreDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw unavailable('账号存储不是有效 JSON，需由宿主重置该插件的存储')
  }
  const parsed = documentSchema.safeParse(raw)
  if (!parsed.success) {
    throw unavailable('账号存储结构无效，需由宿主重置该插件的存储')
  }
  return parsed.data as unknown as StoreDocument
}

class MemoryStore implements AccountStore {
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

class FileStore implements AccountStore {
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
      throw unavailable('账号存储写入失败，本次修改未保存', error)
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

export function createFileStore(directory: string): AccountStore {
  return new FileStore(join(directory, 'vinted-accounts.json'))
}

export function createMemoryStore(): AccountStore {
  return new MemoryStore()
}
