import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readPackage, sha256Hex } from './lib/market-package.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Collects every packed `.nexuspkg` under `--out` and writes the `catalog.json`
 * the app fetches. Only the highest version of each plugin is published; older
 * packages stay in the bucket so an installed copy can still be repaired.
 */
function parseArgs(argv) {
  const options = { out: join(root, 'market') }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') options.out = resolve(argv[++index])
  }
  return options
}

function compare(left, right) {
  const parse = (value) =>
    value.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index] ?? 0
    const other = b[index] ?? 0
    if (one === other) continue
    if (typeof one === 'number' && typeof other === 'number') return one - other
    return String(one) < String(other) ? -1 : 1
  }
  return 0
}

const options = parseArgs(process.argv.slice(2))
const pluginsDirectory = join(options.out, 'plugins')
if (!existsSync(pluginsDirectory)) {
  console.error(`没有找到 ${pluginsDirectory}，先执行 pnpm market:pack`)
  process.exit(1)
}

const latest = new Map()
for (const id of await readdir(pluginsDirectory)) {
  const directory = join(pluginsDirectory, id)
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.nexuspkg')) continue
    const file = join(directory, name)
    const bytes = await readFile(file)
    const { header } = readPackage(bytes)
    const current = latest.get(header.manifest.id)
    if (
      current === undefined ||
      compare(header.manifest.version, current.manifest.version) > 0
    ) {
      latest.set(header.manifest.id, {
        header,
        manifest: header.manifest,
        file,
        size: bytes.length,
        sha256: sha256Hex(bytes),
      })
    }
  }
}

if (latest.size === 0) {
  console.error('没有找到任何 .nexuspkg，先执行 pnpm market:pack')
  process.exit(1)
}

const entries = [...latest.values()]
  .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
  .map(({ header, manifest, file, size, sha256 }) => ({
    manifest,
    description: header.description ?? '',
    changelog: header.changelog ?? '',
    package: {
      url: relative(options.out, file).split(sep).join('/'),
      size,
      sha256,
    },
  }))

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  plugins: entries,
}
const target = join(options.out, 'catalog.json')
await mkdir(options.out, { recursive: true })
await writeFile(target, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
console.log(`catalog.json 写入 ${target}，共 ${entries.length} 个插件`)
