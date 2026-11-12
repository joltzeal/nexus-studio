import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Parser } from 'htmlparser2'
import {
  cancelled,
  invalidRequest,
  isPluginFailure,
  protocolError,
  timedOut,
  unavailable,
} from '../domain/errors.js'
import type { MailFolder, MailSession } from '../domain/types.js'

export const TIMEOUT_MS = 30_000
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024

export async function bounded<T>(
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
  onAbort: () => void = () => {},
): Promise<T> {
  if (signal.aborted) throw cancelled()
  const controller = new AbortController()
  let expired = false
  const failure = () => (expired ? timedOut('Email request timed out') : cancelled())
  const abort = () => controller.abort()
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onChildAbort = () => {
    rejectAbort(failure())
    try {
      onAbort()
    } catch {
      // Cleanup must never replace a safe cancellation error.
    }
  }
  controller.signal.addEventListener('abort', onChildAbort, { once: true })
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, TIMEOUT_MS)
  try {
    const result = await Promise.race([operation(controller.signal), aborted])
    if (controller.signal.aborted) throw failure()
    return result
  } catch (error) {
    if (controller.signal.aborted) throw failure()
    if (isPluginFailure(error)) throw error
    throw unavailable('Email server connection failed')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onChildAbort)
    controller.abort()
  }
}

export function capText(
  text: string,
  limit = MAX_BODY_BYTES,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return { text, truncated: false }
  let end = limit
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

const invisible = new Set(['script', 'style', 'head', 'template', 'noscript'])
const blocks = new Set([
  'p',
  'div',
  'br',
  'li',
  'tr',
  'table',
  'section',
  'article',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'hr',
])

export function htmlText(html: string): string {
  const parts: string[] = []
  let hidden = 0
  const parser = new Parser(
    {
      onopentag(name) {
        if (invisible.has(name)) hidden++
        if (!hidden && blocks.has(name)) parts.push('\n')
      },
      ontext(text) {
        if (!hidden) parts.push(text)
      },
      onclosetag(name) {
        if (invisible.has(name)) hidden = Math.max(0, hidden - 1)
        if (!hidden && blocks.has(name)) parts.push('\n')
      },
    },
    { decodeEntities: true },
  )
  parser.end(html)
  return parts
    .join('')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{2,}/gu, '\n')
    .trim()
}

export function accountKey(session: MailSession): string {
  return createHash('sha256').update(session.email.toLowerCase()).digest('hex')
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

export function checkSession(session: MailSession): void {
  if (
    !session ||
    typeof session.email !== 'string' ||
    !session.email ||
    session.email.length > 254 ||
    /\s/u.test(session.email) ||
    hasControlCharacters(session.email) ||
    typeof session.accessToken !== 'string' ||
    !session.accessToken ||
    session.accessToken.length > 16 * 1024 ||
    /\s/u.test(session.accessToken) ||
    hasControlCharacters(session.accessToken)
  )
    throw invalidRequest('Email session is invalid')
}

export function checkFolder(folder: MailFolder): void {
  if (folder !== 'inbox' && folder !== 'junkemail') {
    throw invalidRequest('Email folder is not supported')
  }
}

export class OpaqueCursor {
  private readonly key = randomBytes(32)

  encode(value: unknown): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
    const signature = this.sign(payload).toString('base64url')
    const cursor = `${payload}.${signature}`
    if (cursor.length > 16 * 1024) {
      throw protocolError('Email pagination response is too large')
    }
    return cursor
  }

  decode(cursor: string): unknown {
    if (typeof cursor !== 'string' || cursor.length > 16 * 1024) {
      throw invalidRequest('Email cursor is invalid')
    }
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(cursor)
    if (!match?.[1] || !match[2]) throw invalidRequest('Email cursor is invalid')
    const signature = Buffer.from(match[2], 'base64url')
    const expected = this.sign(match[1])
    if (
      signature.toString('base64url') !== match[2] ||
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    )
      throw invalidRequest('Email cursor is invalid')
    try {
      const payload = Buffer.from(match[1], 'base64url')
      if (payload.toString('base64url') !== match[1]) {
        throw invalidRequest('Email cursor is invalid')
      }
      return JSON.parse(payload.toString('utf8')) as unknown
    } catch {
      throw invalidRequest('Email cursor is invalid')
    }
  }

  private sign(payload: string): Buffer {
    return createHmac('sha256', this.key).update(payload).digest()
  }
}
