import { Parser } from 'htmlparser2'
import { CookieJar } from 'tough-cookie'

import { invalidRequest, isPluginFailure, unavailable } from '../domain/errors.js'

export interface SnapshotItem {
  id: string
  url: string
  title: string
  imageUrl: string | null
}

export interface OrderSource {
  scan(homepageUrl: string, signal: AbortSignal): Promise<SnapshotItem[]>
  check(
    item: SnapshotItem,
    homepageUrl: string,
    signal: AbortSignal,
  ): Promise<{ sold: boolean; error: string | null }>
}

export const VINTED_DOMAINS: readonly string[] = Object.freeze([
  'vinted.com',
  'vinted.co.uk',
  'vinted.at',
  'vinted.be',
  'vinted.cz',
  'vinted.de',
  'vinted.dk',
  'vinted.ee',
  'vinted.es',
  'vinted.fi',
  'vinted.fr',
  'vinted.gr',
  'vinted.hr',
  'vinted.hu',
  'vinted.ie',
  'vinted.it',
  'vinted.lt',
  'vinted.lv',
  'vinted.nl',
  'vinted.pl',
  'vinted.pt',
  'vinted.ro',
  'vinted.se',
  'vinted.si',
  'vinted.sk',
])

const KNOWN_HOSTS = new Set(VINTED_DOMAINS)
const PER_PAGE = 96
const MAX_PAGES = 20
const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_HTML_BYTES = 2_000_000
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numericId(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))
    return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const text = String(value)
  if (!/^\d{1,32}$/.test(text)) return null
  return text.replace(/^0+/, '') || null
}

function safeUrl(value: unknown): URL | null {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    [...value].some((character) => character.charCodeAt(0) <= 0x20 || character === '\\')
  )
    return null
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.port ? url : null
  } catch {
    return null
  }
}

export function parseHomepage(value: string): {
  url: string
  host: string
  userId: string
} {
  const parsed = safeUrl(typeof value === 'string' ? value.trim() : value)
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:'))
    throw invalidRequest('Vinted 主页链接必须是有效的 HTTP(S) 衣柜地址')
  const host = parsed.hostname.replace(/^www\./, '')
  const member = /^\/member\/(\d{1,32})(?:-[^/]+)?\/?$/.exec(parsed.pathname)
  const userId = numericId(member?.[1])
  if (!KNOWN_HOSTS.has(host) || !userId)
    throw invalidRequest('Vinted 主页链接须使用支持的站点和 /member/<id> 路径')
  return { url: `https://www.${host}/member/${userId}`, host, userId }
}

function itemUrl(value: unknown, id: string, host: string): string {
  const origin = `https://www.${host}`
  const candidate =
    typeof value === 'string' && value.startsWith('/') ? `${origin}${value}` : value
  const parsed = safeUrl(candidate)
  const match = parsed && /^\/items\/(\d{1,32})(?:-[^/]+)?\/?$/.exec(parsed.pathname)
  if (
    !parsed ||
    parsed.protocol !== 'https:' ||
    parsed.hostname.replace(/^www\./, '') !== host ||
    numericId(match?.[1]) !== id
  )
    throw invalidRequest('Vinted 商品链接与衣柜站点或商品 ID 不一致')
  return `${origin}${parsed.pathname.replace(/\/$/, '')}`
}

function snapshotItem(value: unknown, host: string, userId: string): SnapshotItem {
  const raw = record(value)
  const id = numericId(raw?.id)
  if (!raw || !id || typeof raw.title !== 'string' || !raw.title.trim())
    throw unavailable('Vinted 衣柜包含无效商品，本次扫描不更新完整快照')
  const sellerIds = [raw.user_id, record(raw.user)?.id]
    .filter((entry) => entry !== undefined && entry !== null)
    .map(numericId)
  if (sellerIds.length === 0 || sellerIds.some((seller) => seller !== userId))
    throw unavailable('Vinted 衣柜商品的卖家与主页不一致')
  // Validate every supplied URL alias, even when another alias would be usable.
  const urls = [raw.url, raw.item_url].filter(
    (entry) => entry !== undefined && entry !== null,
  )
  const parsedUrls = urls.map((entry) => itemUrl(entry, id, host))
  const photo =
    record(raw.photo) ?? (Array.isArray(raw.photos) ? record(raw.photos[0]) : null)
  const image = safeUrl(photo?.url ?? photo?.full_size_url)
  return {
    id,
    url: parsedUrls[0] ?? `https://www.${host}/items/${id}`,
    title: raw.title.trim().slice(0, 500),
    imageUrl:
      image?.protocol === 'https:' || image?.protocol === 'http:' ? image.href : null,
  }
}

interface Pagination {
  totalPages: number | null
  totalEntries: number | null
}

