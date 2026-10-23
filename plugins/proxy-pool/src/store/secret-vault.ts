import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { notConfigured, unavailable } from '../domain/errors.js'
import type { Redactor } from '../rpc/redact.js'

export interface VaultPutResult {
  /** Reference stored in the inventory. */
  ref: string
  /** Digest used only for duplicate detection. */
  fingerprint: string
}

/**
 * Credentials live in the plugin's own private directory, in plaintext, next to
 * the inventory document. The host never receives a password, so this is not a
 * secret store: it is a local file that anyone with the user's file access can
 * read. `proxy-pool.json` and `secrets.json` share the same 0600 permissions.
 */
export interface SecretVault {
  readonly kind: 'file' | 'memory'
  readonly durable: boolean
  put(slot: string, plaintext: string): Promise<VaultPutResult>
  /** Throws NOT_CONFIGURED when the reference cannot be resolved. */
  resolve(ref: string): Promise<string>
  drop(ref: string): Promise<void>
}

function fingerprintOf(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

type VaultDocument = Record<string, string>

function parseVault(text: string): VaultDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw unavailable('插件凭据文件不是有效 JSON，需删除该文件后重新填写密码')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw unavailable('插件凭据文件结构无效，需删除该文件后重新填写密码')
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
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly redactor: Redactor,
  ) {}

  async put(slot: string, plaintext: string): Promise<VaultPutResult> {
    const values = await this.load()
    const ref = `file:${slot}:${randomUUID()}`
    values[ref] = plaintext
    this.redactor.add(plaintext)
    await this.persist(values)
    return { ref, fingerprint: fingerprintOf(plaintext) }
  }

  async resolve(ref: string): Promise<string> {
    const values = await this.load()
    const value = values[ref]
    if (value === undefined) {
      throw notConfigured('代理凭据引用不可用，请在插件配置中重新填写密码')
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

/**
 * Test vault. Values stay in this process only; fingerprints are stable so
 * duplicate detection behaves like the file vault.
 */
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
      return { ref, fingerprint: fingerprintOf(plaintext) }
    },
    async resolve(ref) {
      const value = values.get(ref)
      if (value === undefined) {
        throw notConfigured('代理凭据引用不可用，请在插件配置中重新填写密码')
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

/** Kept for the duplicate-detection contract used by the inventory. */
export function credentialFingerprint(plaintext: string): string {
  return fingerprintOf(plaintext)
}
