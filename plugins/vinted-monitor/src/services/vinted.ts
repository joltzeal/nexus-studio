import { UpstreamError } from '../domain/errors.js'
import { parseItemsPage, type ItemsPage } from '../domain/items.js'
import { numericId, record } from '../domain/sellers.js'
import type { ProxyRecord } from '../domain/types.js'
import { itemPageUrl, itemRequestUrl, type MonitorTarget } from '../domain/urls.js'
import { createProxyTransport } from './proxy-transport.js'
import { readBody } from './body.js'

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
  private readonly injectedFetch: typeof fetch | undefined

  constructor(options: VintedClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.injectedFetch = options.fetchImpl
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
    const result = parseItemsPage(payload, perPage, (id) => itemPageUrl(target, id), page)
    if (
      target.kind === 'member' &&
      result.items.some((item) => item.userId !== target.userId)
    ) {
      throw new UpstreamError('invalid-response')
    }
    return result
  }

  async user(domain: string, userId: string): Promise<Record<string, unknown>> {
    const payload = record(await this.json(`https://${domain}/api/v2/users/${userId}`))
    const profile = record(payload?.user)
    if (
      !profile ||
      (payload?.code !== undefined && payload.code !== 0) ||
      numericId(profile.id) !== userId
    ) {
      throw new UpstreamError('invalid-response')
    }
    return profile
  }

  scope(proxy: Readonly<ProxyRecord> | null): {
    client: VintedClient
    transport: ReturnType<typeof createProxyTransport>
  } {
    const transport = createProxyTransport(proxy, this.fetchImpl, this.injectedFetch)
    return {
      transport,
      client: new VintedClient({
        fetchImpl: transport.fetch,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
      }),
    }
  }

  private async json(url: string): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': USER_AGENT,
        },
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw reasonForStatus(response.status)
      }
      const body = await readBody(response, this.maxBytes, controller.signal)
      try {
        return JSON.parse(body.toString('utf8')) as unknown
      } catch {
        throw new UpstreamError('invalid-response')
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error
      if (isAbort(error) || controller.signal.aborted) throw new UpstreamError('timeout')
      if (error instanceof RangeError) throw new UpstreamError('invalid-response')
      throw new UpstreamError('upstream-network')
    } finally {
      clearTimeout(timer)
    }
  }
}
