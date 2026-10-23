import { open, readFile, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { BrowserContext } from 'playwright-core'
import { withinProfileDeadline } from './profile-deadline.js'

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

export interface PortableState {
  schemaVersion: 1
  storageState: StorageState
}

const MAX_STATE_BYTES = 128 * 1024 * 1024

export async function validatePortableStateFiles(paths: string[]): Promise<number> {
  if (paths.length < 1 || paths.length > 100 || paths.some((path) => !isAbsolute(path))) {
    throw new Error('PORTABLE_STATE_INVALID_ARGUMENTS')
  }
  for (const path of paths) {
    const file = await open(path, 'r').catch((error: unknown) => {
      throw new Error('PORTABLE_STATE_READ_FAILED', { cause: error })
    })
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new Error('PORTABLE_STATE_READ_FAILED')
      if (info.size > MAX_STATE_BYTES) throw new Error('PORTABLE_STATE_TOO_LARGE')
      const chunks: Buffer[] = []
      let size = 0
      // Limit the read itself, including a file that grows after stat.
      for await (const chunk of file.createReadStream({
        autoClose: false,
        start: 0,
        end: MAX_STATE_BYTES,
      })) {
        const bytes = chunk as Buffer
        size += bytes.length
        if (size > MAX_STATE_BYTES) throw new Error('PORTABLE_STATE_TOO_LARGE')
        chunks.push(bytes)
      }
      try {
        parsePortableState(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        throw new Error('PORTABLE_STATE_INVALID')
      }
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'PORTABLE_STATE_READ_FAILED',
          'PORTABLE_STATE_TOO_LARGE',
          'PORTABLE_STATE_INVALID',
        ].includes(error.message)
      ) {
        throw error
      }
      throw new Error('PORTABLE_STATE_READ_FAILED', { cause: error })
    } finally {
      await file.close().catch(() => {
        throw new Error('PORTABLE_STATE_READ_FAILED')
      })
    }
  }
  return paths.length
}

function invalid(): never {
  throw new Error('PORTABLE_STATE_INVALID')
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid()
  return record
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid()
  return value
}

function strings(record: Record<string, unknown>, keys: string[]): void {
  if (keys.some((key) => typeof record[key] !== 'string')) invalid()
}

function booleans(record: Record<string, unknown>, keys: string[]): void {
  if (keys.some((key) => typeof record[key] !== 'boolean')) invalid()
}

function keyPath(record: Record<string, unknown>): void {
  if ('keyPath' in record && typeof record.keyPath !== 'string') invalid()
  if (
    'keyPathArray' in record &&
    array(record.keyPathArray).some((entry) => typeof entry !== 'string')
  ) {
    invalid()
  }
  if ('keyPath' in record && 'keyPathArray' in record) invalid()
}

function encodedValue(value: unknown, refs = new Set<number>()): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return
  }
  // Match the structured-value variants used by the pinned Playwright serializer.
  // Unknown variants would otherwise silently decode into plain objects/undefined.
  const record = object(value, [
    'id',
    'ref',
    'v',
    'd',
    'u',
    'bi',
    'e',
    'r',
    'a',
    'o',
    'm',
    's',
    'ta',
    'ab',
  ])
  const tags = Object.keys(record).filter((key) => key !== 'id')
  if (tags.length !== 1) invalid()
  const tag = tags[0]!
  if (['a', 'o', 'm', 's'].includes(tag)) {
    if (!Number.isSafeInteger(record.id) || Number(record.id) <= 0) invalid()
    const id = Number(record.id)
    if (refs.has(id)) invalid()
    refs.add(id)
    for (const entry of array(record[tag])) {
      if (tag === 'a' || tag === 's') {
        encodedValue(entry, refs)
      } else {
        const pair = object(entry, ['k', 'v'])
        if (!('v' in pair)) invalid()
        if (tag === 'o') strings(pair, ['k'])
        else encodedValue(pair.k, refs)
        encodedValue(pair.v, refs)
      }
    }
    return
  }
  if ('id' in record) invalid()
  if (tag === 'ref') {
    if (!refs.has(Number(record.ref))) invalid()
  } else if (tag === 'v') {
    if (
      !['undefined', 'null', 'NaN', 'Infinity', '-Infinity', '-0'].includes(
        String(record.v),
      )
    )
      invalid()
  } else if (['d', 'u', 'bi'].includes(tag)) {
    strings(record, [tag])
  } else if (tag === 'e') {
    const error = object(record.e, ['n', 'm', 's'])
    strings(error, ['n', 'm'])
    if ('s' in error) strings(error, ['s'])
  } else if (tag === 'r') {
    strings(object(record.r, ['p', 'f']), ['p', 'f'])
  } else if (tag === 'ta' || tag === 'ab') {
    const bytes = object(record[tag], tag === 'ta' ? ['b', 'k'] : ['b'])
    strings(bytes, ['b'])
    if (
      tag === 'ta' &&
      ![
        'i8',
        'ui8',
        'ui8c',
        'i16',
        'ui16',
        'i32',
        'ui32',
        'f32',
        'f64',
        'bi64',
        'bui64',
      ].includes(String(bytes.k))
    )
      invalid()
  } else {
    invalid()
  }
}

