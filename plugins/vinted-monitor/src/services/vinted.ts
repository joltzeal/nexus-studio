import { UpstreamError } from '../domain/errors.js'
import { parseItemsPage, type ItemsPage } from '../domain/items.js'
import { itemPageUrl, itemRequestUrl, type MonitorTarget } from '../domain/urls.js'

/**
 * Vinted serves the same JSON to its own web client. A desktop user agent is
 * used because the endpoints reject obviously non-browser clients.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const REQUEST_TIMEOUT_MS = 20_000
const MAX_BYTES = 4 * 1024 * 1024

export interface VintedClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
}

function reasonForStatus(status: number): UpstreamError {
  if (status === 429) return new UpstreamError('rate-limit')
  if (status === 401 || status === 403) return new UpstreamError('blocked')
  if (status === 408 || status === 504) return new UpstreamError('timeout')
  if (status === 404) return new UpstreamError('upstream-refused', '页面不存在')
  if (status >= 500) return new UpstreamError('unavailable')
  return new UpstreamError('upstream-network')
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

export class VintedClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxBytes: number

  constructor(options: VintedClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.maxBytes = options.maxBytes ?? MAX_BYTES
  }

  /**
   * One page of listings for a monitor. Failures are raised as `UpstreamError`
   * so the run record can say *why* a page failed, not just that it did.
   */
  async items(target: MonitorTarget, page: number, perPage: number): Promise<ItemsPage> {
    const url = itemRequestUrl(target, page, perPage)
    const payload = await this.json(url)
    return parseItemsPage(payload, perPage, (id) => itemPageUrl(target, id))
  }

  private async json(url: string): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': USER_AGENT,
        },
      })
    } catch (error) {
      if (isAbort(error)) throw new UpstreamError('timeout')
      throw new UpstreamError('upstream-network')
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      // Drain the body so the connection can be reused; the content itself is
      // never shown to the user.
      await response.text().catch(() => '')
      throw reasonForStatus(response.status)
    }

    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new UpstreamError('invalid-response', '响应超过大小上限')
    }

    let body: string
    try {
      body = await response.text()
    } catch {
      throw new UpstreamError('upstream-network')
    }
    if (body.length > this.maxBytes) {
      throw new UpstreamError('invalid-response', '响应超过大小上限')
    }

    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new UpstreamError('invalid-response')
    }
  }
}
