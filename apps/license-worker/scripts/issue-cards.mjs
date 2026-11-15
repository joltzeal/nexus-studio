import { execFileSync } from 'node:child_process'
import { open, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [sku, requestedCount, destination, proxy] = process.argv.slice(2)
const count = Number(requestedCount)
if (
  !/^(address-generator|ai-image|email|products|proxy-pool|sales-agent|shared-supply|sim8|vinted-accounts|vinted-monitor|window-sync)-(month|quarter|year)$/.test(
    sku ?? '',
  ) ||
  !Number.isInteger(count) ||
  count < 1 ||
  count > 100 ||
  !destination
) {
  console.error(
    'Usage: node scripts/issue-cards.mjs <plugin-month|plugin-quarter|plugin-year> <1-100> <output-file> [proxy-url]; plugin: address-generator, ai-image, email, products, proxy-pool, sales-agent, shared-supply, sim8, vinted-accounts, vinted-monitor, window-sync',
  )
  process.exit(2)
}

const token = (
  await readFile(join(homedir(), '.config/raccoon/license-worker/ADMIN_TOKEN'), 'utf8')
).trim()
const lines = [
  'url = "https://raccoon-license.bravesfly.workers.dev/v1/admin/cards"',
  'request = "POST"',
  'header = "content-type: application/json"',
  `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}`,
  `data = ${JSON.stringify(JSON.stringify({ sku, count }))}`,
]
if (proxy) lines.push(`proxy = ${JSON.stringify(proxy)}`)

const file = await open(destination, 'wx', 0o600)
try {
  const result = execFileSync(
    'curl',
    [
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
  const delimiter = result.lastIndexOf('\n')
  const status = Number(result.slice(delimiter + 1))
  if (status !== 201) throw new Error(`Card issuance failed (HTTP ${status})`)
  const { codes } = JSON.parse(result.slice(0, delimiter))
  if (
    !Array.isArray(codes) ||
    codes.length !== count ||
    !codes.every((code) => /^RAC-[A-Z0-9]{16,32}$/.test(code))
  ) {
    throw new Error('Invalid card issuance response')
  }
  await file.writeFile(`${codes.join('\n')}\n`)
  await file.sync()
  console.log(`Issued ${codes.length} cards to ${destination}`)
} catch (error) {
  await file.close()
  await unlink(destination)
  throw error
}
await file.close()
