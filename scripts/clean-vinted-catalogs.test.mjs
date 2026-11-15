import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'clean-vinted-catalogs.mjs')

function category(id, title, catalogs = [], extra = {}) {
  return {
    id,
    title,
    restricted_to_status_id: null,
    badge: null,
    photo: { url: 'https://images.invalid/category.png', thumbnails: [] },
    path: '',
    catalogs,
    ...extra,
  }
}

function fixture() {
  return {
    catalogs: [
      category(1, 'Home', [
        category(2, 'Decor', [], {
          full_title: 'Decor (Home)',
          path: 'Home',
        }),
      ]),
      category(3, 'Other'),
    ],
    code: 0,
  }
}

describe('local Vinted catalog cleaning', () => {
  let directory
  let input
  let output

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'raccoon-catalog-clean-'))
    input = join(directory, 'source.json')
    output = join(directory, 'cleaned.json')
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function run(source = fixture(), destination = output) {
    writeFileSync(input, JSON.stringify(source, null, 2))
    return spawnSync(process.execPath, [script, input, destination], {
      encoding: 'utf8',
    })
  }

  it('preserves IDs, tree order and disambiguation while removing visual metadata', () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    const clean = JSON.parse(readFileSync(output, 'utf8'))
    expect(clean.catalogs).toEqual([
      {
        id: 1,
        title: 'Home',
        catalogs: [{ id: 2, title: 'Decor', full_title: 'Decor (Home)' }],
      },
      { id: 3, title: 'Other' },
    ])
    expect(clean).toMatchObject({
      schemaVersion: 1,
      platform: 'vinted',
      market: 'US',
      locale: 'en-US',
      source: {
        endpoint: '/api/v2/item_upload/catalogs',
        sha256: createHash('sha256').update(readFileSync(input)).digest('hex'),
      },
    })
    expect(JSON.parse(result.stdout)).toMatchObject({
      nodes: 3,
      leaves: 2,
      maxDepth: 2,
      maxChildren: 2,
    })
  })

  it('retains an explicit category restriction instead of silently dropping it', () => {
    const source = fixture()
    source.catalogs[0].catalogs[0].restricted_to_status_id = 7
    expect(run(source).status).toBe(0)
    expect(
      JSON.parse(readFileSync(output, 'utf8')).catalogs[0].catalogs[0],
    ).toMatchObject({
      restricted_to_status_id: 7,
    })
  })

  it('preserves same-title categories in different branches', () => {
    const source = fixture()
    source.catalogs[1].title = 'Decor'
    expect(run(source).status).toBe(0)
    const clean = JSON.parse(readFileSync(output, 'utf8'))
    expect(clean.catalogs[0].catalogs[0].id).toBe(2)
    expect(clean.catalogs[1].id).toBe(3)
  })

  it('does not overwrite the source file', () => {
    const source = fixture()
    const result = run(source, input)
    expect(result.status).not.toBe(0)
    expect(JSON.parse(readFileSync(input, 'utf8'))).toEqual(source)
  })

  it.each([
    ['unsuccessful response', (value) => (value.code = 106)],
    ['duplicate category IDs', (value) => (value.catalogs[1].id = 2)],
    ['invalid category ID', (value) => (value.catalogs[1].id = -3)],
    ['blank title', (value) => (value.catalogs[1].title = ' ')],
    ['invalid children', (value) => (value.catalogs[1].catalogs = null)],
    [
      'inconsistent parent path',
      (value) => (value.catalogs[0].catalogs[0].path = 'Kids'),
    ],
    ['unknown source field', (value) => (value.catalogs[1].new_restriction = true)],
  ])('rejects %s and preserves the previous output', (_, change) => {
    const source = fixture()
    change(source)
    writeFileSync(output, 'previous output')
    const result = run(source)
    expect(result.status).not.toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('previous output')
  })

  it('produces identical bytes and content revisions on repeated runs', () => {
    expect(run().status).toBe(0)
    const first = readFileSync(output)
    expect(run().status).toBe(0)
    expect(readFileSync(output)).toEqual(first)
    const clean = JSON.parse(first)
    expect(clean.revision).toBe(
      createHash('sha256').update(JSON.stringify(clean.catalogs)).digest('hex'),
    )
  })
})
