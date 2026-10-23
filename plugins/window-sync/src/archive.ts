import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { CHUNK_BYTES, SyncError } from './types.js'

export function fingerprint(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

export async function openArchive(path: string): Promise<FileHandle> {
  const initial = await lstat(path, { bigint: true })
  if (!initial.isFile()) throw new SyncError('Source must be a regular file')
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const actual = await file.stat({ bigint: true })
    if (!actual.isFile() || actual.dev !== initial.dev || actual.ino !== initial.ino) {
      throw new SyncError('Source file changed while opening')
    }
    if (actual.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new SyncError('Archive is too large')
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

export async function hashArchive(file: FileHandle, alive: () => void): Promise<string> {
  const before = await file.stat({ bigint: true })
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  let offset = 0
  const size = Number(before.size)
  while (offset < size) {
    alive()
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    )
    if (bytesRead === 0) throw new SyncError('Source archive changed', 'SOURCE_CHANGED')
    hash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  alive()
  if (fingerprint(before) !== fingerprint(await file.stat({ bigint: true }))) {
    throw new SyncError('Source archive changed', 'SOURCE_CHANGED')
  }
  return hash.digest('hex')
}

export async function writeAll(file: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset)
    if (bytesWritten === 0) throw new SyncError('Archive write failed', 'UNAVAILABLE')
    offset += bytesWritten
  }
}
