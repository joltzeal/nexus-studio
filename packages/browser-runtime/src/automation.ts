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
  'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=combobox],[role=listbox]'

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

interface ObservedOption {
  label: string
  value: string | null
  selected: boolean
  enabled: boolean
}

interface ObservedControl {
  tag: string
  role: string
  name: string
  fieldName: string
  id: string
  testId: string
  type: string
  value: string
  enabled: boolean
  loading: boolean
  invalid: boolean
  required: boolean
  expanded: boolean | null
  options: ObservedOption[]
  selectedOptions: ObservedOption[]
  optionsTruncated: boolean
  errors: string[]
  upload: {
    fileCount: number
    files: { name: string; size: number; type: string }[]
    filesTruncated: boolean
    previews: { name: string; loaded: boolean }[]
    previewsTruncated: boolean
    progress: { value: number | null; max: number | null; text: string }[]
    progressTruncated: boolean
    statuses: string[]
  } | null
}

interface SnapshotInput {
  origin: string
  maxChars: number
  selector: string
}

interface ObservedSnapshot {
  url: string
  title: string
  text: string
  controls: (ObservedControl & { index: number })[]
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
      keys(input, ['fields', 'includeState'])
      if (input.includeState !== undefined && typeof input.includeState !== 'boolean')
        fail()
      const fields = object(input.fields)
      if (!Object.keys(fields).length || Object.keys(fields).length > 32) fail()
      for (const [key, value] of Object.entries(fields)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key)) fail()
        target(value)
      }
      break
    }
    case 'request': {
      keys(input, ['path', 'method', 'readPolicy'])
      const path = string(input.path, 2048)
      if (input.method !== 'GET') fail()
      if (input.readPolicy !== undefined) {
        if (input.readPolicy !== 'vinted_account_financials') fail()
        const apiOrigin = `https://api.www.${url.hostname.replace(/^www\./u, '')}`
        if (
          path !== `${apiOrigin}/ledger/wallet/balance` &&
          path !== `${apiOrigin}/payments/public/api/bank_accounts`
        )
          fail()
        break
      }
      if (
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
function snapshotScript(
  input: SnapshotInput | Element,
  fieldOrigin?: string,
): ObservedSnapshot | ObservedControl {
  const { origin, maxChars, selector } =
    fieldOrigin === undefined
      ? (input as SnapshotInput)
      : { origin: fieldOrigin, maxChars: 16_384, selector: '' }
  if (location.origin !== origin) throw new Error('scope')
  const visible = (el: Element) => {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return (
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      !el.closest('[hidden],[aria-hidden="true"]') &&
      rect.width > 0 &&
      rect.height > 0
    )
  }
  const enabled = (el: Element) =>
    !el.matches(':disabled') && !el.closest('[aria-disabled="true"],[inert]')
  const text = (el: Element) =>
    ((el as HTMLElement).innerText || el.textContent || '').trim()
  const references = (el: Element, attribute: string) =>
    (el.getAttribute(attribute) || '')
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 10)
      .flatMap((id) => {
        const target = document.getElementById(id)
        return target ? [target] : []
      })
  const name = (el: Element, includeText = true) => {
    const labelled = references(el, 'aria-labelledby').map(text).join(' ')
    const labels = (el as HTMLInputElement).labels
    return (
      el.getAttribute('aria-label') ||
      labelled ||
      (labels && [...labels].map(text).join(' ')) ||
      el.getAttribute('placeholder') ||
      (includeText ? text(el) : '')
    ).slice(0, 512)
  }
  const listbox = (el: Element): Element | undefined => {
    if (el.getAttribute('role') === 'listbox') return el
    if (
      el.getAttribute('role') !== 'combobox' &&
      el.getAttribute('aria-haspopup') !== 'listbox'
    )
      return
    const roots = new Set([
      ...references(el, 'aria-controls'),
      ...references(el, 'aria-owns'),
      ...el.querySelectorAll('[role="listbox"]'),
    ])
    if (roots.size === 1) {
      const root = [...roots][0]
      if (root?.getAttribute('role') === 'listbox') return root
    }
  }
  const observe = (element: Element, valueLimit: number): ObservedControl => {
    const el = element as HTMLElement & Partial<HTMLInputElement>
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const secret =
      type === 'password' ||
      type === 'hidden' ||
      /password|passwd|secret|token|cookie|authorization/i.test(
        [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id]
          .filter(Boolean)
          .join(' '),
      )
    let evidence: Element = el
    if (tag === 'input' && type === 'file') {
      const group = el.closest(
        'fieldset,[role="group"],[role="region"],section[aria-label],section[aria-labelledby]',
      )
      if (group?.querySelectorAll('input[type="file"]').length === 1) evidence = group
    }
    const roles: Record<string, string> = {
      a: 'link',
      button: 'button',
      select: 'combobox',
      textarea: 'textbox',
      input: type === 'checkbox' ? 'checkbox' : 'textbox',
    }
    const root = listbox(el)
    const optionNodes =
      tag === 'select'
        ? [...(el as HTMLSelectElement).options].filter((option) => {
            const group = option.closest('optgroup')
            return [option, ...(group ? [group] : [])].every((item) => {
              const style = getComputedStyle(item)
              return (
                !item.hidden &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.visibility !== 'collapse'
              )
            })
          })
        : root && visible(root)
          ? [...root.querySelectorAll<HTMLElement>('[role="option"]')].filter(
              (option) => visible(option) && option.closest('[role="listbox"]') === root,
            )
          : []
    const option = (item: Element): ObservedOption => ({
      label:
        item.tagName === 'OPTION'
          ? (item as HTMLOptionElement).label.slice(0, 512)
          : name(item),
      value:
        item.tagName === 'OPTION'
          ? (item as HTMLOptionElement).value.slice(0, 2048)
          : ((item.getAttribute('data-value') ?? item.getAttribute('value'))?.slice(
              0,
              2048,
            ) ?? null),
      selected:
        item.tagName === 'OPTION'
          ? (item as HTMLOptionElement).selected
          : item.getAttribute('aria-selected') === 'true',
      enabled: enabled(el) && (!root || enabled(root)) && enabled(item),
    })
    const selected = secret
      ? []
      : optionNodes
          .filter((item) =>
            item.tagName === 'OPTION'
              ? (item as HTMLOptionElement).selected
              : item.getAttribute('aria-selected') === 'true',
          )
          .slice(0, 100)
          .map(option)
    const invalid =
      (el.hasAttribute('aria-invalid') && el.getAttribute('aria-invalid') !== 'false') ||
      el.validity?.valid === false
    const errors = secret
      ? []
      : [
          ...new Set(
            [
              ...references(el, 'aria-errormessage'),
              ...(invalid ? references(el, 'aria-describedby') : []),
              ...evidence.querySelectorAll('[role="alert"]'),
            ]
              .filter(visible)
              .map((item) => text(item).slice(0, 512))
              .filter(Boolean),
          ),
        ].slice(0, 10)
    const inside = (selector: string) => [
      ...(evidence.matches(selector) ? [evidence] : []),
      ...evidence.querySelectorAll<HTMLElement>(selector),
    ]
    const inputs = inside('input[type="file"]') as HTMLInputElement[]
    const images = inside('img').filter(visible) as HTMLImageElement[]
    const bars = inside('progress,[role="progressbar"]').filter(visible)
    const files: { name: string; size: number; type: string }[] = []
    let fileCount = 0
    for (const input of inputs) {
      fileCount += input.files?.length ?? 0
      for (const file of input.files ?? []) {
        if (files.length >= 20) break
        files.push({
          name: file.name.slice(0, 512),
          size: file.size,
          type: file.type.slice(0, 512),
        })
      }
    }
    const numeric = (value: string | null): number | null =>
      value?.trim() && Number.isFinite(Number(value)) ? Number(value) : null
    const progress = bars.slice(0, 20).map((bar) => ({
      value:
        bar.tagName === 'PROGRESS'
          ? bar.hasAttribute('value')
            ? (bar as HTMLProgressElement).value
            : null
          : numeric(bar.getAttribute('aria-valuenow')),
      max:
        bar.tagName === 'PROGRESS'
          ? (bar as HTMLProgressElement).max
          : numeric(bar.getAttribute('aria-valuemax')),
      text: text(bar).slice(0, 512),
    }))
    const upload =
      !secret && (inputs.length || images.length || bars.length)
        ? {
            fileCount,
            files,
            filesTruncated: fileCount > files.length,
            previews: images.slice(0, 20).map((image) => ({
              name: name(image) || (image.getAttribute('alt') || '').slice(0, 512),
              loaded: image.complete && image.naturalWidth > 0,
            })),
            previewsTruncated: images.length > 20,
            progress,
            progressTruncated: bars.length > 20,
            statuses: inside('[role="status"]')
              .filter(visible)
              .map((item) => text(item).slice(0, 512))
              .filter(Boolean)
              .slice(0, 10),
          }
        : null
    const value = secret
      ? '[REDACTED]'
      : type === 'file'
        ? ''
        : ['input', 'select', 'textarea'].includes(tag)
          ? (el.value ?? '')
          : (el.getAttribute('data-value') ??
            el.getAttribute('value') ??
            selected[0]?.value ??
            selected[0]?.label ??
            el.getAttribute('aria-valuetext') ??
            text(el))
    return {
      tag,
      role: (el.getAttribute('role') || roles[tag] || tag).slice(0, 64),
      name: name(el, !secret),
      fieldName: (el.getAttribute('name') || '').slice(0, 512),
      id: el.id.slice(0, 512),
      testId: (el.getAttribute('data-testid') || '').slice(0, 512),
      type: type.slice(0, 64),
      value: String(value).slice(0, valueLimit),
      enabled: enabled(el),
      loading:
        !!el.closest('[aria-busy="true"]') ||
        !!root?.closest('[aria-busy="true"]') ||
        !!evidence.querySelector('[aria-busy="true"]') ||
        bars.some((bar) =>
          bar.tagName === 'PROGRESS'
            ? !bar.hasAttribute('value')
            : !bar.hasAttribute('aria-valuenow'),
        ),
      invalid,
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      expanded: el.hasAttribute('aria-expanded')
        ? el.getAttribute('aria-expanded') === 'true'
        : null,
      options: secret ? [] : optionNodes.slice(0, 100).map(option),
      selectedOptions: selected,
      optionsTruncated: !secret && optionNodes.length > 100,
      errors,
      upload,
    }
  }
  if (fieldOrigin !== undefined) return observe(input as Element, 16_384)
  return {
    url: location.href.slice(0, 4096),
    title: document.title.slice(0, 1000),
    text: (document.body?.innerText || '').slice(0, maxChars),
    controls: [...document.querySelectorAll<HTMLElement>(selector)]
      .filter(visible)
      .slice(0, 100)
      .map((element, index) => ({ index, ...observe(element, 2048) })),
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
function selectKindScript(
  el: Element,
  origin: string,
): 'native' | 'custom' | 'TARGET_SCOPE' | 'CONTROL_NOT_READY' {
  // AUTOMATION_SELECT_KIND: never dispatch to a disabled or busy control.
  if (location.origin !== origin) return 'TARGET_SCOPE'
  if (
    el.matches(':disabled') ||
    el.closest('[aria-disabled="true"],[inert],[aria-busy="true"]')
  )
    return 'CONTROL_NOT_READY'
  return el.tagName === 'SELECT' ? 'native' : 'custom'
}

function selectOptionScript(
  element: Element,
  { origin, value }: { origin: string; value: string },
):
  | Element
  | 'TARGET_SCOPE'
  | 'FORM_CHANGED'
  | 'CONTROL_NOT_READY'
  | 'OPTION_NOT_FOUND'
  | 'OPTION_AMBIGUOUS' {
  if (location.origin !== origin) return 'TARGET_SCOPE'
  const visible = (el: HTMLElement) => {
    const style = getComputedStyle(el)
    return (
      !el.hidden &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse'
    )
  }
  if (element.tagName === 'SELECT') {
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
  const role = element.getAttribute('role')
  if (
    role !== 'listbox' &&
    role !== 'combobox' &&
    element.getAttribute('aria-haspopup') !== 'listbox'
  )
    return 'FORM_CHANGED'
  const roots = new Set<Element>()
  if (role === 'listbox') roots.add(element)
  else {
    for (const attribute of ['aria-controls', 'aria-owns']) {
      const ids = (element.getAttribute(attribute) || '').split(/\s+/u).filter(Boolean)
      if (ids.length > 10) return 'FORM_CHANGED'
      for (const id of ids) {
        const matches = [...document.querySelectorAll('[id]')].filter(
          (item) => item.id === id,
        )
        if (matches.length !== 1 || matches[0]?.getAttribute('role') !== 'listbox')
          return 'FORM_CHANGED'
        roots.add(matches[0])
      }
    }
    for (const root of element.querySelectorAll('[role="listbox"]')) roots.add(root)
  }
  const root = [...roots][0]
  if (
    roots.size !== 1 ||
    !root ||
    root.querySelector('[role="listbox"]') ||
    root.getAttribute('aria-multiselectable') === 'true'
  )
    return 'FORM_CHANGED'
  const available = (el: Element) => {
    const rect = el.getBoundingClientRect()
    return (
      visible(el as HTMLElement) &&
      !el.closest('[hidden],[aria-hidden="true"],[inert]') &&
      rect.width > 0 &&
      rect.height > 0
    )
  }
  if (
    !available(element) ||
    !available(root) ||
    root.closest('[aria-disabled="true"],[aria-busy="true"]')
  )
    return 'CONTROL_NOT_READY'
  const interactive = [
    'button,input,select,textarea,label,a[href],form,iframe,frame,object,embed,summary,audio[controls],video[controls]',
    '[tabindex],[contenteditable]:not([contenteditable="false"])',
    ...[
      'button',
      'checkbox',
      'combobox',
      'grid',
      'gridcell',
      'link',
      'listbox',
      'menu',
      'menubar',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'radio',
      'radiogroup',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'tablist',
      'textbox',
      'tree',
      'treegrid',
      'treeitem',
    ].map((role) => `[role~="${role}"]`),
  ].join(',')
  let match: Element | undefined
  for (const option of root.querySelectorAll<HTMLElement>('[role="option"]')) {
    if (
      !available(option) ||
      option.matches(':disabled') ||
      option.closest('[aria-disabled="true"]') ||
      option.closest('[role="listbox"]') !== root
    )
      continue
    const labelled = (option.getAttribute('aria-labelledby') || '')
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 10)
      .map((id) => document.getElementById(id)?.textContent?.trim() || '')
      .join(' ')
    const label = option.getAttribute('aria-label') || labelled || option.innerText.trim()
    const actualValue = option.getAttribute('data-value') ?? option.getAttribute('value')
    if (value !== label && value !== actualValue) continue
    if (
      option.matches(
        'a[href],input,select,textarea,label,form,iframe,frame,object,embed,[role="link"]',
      ) ||
      option.querySelector(interactive)
    )
      return 'FORM_CHANGED'
    if (match) return 'OPTION_AMBIGUOUS'
    match = option
  }
  return match ?? 'OPTION_NOT_FOUND'
}

function selectionConfirmedScript(
  element: Element,
  {
    origin,
    choice,
    timeoutMs,
  }: {
    origin: string
    choice: { label: string; value: string | null }
    timeoutMs: number
  },
): Promise<boolean> {
  const visible = (el: Element) => {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return (
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      !el.closest('[hidden],[aria-hidden="true"],[inert]') &&
      rect.width > 0 &&
      rect.height > 0
    )
  }
  const confirmed = () => {
    if (location.origin !== origin || !element.isConnected) return false
    const roots = new Set<Element>()
    if (element.getAttribute('role') === 'listbox') roots.add(element)
    else {
      for (const attribute of ['aria-controls', 'aria-owns']) {
        for (const id of (element.getAttribute(attribute) || '').split(/\s+/u)) {
          const root = document.getElementById(id)
          if (root?.getAttribute('role') === 'listbox') roots.add(root)
        }
      }
      for (const root of element.querySelectorAll('[role="listbox"]')) roots.add(root)
    }
    if (roots.size > 1) return false
    const openRoots = [...roots].filter(visible)
    if (openRoots.length) {
      const root = openRoots[0]!
      if (
        root.querySelector('[role="listbox"]') ||
        root.getAttribute('aria-multiselectable') === 'true'
      )
        return false
      const selected = [
        ...root.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]'),
      ].filter((option) => visible(option) && option.closest('[role="listbox"]') === root)
      if (selected.length !== 1) return false
      const option = selected[0]!
      const labelled = (option.getAttribute('aria-labelledby') || '')
        .split(/\s+/u)
        .filter(Boolean)
        .slice(0, 10)
        .map((id) => document.getElementById(id)?.textContent?.trim() || '')
        .join(' ')
      const actualValue =
        option.getAttribute('data-value') ?? option.getAttribute('value')
      return (
        actualValue === choice.value &&
        (option.getAttribute('aria-label') || labelled || option.innerText.trim()) ===
          choice.label
      )
    }
    // A popup may disappear after selection; only an explicit control value
    // proves the effect in that case, never arbitrary surrounding page text.
    return (
      choice.value !== null &&
      (element.getAttribute('data-value') === choice.value ||
        element.getAttribute('value') === choice.value ||
        (element.tagName === 'INPUT' &&
          (element as HTMLInputElement).value === choice.value))
    )
  }
  if (confirmed()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer)
      observer.disconnect()
      resolve(value)
    }
    const observer = new MutationObserver(() => {
      if (confirmed()) finish(true)
    })
    const timer = setTimeout(() => finish(false), timeoutMs)
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    })
    if (confirmed()) finish(true)
  })
}
async function requestScript({
  origin,
  path,
  timeoutMs,
  readPolicy,
}: {
  origin: string
  path: string
  timeoutMs: number
  readPolicy?: string
}) {
  if (location.origin !== origin) throw new Error('scope')
  const url = new URL(path, origin)
  const financial = readPolicy === 'vinted_account_financials'
  if (readPolicy !== undefined && !financial) throw new Error('scope')
  if (financial) {
    const apiOrigin = `https://api.www.${new URL(origin).hostname.replace(/^www\./u, '')}`
    if (
      path !== `${apiOrigin}/ledger/wallet/balance` &&
      path !== `${apiOrigin}/payments/public/api/bank_accounts`
    )
      throw new Error('scope')
  } else if (url.origin !== origin) throw new Error('scope')
  const response = await fetch(url.href, {
    method: 'GET',
    credentials: financial ? 'include' : 'same-origin',
    mode: 'cors',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (
    location.origin !== origin ||
    response.url !== url.href ||
    response.redirected ||
    response.type === 'opaque' ||
    response.type === 'opaqueredirect'
  )
    throw new Error('scope')
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
  if (location.origin !== origin) throw new Error('scope')
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
        const startedAt = Date.now()
        const locator = await this.checkedLocator(page, input.target, origin, timeoutMs)
        const kind = await locator.evaluate(selectKindScript, origin, options)
        if (kind === 'TARGET_SCOPE' || kind === 'CONTROL_NOT_READY') fail(kind)
        const handle = await locator.evaluateHandle(
          selectOptionScript,
          { origin, value: input.value as string },
          options,
        )
        try {
          const option = handle.asElement()
          if (!option) {
            const error = await handle.jsonValue()
            if (
              error === 'TARGET_SCOPE' ||
              error === 'FORM_CHANGED' ||
              error === 'CONTROL_NOT_READY' ||
              error === 'OPTION_AMBIGUOUS'
            )
              fail(error)
            fail('OPTION_NOT_FOUND')
          }
          // Select the observed node, even if the page reorders its options.
          if (kind === 'native') await locator.selectOption(option, options)
          else {
            const choice = await option.evaluate((element) => {
              const labelled = (element.getAttribute('aria-labelledby') || '')
                .split(/\s+/u)
                .filter(Boolean)
                .slice(0, 10)
                .map((id) => document.getElementById(id)?.textContent?.trim() || '')
                .join(' ')
              return {
                label:
                  element.getAttribute('aria-label') ||
                  labelled ||
                  (element as HTMLElement).innerText.trim(),
                value:
                  element.getAttribute('data-value') ?? element.getAttribute('value'),
              }
            })
            if (choice.label !== input.value && choice.value !== input.value)
              fail('FORM_CHANGED')
            const readiness = await option.evaluate(selectKindScript, origin)
            if (readiness === 'TARGET_SCOPE' || readiness === 'CONTROL_NOT_READY')
              fail(readiness)
            if (await option.evaluate(clickGuardScript, origin)) fail('SUBMIT_REQUIRED')
            await option.click(options)
            const confirmed = await locator.evaluate(selectionConfirmedScript, {
              origin,
              choice,
              timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt) - 100),
            })
            if (!confirmed) fail('SELECTION_UNCONFIRMED')
          }
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
          fields[name] =
            input.includeState === true
              ? await (
                  await this.checkedLocator(page, value, origin, timeoutMs)
                ).evaluate(snapshotScript, origin, options)
              : await this.locator(page, value).evaluate(fieldScript, origin, options)
        }
        result = fields
        break
      }
      case 'request':
        result = await page.evaluate(requestScript, {
          origin,
          path: input.path as string,
          timeoutMs,
          ...(input.readPolicy === undefined
            ? {}
            : { readPolicy: input.readPolicy as string }),
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
