import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleEntry } from './lib/bundler.mjs'
import {
  bootstrapSource,
  deriveKey,
  encryptPayload,
  sha256Hex,
  writePackage,
} from './lib/market-package.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Turns a built plugin directory into a `.nexuspkg` the host can install.
 *
 * The compiled entry is bundled into one file, encrypted with AES-256-GCM and
 * stored as `payload.bin`; a generated loader decrypts it in memory at start
 * time. The key is derived from the plugin id and version plus a salt that only
 * lives in the desktop binary, so the published package alone is not enough to
 * read the source.
 */
async function pack(directory, { out, changelog }) {
  const manifestPath = join(directory, 'dist/nexus.plugin.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`${directory} 还没有构建，先执行 pnpm build:packages`)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const main = typeof pkg.main === 'string' ? pkg.main : './dist/src/index.js'
  const input = resolve(directory, main)
  if (!existsSync(input)) throw new Error(`${input} 不存在，先构建插件`)

  const code = await bundleEntry({ root, input })
  const key = deriveKey(manifest.id, manifest.version)
  const payload = encryptPayload(code, key)

  const files = [
    {
      path: 'nexus.plugin.json',
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    },
    { path: 'bootstrap.cjs', data: Buffer.from(bootstrapSource(), 'utf8') },
    {
      path: 'package.json',
      data: Buffer.from(
        JSON.stringify(
          { name: manifest.id, version: manifest.version, main: 'bootstrap.cjs' },
          null,
          2,
        ) + '\n',
        'utf8',
      ),
    },
    { path: 'payload.bin', data: payload },
  ]

  const archive = writePackage({
    manifest,
    entry: 'bootstrap.cjs',
    description: typeof pkg.description === 'string' ? pkg.description : '',
    changelog,
    files,
  })
  const target = join(out, 'plugins', manifest.id, `${manifest.version}.nexuspkg`)
  await mkdir(resolve(target, '..'), { recursive: true })
  await writeFile(target, archive)
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    file: target,
    size: archive.length,
    sha256: sha256Hex(archive),
    bundled: code.length,
  }
}

function parseArgs(argv) {
  const options = { out: join(root, 'market'), changelog: '', plugins: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--out') options.out = resolve(argv[++index])
    else if (argument === '--changelog') options.changelog = argv[++index] ?? ''
    else options.plugins.push(argument)
  }
  return options
}

async function pluginDirectories(explicit) {
  if (explicit.length > 0) return explicit.map((entry) => resolve(root, entry))
  const base = join(root, 'plugins')
  const names = await readdir(base, { withFileTypes: true })
  return names
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name))
    .filter((directory) => existsSync(join(directory, 'dist/nexus.plugin.json')))
}

const options = parseArgs(process.argv.slice(2))
const directories = await pluginDirectories(options.plugins)
if (directories.length === 0) {
  console.error('没有可打包的插件：先执行 pnpm build:packages')
  process.exit(1)
}

for (const directory of directories) {
  const result = await pack(directory, options)
  console.log(
    `${result.id} ${result.version} → ${result.file} ` +
      `(${Math.round(result.size / 1024)} KiB，源码 ${Math.round(result.bundled / 1024)} KiB)`,
  )
}
