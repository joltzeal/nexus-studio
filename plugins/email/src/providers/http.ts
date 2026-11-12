import { cancelled, PluginFailure, protocolError } from '../domain/errors.js'
import { bounded, MAX_SOURCE_BYTES } from './support.js'

type HttpKind = 'token' | 'graph'

const authErrors = new Set([
  'invalid_grant',
  'invalid_client',
  'interaction_required',
  'login_required',
  'consent_required',
])

function oauthFailure(body: unknown, response: Response): PluginFailure | undefined {
  if (!body || typeof body !== 'object' || !('error' in body)) return
  const code = body.error
  if (typeof code !== 'string') return
  if (authErrors.has(code)) {
    return new PluginFailure('AUTH_FAILED', 'Microsoft authorization must be renewed')
  }
  if (['invalid_scope', 'unauthorized_client', 'access_denied'].includes(code)) {
    return new PluginFailure('PERMISSION_DENIED', 'Microsoft mail permission is missing')
  }
  if (['temporarily_unavailable', 'server_error'].includes(code)) {
    return new PluginFailure(
      'UNAVAILABLE',
      'Microsoft authorization is temporarily unavailable',
      retryAfter(response),
    )
  }
  return protocolError('Microsoft authorization response is invalid')
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('Retry-After')
  if (!header || header.length > 128) return
  const value = /^\d+$/u.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - Date.now()
  if (!Number.isFinite(value)) return
  return Math.max(1000, Math.min(3_600_000, value))
}

function httpFailure(response: Response): PluginFailure {
  switch (response.status) {
    case 401:
      return new PluginFailure('AUTH_FAILED', 'Microsoft authorization must be renewed')
    case 403:
      return new PluginFailure(
        'PERMISSION_DENIED',
        'Microsoft mail permission is missing',
      )
    case 429:
      return new PluginFailure(
        'RATE_LIMITED',
        'Microsoft request rate limit reached',
        retryAfter(response),
      )
    case 408:
    case 504:
      return new PluginFailure(
        'TIMEOUT',
        'Microsoft request timed out',
        retryAfter(response),
      )
    default:
      return response.status >= 500
        ? new PluginFailure(
            'UNAVAILABLE',
            'Microsoft service is temporarily unavailable',
            retryAfter(response),
          )
        : protocolError('Microsoft request was rejected')
  }
}

function discard(response: Response): void {
  if (response.body) void response.body.cancel().catch(() => {})
}

async function readJson(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get('Content-Length')
  if (length && /^\d+$/u.test(length) && Number(length) > limit) {
    discard(response)
    throw protocolError('Microsoft response exceeds the size limit')
  }
  if (!response.body) throw protocolError('Microsoft response is empty')
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) {
        abort()
        throw protocolError('Microsoft response exceeds the size limit')
      }
      chunks.push(chunk.value)
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      return JSON.parse(text) as unknown
    } catch {
      throw protocolError('Microsoft response is not valid JSON')
    }
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

export class MicrosoftHttp {
  constructor(private readonly fetchImpl?: typeof fetch) {}

  json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    kind: HttpKind,
  ): Promise<unknown> {
    return bounded(signal, async (requestSignal) => {
      const response = await (this.fetchImpl ?? globalThis.fetch)(url, {
        ...init,
        redirect: 'error',
        signal: requestSignal,
      })
      if (requestSignal.aborted) {
        discard(response)
        throw cancelled()
      }
      if (!response.ok && (kind !== 'token' || response.status !== 400)) {
        discard(response)
        throw httpFailure(response)
      }
      const body = await readJson(
        response,
        kind === 'token' ? 128 * 1024 : MAX_SOURCE_BYTES,
        requestSignal,
      )
      if (kind === 'token') {
        const failure = oauthFailure(body, response)
        if (failure) throw failure
      }
      if (!response.ok) throw httpFailure(response)
      return body
    })
  }
}
