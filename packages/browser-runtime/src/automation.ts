import { isAbsolute } from 'node:path'
import type { Writable } from 'node:stream'
import type { BrowserContext, Locator, Page, Route } from 'playwright-core'

const MAX_FRAME = 256 * 1024
const domains = new Set(
  [
    'com',
    'co.uk',
    'fr',
    'de',
    'nl',
    'be',
    'es',
    'it',
    'pt',
    'pl',
    'cz',
    'sk',
    'lt',
    'at',
    'lu',
    'se',
    'dk',
    'fi',
    'ro',
    'hu',
    'hr',
    'gr',
    'ie',
    'ee',
    'lv',
    'si',
  ].map((suffix) => `vinted.${suffix}`),
)
const controls =
  'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=combobox]'

type ObjectValue = Record<string, unknown>
type Operation =
  | 'navigate'
  | 'snapshot'
  | 'click'
  | 'submit'
  | 'fill'
  | 'select'
  | 'upload'
  | 'readFields'
  | 'request'
export interface AutomationRequest {
  operation: Operation
  origin: string
  input: ObjectValue
  timeoutMs: number
}

function fail(code = 'INVALID'): never {
  throw new Error(`AUTOMATION_${code}`)
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as ObjectValue
}

function keys(value: ObjectValue, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail()
}

function string(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value)) fail()
  return value
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    fail()
  return value as number
}

function hasControl(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  )
}

function allowedUrl(value: unknown): URL {
  const raw = string(value, 4096)
  if (/[\s\\]/u.test(raw) || hasControl(raw) || !raw.startsWith('https://'))
    fail('ORIGIN')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('ORIGIN')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !domains.has(url.hostname.replace(/^www\./u, ''))
  )
    fail('ORIGIN')
  return url
}

function target(value: unknown): ObjectValue {
  const valueObject = object(value)
  keys(valueObject, ['css', 'role', 'name', 'label', 'placeholder', 'testId', 'index'])
  const selectors = ['css', 'role', 'label', 'placeholder', 'testId'].filter(
    (key) => valueObject[key] !== undefined,
  )
  if (selectors.length > 1 || (!selectors.length && valueObject.index === undefined))
    fail()
  for (const key of selectors) string(valueObject[key], 512)
  if (typeof valueObject.css === 'string' && valueObject.css.includes('>>'))
    fail('TARGET_SCOPE')
  if (valueObject.name !== undefined) {
    if (!valueObject.role) fail()
    string(valueObject.name, 512)
  }
  if (
    valueObject.role !== undefined &&
    !/^[a-z]{2,32}$/u.test(string(valueObject.role, 32))
  )
    fail()
  if (valueObject.index !== undefined) integer(valueObject.index, 0, 99)
  return valueObject
}

export function parseAutomationRequest(value: unknown): AutomationRequest {
  const body = object(value)
  keys(body, ['operation', 'origin', 'input', 'timeoutMs'])
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_FRAME) fail('TOO_LARGE')
  const url = allowedUrl(body.origin)
  if (body.origin !== url.origin) fail('ORIGIN')
  const timeoutMs =
    body.timeoutMs === undefined ? 30_000 : integer(body.timeoutMs, 1, 120_000)
  const input = object(body.input)
  switch (body.operation) {
    case 'navigate':
      keys(input, ['url', 'initializeOrigin'])
      if (allowedUrl(input.url).origin !== url.origin) fail('ORIGIN_MISMATCH')
      if (
        input.initializeOrigin !== undefined &&
        (input.initializeOrigin !== true || input.url !== `${url.origin}/`)
      )
        fail('RECONCILE_ORIGIN')
      break
    case 'snapshot':
      keys(input, ['maxChars'])
      if (input.maxChars !== undefined) integer(input.maxChars, 1, 100_000)
      break
    case 'click':
      keys(input, ['target'])
      target(input.target)
      break
    case 'submit':
      keys(input, ['target', 'operationId'])
      target(input.target)
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          string(input.operationId, 36),
        )
      )
        fail('OPERATION_ID')
      break
    case 'fill':
    case 'select':
      keys(input, ['target', 'value'])
      target(input.target)
      string(input.value, 16_384, true)
      break
    case 'upload': {
      keys(input, ['target', 'files'])
      target(input.target)
      const files = input.files
      if (!Array.isArray(files) || !files.length || files.length > 20) fail()
      for (const file of files) {
        const path = string(file, 2048)
        if (!isAbsolute(path) || hasControl(path) || path.split(/[\\/]/u).includes('..'))
          fail()
      }
      break
    }
    case 'readFields': {
      keys(input, ['fields'])
      const fields = object(input.fields)
      if (!Object.keys(fields).length || Object.keys(fields).length > 32) fail()
      for (const [key, value] of Object.entries(fields)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key)) fail()
        target(value)
      }
      break
    }
    case 'request': {
      keys(input, ['path', 'method'])
      const path = string(input.path, 2048)
      if (
        input.method !== 'GET' ||
        !path.startsWith('/') ||
        path.startsWith('//') ||
        /[\s\\]|%2f|%5c|%00|%0a|%0d/iu.test(path) ||
        hasControl(path)
      )
        fail()
      const endpoint = new URL(path, url.origin)
      if (endpoint.origin !== url.origin || endpoint.hash) fail()
      break
    }
    default:
      fail('OPERATION')
  }
  return { operation: body.operation, origin: url.origin, input, timeoutMs }
}

