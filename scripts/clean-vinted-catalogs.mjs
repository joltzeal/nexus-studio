import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

const sourceFields = new Set([
  'id',
  'title',
  'full_title',
  'path',
  'catalogs',
  'restricted_to_status_id',
  'badge',
  'photo',
])
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function clean(source) {
  if (
    !object(source) ||
    source.code !== 0 ||
    Object.keys(source).some((key) => !['code', 'catalogs'].includes(key)) ||
    !Array.isArray(source.catalogs) ||
    source.catalogs.length === 0
  ) {
    throw new Error('Expected a successful Vinted catalog response.')
  }
  const seen = new Set()
  const stats = {
    nodes: 0,
    leaves: 0,
    maxDepth: 0,
    maxChildren: source.catalogs.length,
  }
  function visit(node, parents) {
    if (
      !object(node) ||
      Object.keys(node).some((key) => !sourceFields.has(key)) ||
      !Number.isSafeInteger(node.id) ||
      node.id <= 0 ||
      seen.has(node.id) ||
      !text(node.title) ||
      !Array.isArray(node.catalogs) ||
      parents.length >= 64 ||
      stats.nodes >= 100_000
    ) {
      throw new Error('Invalid, duplicate or unsupported catalog node.')
    }
    if (node.path !== parents.join(' > ')) {
      throw new Error('The source path disagrees with the category tree.')
    }
    if (node.full_title !== undefined && !text(node.full_title)) {
      throw new Error('Invalid category full_title.')
    }
    const restriction = node.restricted_to_status_id
    if (
      restriction !== undefined &&
      restriction !== null &&
      (!Number.isSafeInteger(restriction) || restriction < 0)
    ) {
      throw new Error('Invalid category restriction.')
    }
    seen.add(node.id)
    stats.nodes += 1
    stats.maxDepth = Math.max(stats.maxDepth, parents.length + 1)
    stats.maxChildren = Math.max(stats.maxChildren, node.catalogs.length)
    const result = { id: node.id, title: node.title }
    if (node.full_title !== undefined) result.full_title = node.full_title
    if (restriction !== undefined && restriction !== null) {
      result.restricted_to_status_id = restriction
    }
    if (node.catalogs.length) {
      result.catalogs = node.catalogs.map((child) =>
        visit(child, [...parents, node.title]),
      )
    } else {
      stats.leaves += 1
    }
    return result
  }
  return { catalogs: source.catalogs.map((node) => visit(node, [])), stats }
}

function main() {
  if (process.argv.length !== 4) {
    throw new Error(
      'Usage: node scripts/clean-vinted-catalogs.mjs <source.json> <output.json>',
    )
  }
  const input = realpathSync(resolve(process.argv[2]))
  const output = resolve(process.argv[3])
  if (input === output || (existsSync(output) && realpathSync(output) === input)) {
    throw new Error('The cleaned output must not replace the source file.')
  }
  const bytes = readFileSync(input)
  if (bytes.length > 16 * 1024 * 1024) {
    throw new Error('The source exceeds the 16 MiB cleaning budget.')
  }
  const { catalogs, stats } = clean(JSON.parse(bytes.toString('utf8')))
  const revision = sha256(JSON.stringify(catalogs))
  const document = {
    schemaVersion: 1,
    platform: 'vinted',
    market: 'US',
    locale: 'en-US',
    source: {
      endpoint: '/api/v2/item_upload/catalogs',
      sha256: sha256(bytes),
    },
    revision,
    catalogs,
  }
  const contents = `${JSON.stringify(document)}\n`
  mkdirSync(dirname(output), { recursive: true })
  const temporary = `${output}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { flag: 'wx' })
    renameSync(temporary, output)
  } finally {
    rmSync(temporary, { force: true })
  }
  process.stdout.write(
    `${JSON.stringify({
      ...stats,
      inputBytes: bytes.length,
      outputBytes: Buffer.byteLength(contents),
      sourceSha256: document.source.sha256,
      revision,
      outputSha256: sha256(contents),
    })}\n`,
  )
}

try {
  main()
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Catalog cleaning failed.'}\n`,
  )
  process.exitCode = 1
}