function pagination(
  value: unknown,
  page: number,
  received: number,
  accumulated: number,
  previous: Pagination,
): Pagination & { hasMore: boolean } {
  const fail = () => unavailable('Vinted 衣柜分页无效或已截断，本次扫描不更新完整快照')
  if (received > PER_PAGE) throw fail()
  const raw = record(value)
  if (value !== undefined && value !== null && !raw) throw fail()
  const count = (key: string): number | null => {
    const field = raw?.[key]
    if (field === undefined) return null
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0)
      throw fail()
    return field
  }
  const current = count('current_page')
  const perPage = count('per_page')
  const declaredPages = count('total_pages')
  const declaredEntries = count('total_entries')
  if (
    (current !== null && current !== page) ||
    (perPage !== null && perPage !== PER_PAGE)
  )
    throw fail()
  if (
    (declaredPages !== null &&
      previous.totalPages !== null &&
      declaredPages !== previous.totalPages) ||
    (declaredEntries !== null &&
      previous.totalEntries !== null &&
      declaredEntries !== previous.totalEntries)
  )
    throw fail()
  const totalPages = declaredPages ?? previous.totalPages
  const totalEntries = declaredEntries ?? previous.totalEntries
  if (
    (totalPages !== null && totalPages > MAX_PAGES) ||
    (totalEntries !== null && totalEntries > MAX_PAGES * PER_PAGE)
  )
    throw unavailable('Vinted 衣柜超过 20 页扫描上限，本次扫描不更新完整快照')
  if (
    totalPages !== null &&
    (totalPages < page || (received === 0 && page > 1)) &&
    !(page === 1 && received === 0 && totalPages === 0)
  )
    throw fail()
  if (totalEntries !== null && accumulated > totalEntries) throw fail()
  if (
    totalPages !== null &&
    totalEntries !== null &&
    totalPages !== Math.ceil(totalEntries / PER_PAGE) &&
    !(totalPages === 1 && totalEntries === 0)
  )
    throw fail()
  const signals: boolean[] = []
  if (totalPages !== null) signals.push(page < totalPages)
  if (totalEntries !== null) signals.push(accumulated < totalEntries)
  if (raw?.next_page !== undefined) {
    const next = raw.next_page
    if (next !== null && (typeof next !== 'number' || next !== page + 1)) throw fail()
    signals.push(next !== null)
  }
  if (new Set(signals).size > 1) throw fail()
  const hasMore = signals[0] ?? received === PER_PAGE
  // A clamped or short intermediate page cannot establish a complete baseline.
  if (hasMore && received !== PER_PAGE) throw fail()
  return { hasMore, totalPages, totalEntries }
}

interface HtmlFrame {
  hidden: boolean
  cell: boolean
  block: boolean
  text: string
}

const IGNORED_TAGS = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'head',
  'textarea',
])
const HIDDEN_CLASSES = new Set(['hidden', 'sr-only', 'visually-hidden'])
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
])

function hiddenAttributes(attrs: Record<string, string>): boolean {
  if ('hidden' in attrs || attrs['aria-hidden']?.trim().toLowerCase() === 'true')
    return true
  if ((attrs.class ?? '').split(/\s+/).some((name) => HIDDEN_CLASSES.has(name)))
    return true
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden|opacity\s*:\s*(?:0(?:\.0*)?|\.0+))\s*(?:!important\s*)?(?:;|$)/i.test(
    (attrs.style ?? '').replace(/\/\*[\s\S]*?\*\//g, ''),
  )
}

/** Parse text nodes only; a cell must close explicitly to provide sale evidence. */
export function isSoldHtml(html: string): boolean {
  const frames: HtmlFrame[] = []
  let sold = false
  const append = (frame: HtmlFrame, text: string) => {
    // More than eight normalized characters can never become the exact "Sold".
    frame.text = (frame.text + text.replace(/\s+/g, ' ')).replace(/ +/g, ' ').slice(0, 8)
  }
  const parser = new Parser({
    onopentag(name, attrs) {
      const parent = frames.at(-1)
      const block = BLOCK_TAGS.has(name)
      const hidden =
        Boolean(parent?.hidden) ||
        IGNORED_TAGS.has(name) ||
        ((name === 'details' || name === 'dialog') && !('open' in attrs)) ||
        hiddenAttributes(attrs)
      if (block && parent && !hidden) append(parent, ' ')
      frames.push({
        hidden,
        cell:
          name === 'div' &&
          (attrs.class ?? '').split(/\s+/).includes('web_ui__Cell__success'),
        block,
        text: '',
      })
    },
    ontext(text) {
      const frame = frames.at(-1)
      if (frame && !frame.hidden) append(frame, text)
    },
    onclosetag(_name, implied) {
      const frame = frames.pop()
      if (!frame || frame.hidden) return
      if (!implied && frame.cell && frame.text.trim() === 'Sold') sold = true
      const parent = frames.at(-1)
      if (parent && !parent.hidden) append(parent, frame.text + (frame.block ? ' ' : ''))
    },
  })
  parser.end(html)
  return sold
}