// Keep these functions self-contained: Playwright serializes them without closures.
// Callers can supply data only.
function snapshotScript({
  origin,
  maxChars,
  selector,
}: {
  origin: string
  maxChars: number
  selector: string
}) {
  if (location.origin !== origin) throw new Error('scope')
  const visible = (el: Element) => {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return (
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      rect.width > 0 &&
      rect.height > 0
    )
  }
  const items = [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(visible)
    .slice(0, 100)
  const controls = items.map((element, index) => {
    const el = element as HTMLElement & Partial<HTMLInputElement>
    const tag = el.tagName.toLowerCase()
    const type = el.getAttribute('type') || ''
    const secret =
      type === 'password' ||
      /password|passwd/i.test(
        [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id]
          .filter(Boolean)
          .join(' '),
      )
    const label = el.labels && [...el.labels].map((label) => label.innerText).join(' ')
    const roles: Record<string, string> = {
      a: 'link',
      button: 'button',
      select: 'combobox',
      textarea: 'textbox',
      input: type === 'checkbox' ? 'checkbox' : 'textbox',
    }
    return {
      index,
      role: el.getAttribute('role') || roles[tag] || tag,
      name: (
        el.getAttribute('aria-label') ||
        label ||
        el.getAttribute('placeholder') ||
        el.innerText ||
        ''
      ).slice(0, 512),
      type,
      value: secret ? '[REDACTED]' : String(el.value || '').slice(0, 2048),
    }
  })
  return {
    url: location.href.slice(0, 4096),
    title: document.title.slice(0, 1000),
    text: (document.body?.innerText || '').slice(0, maxChars),
    controls,
  }
}
function fieldScript(element: Element, origin: string): string {
  const el = element as HTMLElement & Partial<HTMLInputElement>
  if (location.origin !== origin) throw new Error('scope')
  if (
    el.type === 'password' ||
    el.type === 'hidden' ||
    /password|passwd/i.test([el.autocomplete, el.name, el.id].filter(Boolean).join(' '))
  )
    return '[REDACTED]'
  return String('value' in el ? el.value : el.innerText || '').slice(0, 16_384)
}
function clickGuardScript(el: Element, origin: string): boolean {
  if (location.origin !== origin) throw new Error('scope')
  // AUTOMATION_SUBMIT_REQUIRED: check the DOM, never trust the model's target name.
  if (['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(el.tagName)) return true
  const control = (el.closest('label')?.control ||
    el.closest('button,input,a,[role=button],[role=link]') ||
    el) as HTMLElement & Partial<HTMLInputElement>
  const labelled = (control.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10)
    .map((id) => document.getElementById(id)?.innerText || '')
    .join(' ')
  const names = [
    control.getAttribute('aria-label'),
    control.labels && [...control.labels].map((label) => label.innerText).join(' '),
    control.getAttribute('placeholder'),
    control.getAttribute('title'),
    control.innerText,
    control.value,
    control.getAttribute('data-testid'),
    labelled,
  ]
  // Mirror the adapter's finite publish/send vocabulary without importing a plugin.
  // Compare each accessible-name source independently, including non-Latin scripts.
  const finalLabels = [
    'upload',
    'upload item',
    'publish',
    'publish item',
    'list item',
    'list for sale',
    'publier',
    "publier l'article",
    'publier l\u2019article',
    'mettre en ligne',
    'hochladen',
    'artikel hochladen',
    'ver\u00f6ffentlichen',
    'subir',
    'subir art\u00edculo',
    'publicar',
    'carica',
    'carica articolo',
    'pubblica',
    'uploaden',
    'plaatsen',
    'artikel plaatsen',
    'publicar artigo',
    'wystaw',
    'wystaw przedmiot',
    'nahr\u00e1t',
    'nahra\u0165',
    '\u012fkelti',
    'ladda upp',
    'upload vare',
    'julkaise',
    'objavi',
    'felt\u00f6lt\u00e9s',
    'public\u0103',
    '\u03b4\u03b7\u03bc\u03bf\u03c3\u03af\u03b5\u03c5\u03c3\u03b7',
    'send',
    'send message',
    'envoyer',
    'envoyer le message',
    'senden',
    'nachricht senden',
    'enviar',
    'enviar mensaje',
    'invia',
    'invia messaggio',
    'verzenden',
    'bericht verzenden',
    'enviar mensagem',
    'wy\u015blij',
    'wy\u015blij wiadomo\u015b\u0107',
    'odeslat',
    'odosla\u0165',
    'si\u0173sti',
    'skicka',
    'send besked',
    'l\u00e4het\u00e4',
    'po\u0161alji',
    'k\u00fcld\u00e9s',
    'trimite',
    '\u03b1\u03c0\u03bf\u03c3\u03c4\u03bf\u03bb\u03ae',
  ]
  const finalName = names.some(
    (name) =>
      typeof name === 'string' &&
      finalLabels.includes(
        name
          .normalize('NFKC')
          .trim()
          .replace(/\s*\*$/u, '')
          .replace(/\s+/gu, ' ')
          .toLowerCase(),
      ),
  )
  const text = names.filter(Boolean).join(' ').replace(/[_-]/g, ' ')
  return (
    control.type === 'submit' ||
    control.type === 'image' ||
    finalName ||
    /\b(publish|submit|send|delete|remove|erase|confirm|checkout|purchase|buy|place[ -]?order|pay|publier|envoyer|supprimer|publicar|enviar|eliminar|pubblica|invia|elimina|senden|ver\u00f6ffentlichen|l\u00f6schen|plaatsen|verzenden|verwijderen)\b/i.test(
      text,
    )
  )
}
function targetScopeScript(el: Element, origin: string): boolean {
  // AUTOMATION_TARGET_SCOPE: selectors cannot grant access to another document.
  return (
    location.origin === origin &&
    !['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(el.tagName)
  )
}
function uploadTargetScript(el: Element, origin: string): 'input' | 'opener' | 'invalid' {
  // AUTOMATION_UPLOAD_TARGET: distinguish a file input from an observed opener.
  if (location.origin !== origin) throw new Error('scope')
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file') return 'input'
  return el.closest('button,a,label,[role=button],[role=link],input[type=button]')
    ? 'opener'
    : 'invalid'
}
function selectOptionScript(
  element: Element,
  { origin, value }: { origin: string; value: string },
): HTMLOptionElement | 'TARGET_SCOPE' | 'OPTION_NOT_FOUND' | 'OPTION_AMBIGUOUS' {
  if (location.origin !== origin || element.tagName !== 'SELECT') return 'TARGET_SCOPE'
  const visible = (el: HTMLElement) => {
    const style = getComputedStyle(el)
    return (
      !el.hidden &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse'
    )
  }
  let match: HTMLOptionElement | undefined
  for (const option of (element as HTMLSelectElement).options) {
    const group = option.closest('optgroup')
    if (
      option.disabled ||
      !visible(option) ||
      (group && (group.disabled || !visible(group))) ||
      (option.value !== value && option.label !== value)
    )
      continue
    if (match) return 'OPTION_AMBIGUOUS'
    match = option
  }
  return match ?? 'OPTION_NOT_FOUND'
}
async function requestScript({
  origin,
  path,
  timeoutMs,
}: {
  origin: string
  path: string
  timeoutMs: number
}) {
  if (location.origin !== origin) throw new Error('scope')
  const url = new URL(path, origin)
  if (url.origin !== origin) throw new Error('scope')
  const response = await fetch(url.href, {
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (new URL(response.url).origin !== origin) throw new Error('scope')
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    if (reader)
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 65536) throw new Error('size')
        text += decoder.decode(part.value, { stream: true })
      }
    text += decoder.decode()
  } finally {
    await reader?.cancel()
  }
  try {
    text = JSON.stringify(JSON.parse(text), (key, value: unknown) =>
      /password|passwd|secret|token|cookie|authorization/i.test(key)
        ? '[REDACTED]'
        : value,
    )
  } catch {
    text = text.replace(
      /(password|passwd|secret|token)\s*[=:]\s*[^\s&<]+/gi,
      '$1=[REDACTED]',
    )
  }
  return { url: response.url, status: response.status, text }
}

export class AutomationActor {
  private origin: string | undefined
  private page: Page | undefined
  private pending: Promise<unknown> | undefined
  private disposed = false
  private route: ((route: Route) => Promise<void>) | undefined
  private readonly context: BrowserContext
  private readonly submitted = new Set<string>()

  constructor(context: BrowserContext, startup?: Promise<unknown>) {
    this.context = context
    if (startup) {
      const pending = startup.catch(() => {})
      this.pending = pending
      void pending.finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
    }
  }

  async execute(value: unknown): Promise<unknown> {
    const request = parseAutomationRequest(value)
    if (this.disposed) fail('CLOSED')
    if (this.pending) fail('BUSY')
    if (this.origin && this.origin !== request.origin) fail('ORIGIN_MISMATCH')
    this.origin = request.origin
    const operation = this.run(request).catch((error: unknown) => {
      if (error instanceof Error && /^AUTOMATION_[A-Z_]+$/u.test(error.message))
        throw error
      fail('FAILED')
    })
    this.pending = operation
    let timer: ReturnType<typeof setTimeout> | undefined
    void operation
      .finally(() => {
        if (this.pending === operation) this.pending = undefined
      })
      .catch(() => {})
    try {
      const result = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('AUTOMATION_TIMEOUT')),
            request.timeoutMs,
          )
        }),
      ])
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_FRAME - 1024) fail('TOO_LARGE')
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  async whenIdle(): Promise<void> {
    await this.pending?.catch(() => {})
  }

  async dispose(): Promise<void> {
    if (this.pending) fail('BUSY')
    this.disposed = true
    if (this.route) {
      await this.context.unroute('**/*', this.route)
    }
    // The provider owns the browser and the user owns existing pages.
  }

  async release(): Promise<void> {
    await this.dispose()
    this.submitted.clear()
    this.origin = undefined
    this.page = undefined
    this.route = undefined
    this.disposed = false
  }

  private async ownedPage(origin: string): Promise<Page> {
    if (this.page) {
      if (this.page.isClosed()) fail('PAGE_CLOSED')
      return this.page
    }
    const pages = this.context.pages().filter((page) => !page.isClosed())
    const matching = pages.filter((page) => {
      try {
        return new URL(page.url()).origin === origin
      } catch {
        return false
      }
    })
    if (matching.length > 1) fail('PAGE_AMBIGUOUS')
    this.page =
      matching[0] ??
      pages.find((page) => page.url() === 'about:blank') ??
      (await this.context.newPage())
    const page = this.page
    this.route = async (route) => {
      const req = route.request()
      if (req.isNavigationRequest()) {
        try {
          const targetPage = req.frame().page()
          if (
            (targetPage === page || (await targetPage.opener()) === page) &&
            allowedUrl(req.url()).origin !== origin
          )
            return await route.abort('blockedbyclient')
        } catch {
          return await route.abort('blockedbyclient')
        }
      }
      await route.continue()
    }
    await this.context.route('**/*', this.route)
    return page
  }

  private locator(page: Page, value: unknown): Locator {
    const spec = target(value)
    let locator: Locator
    if (typeof spec.css === 'string') locator = page.locator(`css=${spec.css}`)
    else if (typeof spec.role === 'string')
      locator = page.getByRole(spec.role as Parameters<Page['getByRole']>[0], {
        ...(typeof spec.name === 'string' ? { name: spec.name } : {}),
        exact: true,
      })
    else if (typeof spec.label === 'string')
      locator = page.getByLabel(spec.label, { exact: true })
    else if (typeof spec.placeholder === 'string')
      locator = page.getByPlaceholder(spec.placeholder, { exact: true })
    else if (typeof spec.testId === 'string') locator = page.getByTestId(spec.testId)
    else locator = page.locator(controls).filter({ visible: true })
    return typeof spec.index === 'number' ? locator.nth(spec.index) : locator
  }

  private async checkedLocator(
    page: Page,
    value: unknown,
    origin: string,
    timeout: number,
  ): Promise<Locator> {
    const locator = this.locator(page, value)
    if ((await locator.evaluate(targetScopeScript, origin, { timeout })) !== true)
      fail('TARGET_SCOPE')
    return locator
  }

  private async upload(
    page: Page,
    locator: Locator,
    files: string[],
    origin: string,
    timeout: number,
  ): Promise<void> {
    const options = { timeout }
    const kind = await locator.evaluate(uploadTargetScript, origin, options)
    if (kind === 'input') {
      await locator.setInputFiles(files, options)
      return
    }
    if (kind !== 'opener') fail('UPLOAD_TARGET')
    if (await locator.evaluate(clickGuardScript, origin, options)) fail('SUBMIT_REQUIRED')

    // Keep OS-dialog interception active until the click settles, even if its
    // chooser wait times out first. Remove only this operation's listener.
    const intercept = () => {}
    page.on('filechooser', intercept)
    try {
      const [chosen, clicked] = await Promise.allSettled([
        page.waitForEvent('filechooser', options),
        locator.click(options),
      ])
      if (clicked.status === 'rejected') throw clicked.reason
      if (chosen.status === 'rejected') throw chosen.reason
      const chooser = chosen.value
      const input = chooser.element()
      try {
        if (
          chooser.page() !== page ||
          (await input.ownerFrame()) !== page.mainFrame() ||
          (await input.evaluate(uploadTargetScript, origin)) !== 'input'
        )
          fail('TARGET_SCOPE')
        await chooser.setFiles(files, options)
      } finally {
        await input.dispose()
      }
    } finally {
      page.off('filechooser', intercept)
    }
  }

  private async run(request: AutomationRequest): Promise<unknown> {
    const { operation, origin, input, timeoutMs } = request
    const page = await this.ownedPage(origin)
    if (operation !== 'navigate' || page.url() !== 'about:blank') {
      let current: URL
      try {
        current = allowedUrl(page.url())
      } catch {
        fail('ORIGIN_MISMATCH')
      }
      if (current.origin !== origin) fail('ORIGIN_MISMATCH')
    }
    const options = { timeout: timeoutMs }
    let result: unknown
    switch (operation) {
      case 'navigate':
        if (input.initializeOrigin === true) {
          if (page.url() === input.url) {
            result = { url: page.url() }
            break
          }
          if (page.url() !== 'about:blank') fail('RECONCILE_PAGE')
        }
        await page.goto(input.url as string, {
          ...options,
          waitUntil: 'domcontentloaded',
        })
        result = { url: page.url() }
        break
      case 'snapshot':
        result = await page.evaluate(snapshotScript, {
          origin,
          maxChars: (input.maxChars as number | undefined) ?? 20_000,
          selector: controls,
        })
        break
      case 'click':
        {
          const locator = this.locator(page, input.target)
          if (await locator.evaluate(clickGuardScript, origin, options))
            fail('SUBMIT_REQUIRED')
          await locator.click(options)
        }
        result = { completed: true }
        break
      case 'submit': {
        const operationId = input.operationId as string
        if (this.submitted.has(operationId)) fail('SUBMIT_REPLAY')
        if (this.submitted.size >= 256) fail('SUBMIT_LIMIT')
        const locator = await this.checkedLocator(page, input.target, origin, timeoutMs)
        // Record before dispatch: even a Playwright timeout may follow a successful click.
        this.submitted.add(operationId)
        await locator.click(options)
        result = { completed: true, operationId }
        break
      }
      case 'fill':
        await (
          await this.checkedLocator(page, input.target, origin, timeoutMs)
        ).fill(input.value as string, options)
        result = { completed: true }
        break
      case 'select': {
        const locator = await this.checkedLocator(page, input.target, origin, timeoutMs)
        const handle = await locator.evaluateHandle(
          selectOptionScript,
          { origin, value: input.value as string },
          options,
        )
        try {
          const option = handle.asElement()
          if (!option) {
            const error = await handle.jsonValue()
            if (error === 'TARGET_SCOPE') fail('TARGET_SCOPE')
            if (error === 'OPTION_AMBIGUOUS') fail('OPTION_AMBIGUOUS')
            fail('OPTION_NOT_FOUND')
          }
          // Select the observed node, even if the page reorders its options.
          await locator.selectOption(option, options)
        } finally {
          await handle.dispose()
        }
        result = { completed: true }
        break
      }
      case 'upload':
        await this.upload(
          page,
          await this.checkedLocator(page, input.target, origin, timeoutMs),
          input.files as string[],
          origin,
          timeoutMs,
        )
        result = { completed: true }
        break
      case 'readFields': {
        const fields: Record<string, unknown> = {}
        for (const [name, value] of Object.entries(object(input.fields))) {
          fields[name] = await this.locator(page, value).evaluate(
            fieldScript,
            origin,
            options,
          )
        }
        result = fields
        break
      }
      case 'request':
        result = await page.evaluate(requestScript, {
          origin,
          path: input.path as string,
          timeoutMs,
        })
        break
    }
    if (allowedUrl(page.url()).origin !== origin) fail('ORIGIN_MISMATCH')
    return result
  }
}

