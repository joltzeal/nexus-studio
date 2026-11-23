const length = String.raw`(?:0|(?:\d{1,4}(?:\.\d{1,3})?|\.\d{1,3})(?:px|pt|pc|em|rem|ex|ch|%))`
const number = String.raw`(?:\d{1,3}(?:\.\d{1,3})?|\.\d{1,3})`
const color = String.raw`(?:#[0-9a-f]{3,8}|[a-z]{1,24}|(?:rgba?|hsla?)\([+\d.,%/\s-]{1,64}\))`
const borderStyle = '(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)'
const borderWidth = `(?:${length}|thin|medium|thick)`
const borderToken = `(?:${borderWidth}|${borderStyle}|${color})`

const rule = (pattern: string) => new RegExp(`^(?:${pattern})$`, 'i')
const sides = (pattern: string) => rule(`${pattern}(?:\\s+${pattern}){0,3}`)
const edge = ['top', 'right', 'bottom', 'left']

export const mailStyleRules: Readonly<Record<string, RegExp>> = {
  background: rule(color),
  'background-color': rule(color),
  color: rule(color),
  border: rule(`${borderToken}(?:\\s+${borderToken}){0,2}`),
  'border-color': sides(color),
  'border-radius': sides(length),
  'border-style': sides(borderStyle),
  'border-width': sides(borderWidth),
  ...Object.fromEntries(edge.flatMap((side) => [
    [`border-${side}`, rule(`${borderToken}(?:\\s+${borderToken}){0,2}`)],
    [`border-${side}-color`, rule(color)],
    [`border-${side}-style`, rule(borderStyle)],
    [`border-${side}-width`, rule(borderWidth)],
    [`margin-${side}`, rule(`${length}|auto`)],
    [`padding-${side}`, rule(length)],
  ])),
  display: /^(?:block|inline|inline-block|table|table-row|table-cell|flex|none)$/i,
  float: /^(?:left|right|none)$/i,
  'font-family': /^(?:"[a-z\d _-]+"|'[a-z\d _-]+'|[a-z\d _-]+)(?:,\s*(?:"[a-z\d _-]+"|'[a-z\d _-]+'|[a-z\d _-]+))*$/i,
  'font-size': rule(`${length}|xx-small|x-small|small|medium|large|x-large|xx-large`),
  'font-style': /^(?:normal|italic|oblique)$/i,
  'font-weight': /^(?:normal|bold|bolder|lighter|[1-9]00)$/i,
  height: rule(`${length}|auto`),
  'letter-spacing': rule(`${length}|normal`),
  'line-height': rule(`${length}|${number}|normal`),
  margin: sides(`(?:${length}|auto)`),
  'max-height': rule(`${length}|none`),
  'max-width': rule(`${length}|none`),
  'min-height': rule(length),
  'min-width': rule(length),
  opacity: /^(?:0|0?\.\d{1,3}|1)$/,
  overflow: /^(?:visible|hidden|scroll|auto)$/i,
  'overflow-x': /^(?:visible|hidden|scroll|auto)$/i,
  'overflow-y': /^(?:visible|hidden|scroll|auto)$/i,
  padding: sides(length),
  'text-align': /^(?:left|right|center|justify|start|end)$/i,
  'text-decoration': /^(?:none|underline|overline|line-through)(?:\s+(?:underline|overline|line-through)){0,2}$/i,
  'text-indent': rule(length),
  'text-transform': /^(?:none|capitalize|uppercase|lowercase)$/i,
  'vertical-align': /^(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/i,
  'white-space': /^(?:normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/i,
  'word-break': /^(?:normal|break-all|keep-all|break-word)$/i,
  'word-wrap': /^(?:normal|break-word)$/i,
  width: rule(`${length}|auto`),
}

export function safeMailStyle(property: string, value: string): boolean {
  return Object.hasOwn(mailStyleRules, property) && value.length <= 256 && mailStyleRules[property]?.test(value) === true
}
