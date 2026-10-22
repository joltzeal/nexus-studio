import { describe, expect, it } from 'vitest'

import { buildXlsx, parseCsv, parseXlsx, serializeCsv } from './table.js'

describe('csv', () => {
  it('reads quoted fields, escaped quotes and a BOM', () => {
    const text = '\uFEFF账号,密码,备注\r\n"a@b.com","pa""ss","第一行\n第二行"\r\n'
    expect(parseCsv(text)).toEqual([
      ['账号', '密码', '备注'],
      ['a@b.com', 'pa"ss', '第一行\n第二行'],
    ])
  })

  it('detects a semicolon separated export', () => {
    expect(parseCsv('账号;密码\nuser@x.com;secret\n')).toEqual([
      ['账号', '密码'],
      ['user@x.com', 'secret'],
    ])
  })

  it('drops blank lines and keeps an empty trailing cell', () => {
    expect(parseCsv('a,b\n\n1,\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ])
  })

  it('round-trips a cell that needs quoting', () => {
    const rows = [
      ['账号', '备注'],
      ['a@b.com', '逗号, 引号" 和换行\n都在这里'],
    ]
    expect(parseCsv(serializeCsv(rows))).toEqual(rows)
  })
})

describe('xlsx', () => {
  const rows = [
    ['登录方式', '账号', '密码', '备注'],
    ['email', 'a@b.com', 'p&ss<1>', '中文备注'],
    ['google', 'b@c.com', '', ''],
  ]

  it('round-trips a workbook it wrote itself', () => {
    expect(parseXlsx(buildXlsx(rows))).toEqual(rows)
  })

  it('reads shared strings and stored entries', () => {
    // Excel writes text through sharedStrings.xml and may store entries
    // uncompressed; neither path is exercised by the writer above.
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="D2" t="str"><v>末尾</v></c></row>
</sheetData></worksheet>`
    const shared = `<?xml version="1.0"?><sst><si><t>账号</t></si><si><t>密码</t></si><si><r><t>a@</t></r><r><t>b.com</t></r></si></sst>`
    const bytes = storedZip({
      'xl/worksheets/sheet1.xml': sheet,
      'xl/sharedStrings.xml': shared,
    })
    expect(parseXlsx(bytes)).toEqual([
      ['账号', '密码'],
      ['a@b.com', '42', '', '末尾'],
    ])
  })

  it('rejects bytes that are not a workbook', () => {
    expect(() => parseXlsx(new TextEncoder().encode('not a zip'))).toThrow(
      /不是有效的 xlsx/,
    )
  })
})

/**
 * A deliberately separate, uncompressed zip writer: the reader is validated
 * against a fixture built from the format description, not from its own output.
 */
function storedZip(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(text)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, 0, true) // stored
    localView.setUint32(14, crc, true)
    localView.setUint32(18, data.length, true)
    localView.setUint32(22, data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    locals.push(local, data)

    const record = new Uint8Array(46 + nameBytes.length)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x02014b50, true)
    recordView.setUint16(4, 20, true)
    recordView.setUint16(6, 20, true)
    recordView.setUint32(16, crc, true)
    recordView.setUint32(20, data.length, true)
    recordView.setUint32(24, data.length, true)
    recordView.setUint16(28, nameBytes.length, true)
    recordView.setUint32(42, offset, true)
    record.set(nameBytes, 46)
    directory.push(record)

    offset += local.length + data.length
  }
  const directorySize = directory.reduce((total, entry) => total + entry.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, directory.length, true)
  endView.setUint16(10, directory.length, true)
  endView.setUint32(12, directorySize, true)
  endView.setUint32(16, offset, true)
  const total = [...locals, ...directory, end].reduce(
    (size, entry) => size + entry.length,
    0,
  )
  const output = new Uint8Array(total)
  let cursor = 0
  for (const entry of [...locals, ...directory, end]) {
    output.set(entry, cursor)
    cursor += entry.length
  }
  return output
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
