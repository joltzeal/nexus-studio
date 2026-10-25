import { UpstreamError, type UpstreamPhase } from '../domain/errors.js'
import { parseItemsPage, type ItemsPage } from '../domain/items.js'
import { numericId, record } from '../domain/sellers.js'
import type { ProxyRecord } from '../domain/types.js'
import {
  itemPageUrl,
  itemRequestUrl,
  storefrontOrigin,
  stripWww,
  type MonitorTarget,
} from '../domain/urls.js'
import { createProxyTransport } from './proxy-transport.js'
import { readBody } from './body.js'
import { networkFailure, statusFailure } from './request-errors.js'
import { AnonymousSession } from './session.js'

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

export class VintedClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly injectedFetch: typeof fetch | undefined
  private readonly sessions = new Map<string, AnonymousSession>()

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
    const payload = await this.json(target.host, url, 'items')
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
    if (numericId(userId) !== userId) throw new UpstreamError('invalid-response')
    const payload = record(
      await this.json(
        domain,
        `${storefrontOrigin(domain)}/api/v2/users/${userId}`,
        'user',
      ),
    )
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
    const client = new VintedClient({
      fetchImpl: transport.fetch,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
    })
    return {
      transport: {
        ...transport,
        close: async () => {
          for (const session of client.sessions.values()) session.clear()
          client.sessions.clear()
          await transport.close()
        },
      },
      client,
    }
  }

  private async request(
    session: AnonymousSession,
    url: string,
    method: 'HEAD' | 'GET',
    signal: AbortSignal,
    phase: UpstreamPhase,
  ): Promise<Response> {
    try {
      const cookie = session.cookieHeader(url)
      const response = await this.fetchImpl(url, {
        method,
        redirect: 'manual',
        credentials: 'omit',
        signal,
        headers: {
          accept: method === 'HEAD' ? 'text/html' : 'application/json',
          'accept-language': session.locale,
          'user-agent': USER_AGENT,
          locale: session.locale,
          platform: 'web',
          'x-next-app': 'marketplace-web',
          'x-money-object': 'true',
          origin: session.origin,
          referer: `${session.origin}/`,
          ...(cookie ? { cookie } : {}),
        },
      })
      session.accept(url, response)
      return response
    } catch (error) {
      if (signal.aborted) throw new UpstreamError('timeout', null, { phase })
      throw networkFailure(error, phase)
    }
  }

  private async initialize(session: AnonymousSession, signal: AbortSignal) {
    session.clear()
    const response = await this.request(
      session,
      `${session.origin}/`,
      'HEAD',
      signal,
      'session',
    )
    await response.body?.cancel()
    if (!response.ok) {
      session.clear()
      throw statusFailure(response.status, 'session')
    }
    session.ready = true
  }

  private async json(
    domain: string,
    url: string,
    phase: UpstreamPhase,
  ): Promise<unknown> {
    const host = stripWww(domain)
    let session = this.sessions.get(host)
    if (!session) {
      session = new AnonymousSession(host)
      this.sessions.set(host, session)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)

    try {
      if (!session.ready) await this.initialize(session, controller.signal)
      let response = await this.request(session, url, 'GET', controller.signal, phase)
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel()
        await this.initialize(session, controller.signal)
        response = await this.request(session, url, 'GET', controller.signal, phase)
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw statusFailure(response.status, phase)
      }
      const body = await readBody(response, this.maxBytes, controller.signal)
      try {
        return JSON.parse(body.toString('utf8')) as unknown
      } catch {
        throw new UpstreamError('invalid-response', null, { phase })
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error
      if (controller.signal.aborted) throw new UpstreamError('timeout', null, { phase })
      if (error instanceof RangeError)
        throw new UpstreamError('invalid-response', null, { phase })
      throw networkFailure(error, phase)
    } finally {
      clearTimeout(timer)
    }
  }
}
