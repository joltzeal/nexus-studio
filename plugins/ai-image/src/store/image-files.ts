import { access, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { unavailable } from '../domain/errors.js'
import { extensionFor, mimeFor, type StoredFile } from '../domain/types.js'

export interface ChunkResult {
  /** Base64 slice of the requested range. */
  data: string
  /** Byte offset to request next; equals `total` when the file is fully read. */
  next: number
  done: boolean
  total: number
}

export interface ImageStore {
  readonly kind: 'file' | 'memory'
  readonly durable: boolean
  write(id: string, mime: string, bytes: Uint8Array): Promise<StoredFile>
  readChunk(id: string, offset: number, length: number): Promise<ChunkResult>
  readAll(id: string): Promise<{ bytes: Uint8Array; mime: string }>
  remove(id: string): Promise<void>
  /** Copies bytes into the plugin's `exports` directory; null when not durable. */
  exportCopy(bytes: Uint8Array, mime: string, baseName: string): Promise<string | null>
}

function chunkOf(bytes: Uint8Array, offset: number, length: number): ChunkResult {
  const total = bytes.byteLength
  const start = Math.min(offset, total)
  const end = Math.min(start + length, total)
  return {
    data: Buffer.from(bytes.subarray(start, end)).toString('base64'),
    next: end,
    done: end >= total,
    total,
  }
}

class MemoryImageStore implements ImageStore {
  readonly kind = 'memory' as const
  readonly durable = false
  private readonly files = new Map<string, { bytes: Uint8Array; mime: string }>()

  async write(id: string, mime: string, bytes: Uint8Array): Promise<StoredFile> {
    this.files.set(id, { bytes, mime })
    return {
      id,
      name: `${id}.${extensionFor(mime) ?? 'bin'}`,
      mime,
      bytes: bytes.byteLength,
    }
  }

  async readChunk(id: string, offset: number, length: number): Promise<ChunkResult> {
    const entry = this.files.get(id)
    if (entry === undefined) throw unavailable('图片文件不存在')
    return chunkOf(entry.bytes, offset, length)
  }

  async readAll(id: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const entry = this.files.get(id)
    if (entry === undefined) throw unavailable('图片文件不存在')
    return { bytes: entry.bytes, mime: entry.mime }
  }

  async remove(id: string): Promise<void> {
    this.files.delete(id)
  }

  async exportCopy(): Promise<string | null> {
    return null
  }
}

class FileImageStore implements ImageStore {
  readonly kind = 'file' as const
  readonly durable = true
  private index: Map<string, string> | null = null

  constructor(
    private readonly directory: string,
    private readonly exportsDirectory: string | null,
  ) {}

  async write(id: string, mime: string, bytes: Uint8Array): Promise<StoredFile> {
    const extension = extensionFor(mime)
    if (extension === null) throw unavailable('不支持的图片格式')
    const name = `${id}.${extension}`
    try {
      await mkdir(this.directory, { recursive: true })
      await writeFile(join(this.directory, name), bytes, { mode: 0o600 })
    } catch (error) {
      throw unavailable('图片写入失败', error)
    }
    this.index?.set(id, name)
    return { id, name, mime, bytes: bytes.byteLength }
  }

  async readChunk(id: string, offset: number, length: number): Promise<ChunkResult> {
    return chunkOf(await this.readAll(id).then((entry) => entry.bytes), offset, length)
  }

  async readAll(id: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const name = await this.lookup(id)
    try {
      const bytes = await readFile(join(this.directory, name))
      return { bytes: new Uint8Array(bytes), mime: mimeFor(name.split('.').pop() ?? '') }
    } catch (error) {
      throw unavailable('图片文件不存在或不可读', error)
    }
  }

  async remove(id: string): Promise<void> {
    const name = await this.lookup(id).catch(() => null)
    if (name === null) return
    await unlink(join(this.directory, name)).catch(() => undefined)
    this.index?.delete(id)
  }

  /**
   * The shell has no file-save dialog, so an export lands in the plugin's own
   * `exports` directory and the page shows the path. Existing files are never
   * overwritten: a counter is appended instead.
   */
  async exportCopy(
    bytes: Uint8Array,
    mime: string,
    baseName: string,
  ): Promise<string | null> {
    if (this.exportsDirectory === null) return null
    const extension = extensionFor(mime) ?? 'png'
    const safe = baseName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    const stem = safe === '' ? 'nexus-ai' : safe.slice(0, 80)
    try {
      await mkdir(this.exportsDirectory, { recursive: true })
      let target = join(this.exportsDirectory, `${stem}.${extension}`)
      let counter = 2
      while (await exists(target)) {
        target = join(this.exportsDirectory, `${stem}-${String(counter)}.${extension}`)
        counter += 1
      }
      await writeFile(target, bytes, { mode: 0o600 })
      return target
    } catch (error) {
      throw unavailable('导出图片失败', error)
    }
  }

  /**
   * File ids carry no extension, so the directory is scanned once and cached.
   * A miss after that is a real miss, not a stale index: ids are never renamed.
   */
  private async lookup(id: string): Promise<string> {
    if (this.index === null) {
      const entries = await readdir(this.directory).catch(() => [] as string[])
      this.index = new Map(
        entries
          .filter((entry) => /^[A-Za-z0-9-]+\.[A-Za-z0-9]+$/.test(entry))
          .map((entry) => [entry.slice(0, entry.lastIndexOf('.')), entry]),
      )
    }
    const name = this.index.get(id)
    if (name === undefined) throw unavailable('图片文件不存在')
    return name
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function createFileImageStore(
  directory: string,
  exportsDirectory: string | null = null,
): ImageStore {
  return new FileImageStore(directory, exportsDirectory)
}

export function createMemoryImageStore(): ImageStore {
  return new MemoryImageStore()
}