function indexedDatabase(value: unknown): void {
  const database = object(value, ['name', 'version', 'stores'])
  strings(database, ['name'])
  if (!Number.isSafeInteger(database.version) || Number(database.version) <= 0) invalid()
  for (const entry of array(database.stores)) {
    const store = object(entry, [
      'name',
      'autoIncrement',
      'keyPath',
      'keyPathArray',
      'records',
      'indexes',
    ])
    strings(store, ['name'])
    booleans(store, ['autoIncrement'])
    keyPath(store)
    for (const entry of array(store.records)) {
      const record = object(entry, ['key', 'keyEncoded', 'value', 'valueEncoded'])
      if (
        !('value' in record || 'valueEncoded' in record) ||
        ('value' in record && 'valueEncoded' in record) ||
        ('key' in record && 'keyEncoded' in record)
      ) {
        invalid()
      }
      if ('keyEncoded' in record) encodedValue(record.keyEncoded)
      if ('valueEncoded' in record) encodedValue(record.valueEncoded)
    }
    for (const entry of array(store.indexes)) {
      const index = object(entry, [
        'name',
        'keyPath',
        'keyPathArray',
        'multiEntry',
        'unique',
      ])
      strings(index, ['name'])
      booleans(index, ['multiEntry', 'unique'])
      keyPath(index)
      if (!('keyPath' in index || 'keyPathArray' in index)) invalid()
    }
  }
}

export function parsePortableState(value: unknown): PortableState {
  const envelope = object(value, ['schemaVersion', 'storageState'])
  if (envelope.schemaVersion !== 1) invalid()
  const state = object(envelope.storageState, ['cookies', 'origins'])
  for (const entry of array(state.cookies)) {
    const cookie = object(entry, [
      'name',
      'value',
      'domain',
      'path',
      'expires',
      'httpOnly',
      'secure',
      'sameSite',
      'partitionKey',
      '_crHasCrossSiteAncestor',
    ])
    strings(cookie, ['name', 'value', 'domain', 'path'])
    booleans(cookie, ['httpOnly', 'secure'])
    if (
      typeof cookie.expires !== 'number' ||
      !Number.isFinite(cookie.expires) ||
      !['Strict', 'Lax', 'None'].includes(String(cookie.sameSite)) ||
      ('partitionKey' in cookie && typeof cookie.partitionKey !== 'string') ||
      ('_crHasCrossSiteAncestor' in cookie &&
        typeof cookie._crHasCrossSiteAncestor !== 'boolean')
    ) {
      invalid()
    }
  }
  const origins = new Set<string>()
  for (const entry of array(state.origins)) {
    const origin = object(entry, ['origin', 'localStorage', 'indexedDB', 'opfs'])
    strings(origin, ['origin'])
    let url: URL
    try {
      url = new URL(String(origin.origin))
    } catch {
      invalid()
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin.origin ||
      origins.has(url.origin)
    ) {
      invalid()
    }
    origins.add(url.origin)
    for (const entry of array(origin.localStorage)) {
      strings(object(entry, ['name', 'value']), ['name', 'value'])
    }
    if ('indexedDB' in origin) {
      for (const database of array(origin.indexedDB)) indexedDatabase(database)
    }
    if ('opfs' in origin) {
      for (const entry of array(origin.opfs)) {
        const file = object(entry, ['type', 'path', 'base64'])
        strings(file, ['type', 'path'])
        if (
          !['file', 'directory'].includes(String(file.type)) ||
          String(file.path)
            .split('/')
            .some((part) => ['', '.', '..'].includes(part)) ||
          (file.type === 'file' &&
            (typeof file.base64 !== 'string' ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                file.base64,
              ))) ||
          (file.type === 'directory' && 'base64' in file)
        ) {
          invalid()
        }
      }
    }
  }
  // Keep the original payload, including IndexedDB encoded values and partitioned cookies.
  return value as PortableState
}

export async function restorePortableState(
  context: BrowserContext,
  userDataDir: string,
  consume = true,
): Promise<void> {
  const path = join(dirname(userDataDir), 'portable-state.json')
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw new Error('PORTABLE_STATE_READ_FAILED', { cause: error })
  }
  let state: PortableState
  try {
    state = parsePortableState(JSON.parse(contents) as unknown)
  } catch {
    throw new Error('PORTABLE_STATE_INVALID')
  }
  try {
    // Public API initializes origins using intercepted blank pages, with no site requests.
    // It also restores Playwright's structured IndexedDB values and partitioned cookies.
    await withinProfileDeadline(
      context.setStorageState(state.storageState),
      30_000,
      'PORTABLE_STATE_RESTORE_TIMEOUT',
    )
  } catch (error) {
    throw new Error('PORTABLE_STATE_RESTORE_FAILED', { cause: error })
  }
  if (consume) {
    try {
      await unlink(path)
    } catch (error) {
      throw new Error('PORTABLE_STATE_CONSUME_FAILED', { cause: error })
    }
  }
}
