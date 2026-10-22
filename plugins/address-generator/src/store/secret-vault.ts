import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { notConfigured, unavailable } from '../domain/errors.js'
import type { Redactor } from '../rpc/redact.js'

export interface VaultPutResult {
  /** Reference stored in the plugin document. */
  ref: string
}

/**
 * Values live in the plugin's own private directory, in plaintext, next to the
 * plugin document. There is no system keychain and no encryption key to manage:
 * this is a 0600 file that anyone with the user's file access can read, which is
 * exactly what the page's own settings would be. The host never stores it.
 */
export interface SecretVault {
  readonly kind: 'file' | 'memory'
  readonly durable: boolean
  put(slot: string, plaintext: string): Promise<VaultPutResult>
  /** Throws NOT_CONFIGURED when the reference cannot be resolved. */
  resolve(ref: string): Promise<string>
  drop(ref: string): Promise<void>
}

type VaultDocument = Record<string, string>

function parseVault(text: string): VaultDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw unavailable('插件凭据文件不是有效 JSON，需删除该文件后重新填写地图 Key')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw unavailable('插件凭据文件结构无效，需删除该文件后重新填写地图 Key')
  }
  const values: VaultDocument = {}
  for (const [ref, value] of Object.entries(raw)) {
    if (typeof value === 'string') values[ref] = value
  }
  return values
}

class FileVault implements SecretVault {
  readonly kind = 'file' as const
  readonly durable = true
  private values: VaultDocument | null = null
  private sequence = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly redactor: Redactor,
  ) {}

  async put(slot: string, plaintext: string): Promise<VaultPutResult> {
    const values = await this.load()
    const ref = `file:${slot}:${Date.now().toString(36)}:${++this.sequence}`
    values[ref] = plaintext
    this.redactor.add(plaintext)
    await this.persist(values)
    return { ref }
  }

  async resolve(ref: string): Promise<string> {
    const values = await this.load()
    const value = values[ref]
    if (value === undefined) {
      throw notConfigured('地图 Key 引用不可用，请在插件配置中重新填写')
    }
    this.redactor.add(value)
    return value
  }

  async drop(ref: string): Promise<void> {
    const values = await this.load()
    if (!(ref in values)) return
    delete values[ref]
    await this.persist(values)
  }

  private async load(): Promise<VaultDocument> {
    if (this.values !== null) return this.values
    try {
      this.values = parseVault(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (isMissingFile(error)) {
        this.values = {}
      } else {
        throw error
      }
    }
    return this.values
  }

  private async persist(values: VaultDocument): Promise<void> {
    const temporary = `${this.file}.tmp`
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.file)
      this.values = values
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }
}

/** Test vault: values stay in this process only. */
export function createMemoryVault(redactor: Redactor): SecretVault {
  const values = new Map<string, string>()
  let sequence = 0

  return {
    kind: 'memory',
    durable: false,
    async put(slot, plaintext) {
      const ref = `mem:${slot}:${++sequence}`
      values.set(ref, plaintext)
      redactor.add(plaintext)
      return { ref }
    },
    async resolve(ref) {
      const value = values.get(ref)
      if (value === undefined) {
        throw notConfigured('地图 Key 引用不可用，请在插件配置中重新填写')
      }
      redactor.add(value)
      return value
    },
    async drop(ref) {
      values.delete(ref)
    },
  }
}

export function createFileVault(directory: string, redactor: Redactor): SecretVault {
  return new FileVault(join(directory, 'secrets.json'), redactor)
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
