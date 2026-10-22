import { deflateRawSync, inflateRawSync } from 'node:zlib'

import { invalidRequest } from './errors.js'

/**
 * A minimal spreadsheet reader and writer.
 *
 * The plugin ships inside the desktop bundle, so it cannot pull a spreadsheet
 * library just to read a header row: this module covers the subset Excel and
 * Numbers produce for a flat account list (inline and shared strings, numbers,
 * one worksheet) and writes a workbook Excel opens without complaint.
 */

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

/* ---------------------------------------------------------------- CSV ---- */

const DELIMITERS = [',', ';', '\t'] as const

/** Comma, semicolon and tab all appear in the wild; the header decides. */
function detectDelimiter(text: string): string {
  const end = text.indexOf('\n')
  const header = end === -1 ? text : text.slice(0, end)
  let best = ','
  let bestCount = -1
  for (const candidate of DELIMITERS) {
    const count = header.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/** RFC 4180 with a BOM stripped and blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delimiter = detectDelimiter(input)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = 0

  while (index < input.length) {
    const char = input[index] ?? ''
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index += 1
      continue
    }
    field += char
    index += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''))
}

export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(','),
    )
    .join('\r\n')
}

/* ----------------------------------------------------------------- ZIP ---- */

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

// 2024-01-01 in DOS date form: the field cannot be zero, Excel calls that corrupt.
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1

interface ZipEntry {
  name: string
  data: Uint8Array
}

function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const local: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(entry.data)
    const checksum = crc32(entry.data)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 file names
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, name, compressed)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(8, 10)
    record.writeUInt16LE(0, 12)
    record.writeUInt16LE(DOS_DATE, 14)
    record.writeUInt32LE(checksum, 16)
    record.writeUInt32LE(compressed.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(0, 38)
    record.writeUInt32LE(offset, 42)
    directory.push(record, name)

    offset += 30 + name.length + compressed.length
  }

  const directoryBytes = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directoryBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...local, directoryBytes, end])
}

function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let at = view.byteLength - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end === -1) throw invalidRequest('文件不是有效的 xlsx（缺少 zip 目录）')

  const files = new Map<string, Uint8Array>()
  const count = view.getUint16(end + 10, true)
  let pointer = view.getUint32(end + 16, true)
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > view.byteLength) break
    if (view.getUint32(pointer, true) !== 0x02014b50) break
    const method = view.getUint16(pointer + 10, true)
    const compressedSize = view.getUint32(pointer + 20, true)
    const nameLength = view.getUint16(pointer + 28, true)
    const extraLength = view.getUint16(pointer + 30, true)
    const commentLength = view.getUint16(pointer + 32, true)
    const localOffset = view.getUint32(pointer + 42, true)
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength))
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = bytes.subarray(start, start + compressedSize)
    try {
      files.set(name, method === 8 ? inflateRawSync(raw) : raw)
    } catch {
      throw invalidRequest(`文件条目 ${name} 已损坏`)
    }
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return files
}

/* ---------------------------------------------------------------- XML ---- */

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity === 'amp') return '&'
    if (entity === 'lt') return '<'
    if (entity === 'gt') return '>'
    if (entity === 'quot') return '"'
    if (entity === 'apos') return "'"
    return match
  })
}

function stripControlCharacters(text: string): string {
  let output = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    // Tab, line feed and carriage return are legal inside a cell; the rest of
    // the C0 range makes an XML parser reject the part outright.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    output += char
  }
  return output
}

function escapeXml(text: string): string {
  return stripControlCharacters(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* --------------------------------------------------------------- XLSX ---- */

function columnIndex(reference: string): number {
  let value = 0
  for (const char of reference) {
    const code = char.charCodeAt(0)
    if (code < 65 || code > 90) break
    value = value * 26 + (code - 64)
  }
  return value - 1
}

function columnName(index: number): string {
  let remaining = index + 1
  let name = ''
  while (remaining > 0) {
    const digit = (remaining - 1) % 26
    name = String.fromCharCode(65 + digit) + name
    remaining = Math.floor((remaining - 1) / 26)
  }
  return name
}

function textBetween(body: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(body)
  return match === null ? '' : decodeXml(match[1] ?? '')
}

function inlineText(body: string): string {
  let text = ''
  for (const match of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
    text += decodeXml(match[1] ?? '')
  }
  return text
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    values.push(inlineText(match[1] ?? ''))
  }
  return values
}

function parseSheet(xml: string, shared: readonly string[]): string[][] {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      const reference = /\br="([A-Z]+)\d*"/.exec(attributes)?.[1] ?? ''
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? ''
      const at = reference === '' ? cells.length : columnIndex(reference)
      let value: string
      if (type === 's') {
        value = shared[Number.parseInt(textBetween(body, 'v'), 10)] ?? ''
      } else if (type === 'inlineStr') {
        value = inlineText(body)
      } else {
        value = textBetween(body, 'v')
      }
      while (cells.length < at) cells.push('')
      cells[at] = value
    }
    rows.push(Array.from({ length: cells.length }, (_, index) => cells[index] ?? ''))
  }
  return rows.filter((row) => row.some((cell) => cell.trim() !== ''))
}

function firstWorksheet(files: Map<string, Uint8Array>): Uint8Array {
  const preferred = files.get('xl/worksheets/sheet1.xml')
  if (preferred !== undefined) return preferred
  for (const [name, data] of files) {
    if (name.startsWith('xl/worksheets/') && name.endsWith('.xml')) return data
  }
  throw invalidRequest('文件里没有工作表')
}

export function parseXlsx(bytes: Uint8Array): string[][] {
  const files = readZip(bytes)
  const sheet = firstWorksheet(files)
  const shared = files.get('xl/sharedStrings.xml')
  const strings = shared === undefined ? [] : parseSharedStrings(decoder.decode(shared))
  return parseSheet(decoder.decode(sheet), strings)
}

export function buildXlsx(rows: readonly (readonly string[])[]): Uint8Array {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, cellIndex) => {
          const reference = `${columnName(cellIndex)}${String(rowIndex + 1)}`
          if (cell === '') return `<c r="${reference}"/>`
          return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`
        })
        .join('')
      return `<row r="${String(rowIndex + 1)}">${cells}</row>`
    })
    .join('')

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="账号" sheetId="1" r:id="rId1"/></sheets></workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`

  const encode = (text: string): Uint8Array => encoder.encode(text)
  return writeZip([
    { name: '[Content_Types].xml', data: encode(contentTypes) },
    { name: '_rels/.rels', data: encode(rootRels) },
    { name: 'xl/workbook.xml', data: encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encode(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: encode(sheet) },
  ])
}
