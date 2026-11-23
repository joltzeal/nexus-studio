import { createElement, useMemo, type CSSProperties, type ReactNode } from 'react'
import { Textarea } from '@proxyshard/shardx-ui-kit'
import { safeMailStyle } from '@nexus/plugin-contracts/mail-style'

const heading = 'mt-4 mb-2 font-semibold text-text-strong-950'
const cell = 'border border-stroke-soft-200 px-2 py-1 align-top'
const presentation = new Map([
  ['p', 'my-2'],
  ['div', ''],
  ['span', ''],
  ['br', ''],
  ['hr', 'my-3 border-stroke-soft-200'],
  ['h1', `${heading} text-lg`],
  ['h2', `${heading} text-base`],
  ['h3', heading],
  ['h4', heading],
  ['h5', heading],
  ['h6', heading],
  ['strong', 'font-semibold'],
  ['b', 'font-semibold'],
  ['em', 'italic'],
  ['i', 'italic'],
  ['u', 'underline'],
  ['s', 'line-through'],
  ['small', 'text-micro'],
  ['sub', ''],
  ['sup', ''],
  ['blockquote', 'my-2 border-s-2 border-stroke-soft-200 ps-3 text-text-sub-600'],
  ['pre', 'my-2 overflow-x-auto rounded-control bg-bg-weak-50 p-2'],
  ['code', 'font-mono'],
  ['ul', 'my-2 list-disc ps-5'],
  ['ol', 'my-2 list-decimal ps-5'],
  ['li', ''],
  ['dl', 'my-2'],
  ['dt', 'font-semibold'],
  ['dd', 'ps-4'],
  ['table', 'my-2 max-w-full border-collapse'],
  ['caption', 'mb-1 text-start font-medium'],
  ['thead', ''],
  ['tbody', ''],
  ['tfoot', ''],
  ['tr', ''],
  ['td', cell],
  ['th', `${cell} bg-bg-weak-50 text-start font-semibold`],
])
const discard = new Set([
  'script',
  'style',
  'head',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'form',
  'textarea',
  'select',
  'button',
])

function safeStyle(value: string | null): CSSProperties | undefined {
  if (!value) return undefined
  const output: Record<string, string> = {}
  for (const declaration of value.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator <= 0) continue
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const cssValue = declaration.slice(separator + 1).replace(/\s*!important\s*$/i, '').trim()
    if (!safeMailStyle(property, cssValue)) continue
    const cssProperty = property.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase())
    output[cssProperty] = cssValue
  }
  return Object.keys(output).length ? (output as CSSProperties) : undefined
}

function safeNodes(parent: ParentNode, prefix = '', depth = 0): ReactNode[] {
  if (depth >= 32) return []
  return Array.from(parent.childNodes).flatMap((node, index): ReactNode[] => {
    if (node.nodeType === Node.TEXT_NODE) return [node.nodeValue]
    if (
      !(node instanceof Element) ||
      node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
    )
      return []
    const tag = node.localName
    if (discard.has(tag)) return []
    const key = `${prefix}.${index}`
    const children = safeNodes(node, key, depth + 1)
    const className = presentation.get(tag)
    if (className === undefined) return children
    const props = {
      key,
      className: className || undefined,
      style: safeStyle(node.getAttribute('style')),
    }
    return [
      tag === 'br' || tag === 'hr'
        ? createElement(tag, props)
        : createElement(tag, props, children),
    ]
  })
}

export function MailBody({
  html,
  body,
  plainText,
}: {
  html: string | null
  body: string
  plainText: boolean
}) {
  const content = useMemo(() => {
    if (!html?.trim() || plainText) return []
    const template = document.createElement('template')
    template.innerHTML = html
    return safeNodes(template.content)
  }, [html, plainText])

  return content.length ? (
    <div
      role="region"
      aria-label="邮件正文"
      className="mt-3 min-w-0 overflow-x-auto rounded-control border border-stroke-soft-200 bg-bg-page px-3 py-2 text-secondary leading-relaxed wrap-anywhere text-text-strong-950"
    >
      {content}
    </div>
  ) : (
    <Textarea className="mt-3" label="邮件正文" rows={16} readOnly value={body} />
  )
}
