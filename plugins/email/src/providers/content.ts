import sanitizeHtml from 'sanitize-html'
import { capText, htmlText } from './support.js'

const MAX_HTML_BYTES = 128 * 1024
const options: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'div',
    'span',
    'br',
    'hr',
    'b',
    'strong',
    'em',
    'i',
    'u',
    's',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'pre',
    'code',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'sup',
    'sub',
    'small',
  ],
  allowedAttributes: {},
  allowedSchemes: [],
  allowProtocolRelative: false,
  nonTextTags: [
    'script',
    'style',
    'head',
    'template',
    'noscript',
    'iframe',
    'object',
    'embed',
    'svg',
    'math',
    'form',
    'textarea',
    'select',
    'button',
  ],
  nestingLimit: 20,
  textFilter: (text) =>
    [...text]
      .filter((character) => {
        const code = character.charCodeAt(0)
        return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13
      })
      .join(''),
}

export function mailContent(text: string | undefined, html: string | undefined) {
  const safeHtml = html === undefined ? null : sanitizeHtml(html, options)
  const plain = text !== undefined && text.length ? text : htmlText(safeHtml ?? '')
  const body = capText(plain)
  if (safeHtml === null) return { body: body.text, html: null, truncated: body.truncated }
  const clipped = capText(safeHtml, MAX_HTML_BYTES)
  // Leave room for the sanitizer to close at most twenty allowed nesting levels.
  const formatted = clipped.truncated
    ? sanitizeHtml(capText(safeHtml, MAX_HTML_BYTES - 1024).text, options)
    : safeHtml
  return {
    body: body.text,
    html: formatted,
    truncated: body.truncated || clipped.truncated,
  }
}
