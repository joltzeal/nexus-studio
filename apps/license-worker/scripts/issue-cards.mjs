import { spawnSync } from 'node:child_process'
import { open, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [baseUrl, sku, requestedCount, destination, proxy] = process.argv.slice(2)
const origin = URL.parse(baseUrl ?? '')
const count = Number(requestedCount)
const pluginSlugs = [
  'address-generator',
  'ai-image',
  'email',
  'products',
  'proxy-pool',
  'sales-agent',
  'shared-supply',
  'sim8',
  'vinted-accounts',
  'vinted-monitor',
  'window-sync',
]
const allYear = sku === 'all-year'
const availableSkus = pluginSlugs.flatMap((slug) =>
  ['month', 'quarter', 'year'].map((term) => `${slug}-${term}`),
)
if (
  origin?.protocol !== 'https:' ||
  (baseUrl !== origin.origin && baseUrl !== `${origin.origin}/`) ||
  (!allYear && !availableSkus.includes(sku)) ||
  !Number.isInteger(count) ||
  count < 1 ||
  count > 100 ||
  !destination
) {
  console.error(
    `Usage: node scripts/issue-cards.mjs <https-issuer-origin> <plugin-month|plugin-quarter|plugin-year|all-year> <1-100 cards per SKU> <output-file> [proxy-url]\nPlugins: ${pluginSlugs.join(', ')}`,
  )
  process.exit(2)
}

const token = (
  await readFile(join(homedir(), '.config/raccoon/license-worker/ADMIN_TOKEN'), 'utf8')
).trim()
if (!token) throw new Error('The operator ADMIN_TOKEN file is empty')

function issueCards(productSku) {
  const lines = [
    `url = ${JSON.stringify(new URL('/v1/admin/cards', origin).href)}`,
    'request = "POST"',
    'header = "content-type: application/json"',
    `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}`,
    `data = ${JSON.stringify(JSON.stringify({ sku: productSku, count }))}`,
  ]
  if (proxy) lines.push(`proxy = ${JSON.stringify(proxy)}`, 'noproxy = ""')

  const result = spawnSync(
    'curl',
    [
      '-q',
      '--silent',
      '--show-error',
      '--max-time',
      '20',
      '--write-out',
      '\\n%{http_code}',
      '--config',
      '-',
    ],
    { input: lines.join('\n'), encoding: 'utf8', maxBuffer: 64 * 1024 },
  )
  if (result.status !== 0 || result.error) {
    throw new Error('Card issuance request failed before a response could be read')
  }
  const delimiter = result.stdout.lastIndexOf('\n')
  const status = Number(result.stdout.slice(delimiter + 1))
  if (status !== 201) throw new Error(`Card issuance failed (HTTP ${status})`)
  let codes
  try {
    codes = JSON.parse(result.stdout.slice(0, delimiter))?.codes
  } catch {
    throw new Error('Invalid card issuance response')
  }
  if (
    !Array.isArray(codes) ||
    codes.length !== count ||
    !codes.every((code) => typeof code === 'string' && /^RAC-[A-Z0-9]{16,32}$/.test(code))
  ) {
    throw new Error('Invalid card issuance response')
  }
  return codes
}

const skus = allYear ? pluginSlugs.map((slug) => `${slug}-year`) : [sku]
const file = await open(destination, 'wx', 0o600)
let saved = 0
let cardsReceived = false
let currentSku
try {
  for (currentSku of skus) {
    const codes = issueCards(currentSku)
    cardsReceived = true
    const rows = allYear ? codes.map((code) => `${currentSku}\t${code}`) : codes
    const header = allYear && saved === 0 ? 'sku\tcode\n' : ''
    await file.writeFile(`${header}${rows.join('\n')}\n`)
    await file.sync()
    saved += codes.length
  }
  console.log(`Issued ${saved} cards across ${skus.length} SKUs to ${destination}`)
} catch (error) {
  console.error(`${currentSku}: ${error.message}. ${saved} cards saved.`)
  if (cardsReceived) console.error(`Card file retained at ${destination}`)
  process.exitCode = 1
} finally {
  await file.close()
  if (!cardsReceived) await unlink(destination)
}
