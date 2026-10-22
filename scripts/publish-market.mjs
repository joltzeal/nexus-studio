import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Uploads `market/` to an R2 bucket through wrangler.
 *
 * Packages go first and `catalog.json` last: an interrupted run then leaves the
 * published catalog pointing only at files that already exist.
 *
 * Every write passes `--remote`. Wrangler 4 defaults R2 object commands to the
 * local simulator, which silently "succeeds" into `.wrangler/state` and leaves
 * the real bucket empty.
 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WRANGLER = 'wrangler@4'
const CATALOG = 'catalog.json'

function parseArgs(argv) {
  const options = {
    bucket: 'nexus-studio-market',
    market: join(root, 'market'),
    dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--bucket') options.bucket = argv[++index]
    else if (argument === '--market') options.market = resolve(argv[++index])
    else if (argument === '--dry-run') options.dryRun = true
  }
  return options
}

async function packageFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await packageFiles(path)))
    else if (entry.name.endsWith('.nexuspkg')) files.push(path)
  }
  return files
}

function keyFor(market, file) {
  return relative(market, file).split(sep).join('/')
}

function put({ bucket, market, file, cacheControl, contentType, dryRun }) {
  const args = [
    'r2',
    'object',
    'put',
    `${bucket}/${keyFor(market, file)}`,
    '--file',
    file,
    '--content-type',
    contentType,
    '--cache-control',
    cacheControl,
    // Wrangler 4 writes R2 objects to the local simulator unless this is set.
    // Without it an "upload" only lands in `.wrangler/state` on this machine.
    '--remote',
  ]
  if (dryRun) {
    const quoted = args.map((argument) =>
      argument.includes(' ') ? JSON.stringify(argument) : argument,
    )
    console.log(`npx --yes ${WRANGLER} ${quoted.join(' ')}`)
    return 0
  }
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const result = spawnSync(command, ['--yes', WRANGLER, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

const options = parseArgs(process.argv.slice(2))
const catalogPath = join(options.market, CATALOG)
if (!existsSync(catalogPath)) {
  console.error(`没有找到 ${catalogPath}，先执行 pnpm market:build`)
  process.exit(1)
}
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
const published = new Set((catalog.plugins ?? []).map((entry) => entry.package?.url))
const packages = await packageFiles(options.market)

// Only upload what the catalog still points at; old versions can stay in the
// bucket, but packing a directory should not silently re-publish them either.
const wanted = packages.filter((file) => published.has(keyFor(options.market, file)))
for (const missing of published) {
  if (missing === undefined) continue
  if (!wanted.some((file) => keyFor(options.market, file) === missing)) {
    console.error(`catalog 引用了不存在的包：${missing}`)
    process.exit(1)
  }
}

console.log(`桶 ${options.bucket}，${wanted.length} 个包 + catalog.json`)
for (const file of wanted.sort()) {
  const { size } = await stat(file)
  console.log(`↑ ${keyFor(options.market, file)} (${Math.round(size / 1024)} KB)`)
  const status = put({
    ...options,
    file,
    contentType: 'application/octet-stream',
    cacheControl: 'public, max-age=31536000, immutable',
  })
  if (status !== 0) {
    console.error('上传失败。先确认已登录：npx wrangler login')
    process.exit(status)
  }
}

console.log(`↑ ${CATALOG}`)
const status = put({
  ...options,
  file: catalogPath,
  contentType: 'application/json',
  cacheControl: 'public, max-age=60',
})
if (status !== 0) process.exit(status)
console.log(`完成。商店地址填桶的公开域名，例如 https://pub-xxxx.r2.dev`)
