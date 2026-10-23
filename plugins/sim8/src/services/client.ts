import {
  authFailed,
  invalidRequest,
  rateLimited,
  timedOut,
  unavailable,
} from '../domain/errors.js'

/** The documented service host; a user may point the plugin at another one. */
export const DEFAULT_BASE_URL = 'https://api.cc'
const DEFAULT_TIMEOUT_MS = 20_000

export interface Envelope {
  code: number
  msg: string
  time: number
  data: unknown
}

export interface Sim8ClientOptions {
  baseUrl: string
  token: string
  /** Injected by tests so no request leaves the process. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Accepts what people actually paste: a bare host, a host with a path, or the
 * full URL from the provider's console. Anything that is not http(s) is refused
 * here rather than becoming a confusing network error later.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') return DEFAULT_BASE_URL
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw invalidRequest('接口地址不是有效 URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidRequest('接口地址只支持 http 或 https')
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidRequest('接口地址不能包含用户名或密码')
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/**
 * The console hands out the raw token, but people copy the header value too.
 * Storing the bare token keeps a `Bearer ` prefix from being sent twice.
 */
export function normalizeToken(input: string): string {
  return input.trim().replace(/^bearer\s+/i, '')
}

function parseEnvelope(raw: string): Envelope | null {
  if (raw.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record['code'] === undefined) return null
  const code = Number(record['code'])
  if (!Number.isFinite(code)) return null
  return {
    code,
    msg: typeof record['msg'] === 'string' ? record['msg'].trim() : '',
    time: Number(record['time'] ?? 0) || 0,
    data: record['data'],
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    ((error as { name?: unknown }).name === 'TimeoutError' ||
      (error as { name?: unknown }).name === 'AbortError')
  )
}

/**
 * Line-delimited JSON RPC on one side, a `{code,msg,data}` envelope on the
 * other. The provider answers HTTP 200 for business failures, so `code` — not
 * the status line — decides what happened.
 */
export class Sim8Client {
  private readonly baseUrl: string
  private readonly token: string
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number

  constructor(options: Sim8ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.doFetch = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return this.send<T>(url.toString(), { method: 'GET' })
  }

  post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.send<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** `filter/create` is the one endpoint that takes a real file upload. */
  postForm<T>(path: string, form: FormData): Promise<T> {
    // No content-type: fetch has to add the multipart boundary itself.
    return this.send<T>(`${this.baseUrl}${path}`, { method: 'POST', body: form })
  }

  private async send<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await this.doFetch(url, {
        ...init,
        redirect: 'follow',
        headers: {
          accept: 'application/json',
          ...(this.token === '' ? {} : { authorization: this.token }),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      if (isTimeout(error)) throw timedOut('接口请求超时，请稍后重试')
      throw unavailable('无法连接 SIM8 接口，请检查网络与接口地址', error)
    }

    const raw = await response.text().catch(() => '')
    const envelope = parseEnvelope(raw)

    if (response.status === 401 || response.status === 403) {
      throw authFailed(envelope?.msg || '接口 Token 无效或已过期，请在设置里重新填写')
    }
    if (response.status === 429) {
      throw rateLimited(envelope?.msg || '接口请求过于频繁，请稍后再试')
    }
    if (envelope === null) {
      if (!response.ok) {
        throw unavailable(`接口返回 HTTP ${String(response.status)}`)
      }
      // No envelope but a 2xx: treat the body as the payload so a proxy or a
      // mirror that drops the wrapper still works.
      return parseLoose(raw) as T
    }
    if (envelope.code === 1) return envelope.data as T
    if (envelope.code === 401 || envelope.code === 403) {
      throw authFailed(envelope.msg || '接口 Token 无效或已过期，请在设置里重新填写')
    }
    if (envelope.code === 429) {
      throw rateLimited(envelope.msg || '接口请求过于频繁，请稍后再试')
    }
    // A business failure carries the provider's own reason ("库存不足"), which is
    // the most useful thing the page can show.
    throw unavailable(
      oneLine(envelope.msg) || `接口返回失败（code ${String(envelope.code)}）`,
    )
  }
}

function parseLoose(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}