interface Session {
  jar: CookieJar
  ready: boolean
}

interface Operation {
  signal: AbortSignal
  refreshed: boolean
}

function interruption(signal: AbortSignal): Error {
  return isPluginFailure(signal.reason) ? signal.reason : unavailable('Vinted 请求已取消')
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw interruption(signal)
}

/** A fetch implementation or stream may ignore AbortSignal; bound its await too. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(interruption(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(interruption(signal))
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined)
}

async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) throw unavailable('Vinted 响应缺少正文')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  let complete = false
  try {
    const declared = response.headers.get('content-length')
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes)
      throw unavailable('Vinted 响应正文超过大小上限')
    for (;;) {
      assertActive(signal)
      let part: Awaited<ReturnType<typeof reader.read>>
      try {
        part = await bounded(reader.read(), signal)
      } catch {
        assertActive(signal)
        throw unavailable('Vinted 响应正文读取失败')
      }
      assertActive(signal)
      if (part.done) {
        complete = true
        break
      }
      size += part.value.byteLength
      if (size > maxBytes) throw unavailable('Vinted 响应正文超过大小上限')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally {
    // Do not let a broken cancellation implementation outlive the deadline.
    if (!complete) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function statusFailure(status: number, phase: string): Error {
  const reason =
    status >= 300 && status < 400
      ? '已拒绝重定向，请确认所选站点'
      : status === 401 || status === 403
        ? '访问受限或匿名会话被拒绝'
        : status === 407
          ? '代理认证被拒绝'
          : status === 429
            ? '站点限流，请稍后重试'
            : status >= 500
              ? '上游服务暂不可用'
              : '请求被拒绝'
  return unavailable(`Vinted ${phase}请求失败（HTTP ${status}）：${reason}`)
}

export class VintedOrderSource implements OrderSource {
  private readonly fetchImpl: typeof fetch
  private readonly requestDelayMs: number
  private readonly timeoutMs: number
  private readonly sessions = new Map<string, Session>()

  constructor(
    options: {
      fetchImpl?: typeof fetch
      requestDelayMs?: number
      timeoutMs?: number
    } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestDelayMs = options.requestDelayMs ?? 1000
    this.timeoutMs = options.timeoutMs ?? 60_000
    if (
      !Number.isSafeInteger(this.requestDelayMs) ||
      this.requestDelayMs < 0 ||
      this.requestDelayMs > 2_147_483_647 ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2_147_483_647
    )
      throw invalidRequest('Vinted 请求间隔和超时必须是有效的毫秒数')
  }

  async scan(homepageUrl: string, signal: AbortSignal): Promise<SnapshotItem[]> {
    const target = parseHomepage(homepageUrl)
    return this.operation(signal, async (operation) => {
      const snapshot: SnapshotItem[] = []
      const seen = new Set<string>()
      let totals: Pagination = { totalPages: null, totalEntries: null }
      for (let current = 1; current <= MAX_PAGES; current += 1) {
        if (current > 1) await this.delay(operation.signal)
        const query = new URLSearchParams({
          page: String(current),
          per_page: String(PER_PAGE),
          order: 'newest_first',
        })
        const body = await this.document(
          target.host,
          `https://www.${target.host}/api/v2/wardrobe/${target.userId}/items?${query}`,
          false,
          operation,
        )
        let payload: unknown
        try {
          payload = JSON.parse(body) as unknown
        } catch {
          throw unavailable('Vinted 衣柜响应不是有效的 JSON')
        }
        const raw = record(payload)
        if (
          !raw ||
          (raw.code !== undefined && raw.code !== 0) ||
          !Array.isArray(raw.items)
        )
          throw unavailable('Vinted 衣柜响应缺少有效的商品列表')
        if (raw.items.length > PER_PAGE)
          throw unavailable('Vinted 衣柜分页超过每页 96 件商品上限')
        for (const entry of raw.items) {
          const item = snapshotItem(entry, target.host, target.userId)
          if (seen.has(item.id))
            throw unavailable('Vinted 衣柜分页出现重复商品，本次扫描不更新完整快照')
          seen.add(item.id)
          snapshot.push(item)
        }
        const state = pagination(
          raw.pagination,
          current,
          raw.items.length,
          snapshot.length,
          totals,
        )
        totals = state
        if (!state.hasMore) return snapshot
      }
      throw unavailable('Vinted 衣柜达到 20 页上限仍不完整，本次扫描不更新完整快照')
    })
  }

  async check(
    item: SnapshotItem,
    homepageUrl: string,
    signal: AbortSignal,
  ): Promise<{ sold: boolean; error: string | null }> {
    try {
      const target = parseHomepage(homepageUrl)
      const id = numericId(item.id)
      if (!id || id !== item.id) throw invalidRequest('Vinted 商品 ID 无效')
      const url = new URL(itemUrl(item.url, id, target.host))
      url.searchParams.set('locale', 'en')
      return await this.operation(signal, async (operation) => {
        const html = await this.document(target.host, url.href, true, operation)
        return isSoldHtml(html)
          ? { sold: true, error: null }
          : { sold: false, error: 'Vinted 商品页面未显示可见的 Sold 标记' }
      })
    } catch (error) {
      return {
        sold: false,
        error: isPluginFailure(error) ? error.message : 'Vinted 商品页面请求失败',
      }
    }
  }

  private async operation<T>(
    signal: AbortSignal,
    work: (operation: Operation) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const abort = () => {
      controller.abort(unavailable('Vinted 请求已取消'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const deadline = Date.now() + this.timeoutMs
    const expire = () => {
      controller.abort(unavailable('Vinted 请求已超时，超过本次操作截止时间'))
    }
    const timer = setTimeout(expire, this.timeoutMs)
    try {
      assertActive(controller.signal)
      const result = await work({ signal: controller.signal, refreshed: false })
      if (Date.now() >= deadline) expire()
      assertActive(controller.signal)
      return result
    } catch (error) {
      assertActive(controller.signal)
      if (isPluginFailure(error)) throw error
      throw unavailable('Vinted 请求失败')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  private session(host: string): Session {
    let session = this.sessions.get(host)
    if (!session) {
      session = { jar: new CookieJar(), ready: false }
      this.sessions.set(host, session)
    }
    return session
  }

  private async request(
    session: Session,
    url: string,
    method: 'HEAD' | 'GET',
    html: boolean,
    signal: AbortSignal,
  ): Promise<Response> {
    assertActive(signal)
    let response: Response
    try {
      const origin = new URL(url).origin
      const cookie = session.jar.getCookieStringSync(url)
      const pending = this.fetchImpl(url, {
        method,
        signal,
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          accept: html ? 'text/html,application/xhtml+xml' : 'application/json',
          'accept-language': 'en-US,en;q=0.9',
          locale: 'en-US',
          'user-agent': USER_AGENT,
          platform: 'web',
          'x-next-app': 'marketplace-web',
          'x-money-object': 'true',
          origin,
          referer: `${origin}/`,
          ...(cookie ? { cookie } : {}),
        },
      }).then((result) => {
        if (signal.aborted) discard(result)
        return result
      })
      response = await bounded(pending, signal)
    } catch {
      assertActive(signal)
      throw unavailable('Vinted 网络请求失败')
    }
    if (response.redirected) {
      discard(response)
      throw unavailable('Vinted 已拒绝重定向，请确认所选站点')
    }
    for (const cookie of response.headers.getSetCookie())
      session.jar.setCookieSync(cookie, url, { ignoreError: true })
    return response
  }

  private async initialize(
    session: Session,
    host: string,
    signal: AbortSignal,
  ): Promise<void> {
    session.ready = false
    session.jar.removeAllCookiesSync()
    const response = await this.request(
      session,
      `https://www.${host}/`,
      'HEAD',
      true,
      signal,
    )
    discard(response)
    if (response.status !== 200) {
      session.jar.removeAllCookiesSync()
      throw statusFailure(response.status, '匿名会话初始化')
    }
    session.ready = true
  }

  private async document(
    host: string,
    url: string,
    html: boolean,
    operation: Operation,
  ): Promise<string> {
    const session = this.session(host)
    if (!session.ready) await this.initialize(session, host, operation.signal)
    let response = await this.request(session, url, 'GET', html, operation.signal)
    if ((response.status === 401 || response.status === 403) && !operation.refreshed) {
      operation.refreshed = true
      discard(response)
      await this.initialize(session, host, operation.signal)
      response = await this.request(session, url, 'GET', html, operation.signal)
    }
    if (response.status !== 200) {
      discard(response)
      throw statusFailure(response.status, html ? '商品页面' : '衣柜')
    }
    const contentType = response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase()
    if (
      html &&
      contentType &&
      !['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)
    ) {
      discard(response)
      throw unavailable('Vinted 商品页面返回了无效的 HTML 响应')
    }
    return readBody(response, html ? MAX_HTML_BYTES : MAX_JSON_BYTES, operation.signal)
  }

  private async delay(signal: AbortSignal): Promise<void> {
    assertActive(signal)
    if (this.requestDelayMs === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await bounded(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.requestDelayMs)
        }),
        signal,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
