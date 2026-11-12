import { describe, expect, it } from 'vitest'
import { parseMailboxImport } from './import.js'

const clientId = '00000000-0000-4000-8000-000000000001'
describe('four field mailbox import', () => {
  it('accepts BOM, CRLF, blank lines and an empty optional password', () => {
    const result = parseMailboxImport(
      `\uFEFF one@outlook.com----pass----${clientId}----synthetic-refresh-a\r\n\r\ntwo@hotmail.com--------${clientId}----synthetic-refresh-b\r\n`,
    )
    expect(result.total).toBe(2)
    expect(result.rows).toEqual([
      {
        row: 1,
        email: 'one@outlook.com',
        password: 'pass',
        clientId,
        refreshToken: 'synthetic-refresh-a',
      },
      {
        row: 3,
        email: 'two@hotmail.com',
        password: '',
        clientId,
        refreshToken: 'synthetic-refresh-b',
      },
    ])
  })

  it('reports individual row errors without echoing credential text', () => {
    const secret = 'synthetic-private-refresh-value'
    const result = parseMailboxImport(
      `bad-mail----secret----${clientId}----${secret}\nvalid@outlook.com----pass----bad-id----${secret}\nvalid@hotmail.com----pass----${clientId}----ok-token\nincomplete`,
    )
    expect(result.rows).toHaveLength(1)
    expect(result.errors.map((error) => error.row)).toEqual([1, 2, 4])
    expect(JSON.stringify(result.errors)).not.toContain(secret)
    expect(JSON.stringify(result.errors)).not.toContain('secret')
  })

  it('rejects excessive lines or bytes before parsing', () => {
    expect(() => parseMailboxImport('x\n'.repeat(501))).toThrow()
    expect(() => parseMailboxImport('a'.repeat(512 * 1024 + 1))).toThrow()
  })
})
