import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Uploads `market/` to an R2 bucket through wrangler.
 *
 * Packages go first and the selected catalog last: an interrupted run leaves the
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
    catalog: CATALOG,
    dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--bucket') options.bucket = argv[++index]
    else if (argument === '--market') options.market = resolve(argv[++index])
    else if (argument === '--catalog') options.catalog = argv[++index]
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument !== '--') throw new Error(`未知参数：${argument}`)
  }
  if (!/^[\w-]+(?:\.[\w-]+)*\.json$/.test(options.catalog ?? '')) {
    throw new Error('--catalog 需要市场目录下的 JSON 文件名')
  }
  return options
}

function catalogEntries(outer, filename) {
  if (outer.schemaVersion === 1 && !outer.signed && Array.isArray(outer.plugins)) {
    return outer.plugins
  }
  const { publicKey, payload, signature } = outer.signed ?? {}
  if (
    outer.schemaVersion !== 2 ||
    typeof publicKey !== 'string' ||
    typeof payload !== 'string' ||
    typeof signature !== 'string'
  ) {
    throw new Error('无效的市场目录版本或签名结构')
  }
  const bytes = Buffer.from(payload, 'base64')
  const verifier = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(publicKey, 'base64').toString('base64url'),
    },
  })
  if (!verify(null, bytes, verifier, Buffer.from(signature, 'base64'))) {
    throw new Error('市场目录签名无效')
  }
  const signed = JSON.parse(bytes)
  const url = new URL(signed.market?.catalogUrl)
  if (
    signed.schemaVersion !== 2 ||
    url.protocol !== 'https:' ||
    url.pathname !== `/${filename}` ||
    !Array.isArray(signed.plugins)
  ) {
    throw new Error('签名目录声明与发布文件名不一致')
  }
  return signed.plugins
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
const catalogPath = join(options.market, options.catalog)
if (!existsSync(catalogPath)) {
  console.error(`没有找到 ${catalogPath}，先执行 pnpm market:build`)
  process.exit(1)
}
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
const published = new Map(
  catalogEntries(catalog, options.catalog).map((entry) => [
    entry.package.url,
    entry.package,
  ]),
)
const packages = await packageFiles(options.market)

// Only upload what the catalog still points at; old versions can stay in the
// bucket, but packing a directory should not silently re-publish them either.
const wanted = packages.filter((file) => published.has(keyFor(options.market, file)))
const sizes = new Map()
for (const [path, reference] of published) {
  const file = wanted.find((file) => keyFor(options.market, file) === path)
  if (!file) {
    console.error(`catalog 引用了不存在的包：${path}`)
    process.exit(1)
  }
  const bytes = await readFile(file)
  if (
    createHash('sha256').update(bytes).digest('hex') !== reference.sha256 ||
    (reference.size != null && bytes.length !== reference.size)
  ) {
    console.error(`包大小或 SHA-256 与目录不一致：${path}`)
    process.exit(1)
  }
  sizes.set(file, bytes.length)
}

console.log(`桶 ${options.bucket}，${wanted.length} 个包 + ${options.catalog}`)
for (const file of wanted.sort()) {
  const size = sizes.get(file)
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

console.log(`↑ ${options.catalog}`)
const status = put({
  ...options,
  file: catalogPath,
  contentType: 'application/json',
  cacheControl: 'public, max-age=60',
})
if (status !== 0) process.exit(status)
console.log(`完成。商店中填写 ${options.catalog} 的完整公开 HTTPS 地址`)