export function validateCdpEndpoint(value: unknown): string {
  try {
    const raw = string(value, 2048)
    const url = new URL(raw)
    if (
      !/^ws:\/\/(?:127(?:\.\d{1,3}){3}|\[::1\]):[1-9]\d{0,4}\/devtools\/browser\/[a-zA-Z0-9-]+$/u.test(
        raw,
      ) ||
      url.protocol !== 'ws:' ||
      !url.port ||
      Number(url.port) > 65535 ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail('CDP_INVALID')
    return url.href
  } catch {
    fail('CDP_INVALID')
  }
}

export async function automationCommandLoop(
  actor: AutomationActor,
  commands: AsyncIterable<string>,
  output: Pick<Writable, 'write'> = process.stdout,
): Promise<void> {
  const handlers = new Set<Promise<void>>()
  const emit = (requestId: string, value: ObjectValue) => {
    const frame = JSON.stringify({ requestId, ...value })
    output.write(`NEXUS_AUTOMATION ${frame}\n`)
  }
  for await (const command of commands) {
    if (command === 'stop') break
    let requestId: string
    let request: ObjectValue
    try {
      if (Buffer.byteLength(command) > MAX_FRAME) fail('TOO_LARGE')
      const envelope = object(JSON.parse(command))
      requestId = string(envelope.requestId, 128)
      if (!/^[a-zA-Z0-9_-]+$/u.test(requestId)) fail()
      const body = { ...envelope }
      delete body.requestId
      request = body
    } catch {
      continue
    }
    const handler = (async () => {
      try {
        const result =
          Object.keys(request).join(',') === 'control' && request.control === 'release'
            ? (await actor.release(), { released: true })
            : await actor.execute(request)
        emit(requestId, { ok: true, result })
      } catch (error) {
        const code =
          error instanceof Error && /^AUTOMATION_[A-Z_]+$/u.test(error.message)
            ? error.message
            : 'AUTOMATION_FAILED'
        emit(requestId, { ok: false, error: { code, message: code } })
        if (code === 'AUTOMATION_TIMEOUT') {
          await actor.whenIdle()
          emit(requestId, {
            ok: false,
            error: { code: 'AUTOMATION_SETTLED', message: 'AUTOMATION_SETTLED' },
          })
        }
      }
    })()
    handlers.add(handler)
    void handler.finally(() => handlers.delete(handler))
  }
}
