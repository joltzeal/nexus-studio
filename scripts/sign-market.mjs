import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [catalogPath, configPath, keyPath, outputPath] = process.argv.slice(2)
if (!catalogPath || !configPath || !keyPath || !outputPath) {
  throw new Error(
    'Usage: node scripts/sign-market.mjs INPUT_CATALOG MARKET_CONFIG ED25519_PEM OUTPUT_CATALOG',
  )
}
if (
  resolve(outputPath) === resolve(keyPath) ||
  resolve(outputPath) === resolve(configPath)
) {
  throw new Error('Output must be a catalog file')
}

const [catalogJson, configJson, keyPem] = await Promise.all([
  readFile(catalogPath, 'utf8'),
  readFile(configPath, 'utf8'),
  readFile(keyPath, 'utf8'),
])
const { schemaVersion, generatedAt, plugins } = JSON.parse(catalogJson)
const { id, catalogUrl, licensing, licensedPluginIds } = JSON.parse(configJson)
const identifier = /^[a-zA-Z0-9._-]{1,128}$/
const source = new URL(catalogUrl)
if (
  typeof id !== 'string' ||
  !identifier.test(id) ||
  source.protocol !== 'https:' ||
  source.username ||
  source.password ||
  source.search ||
  source.hash ||
  !source.pathname.endsWith('.json') ||
  catalogUrl !== source.href ||
  catalogUrl.length > 2048
) {
  throw new Error('Invalid market id or HTTPS catalog URL')
}
if (
  schemaVersion !== 1 ||
  !Array.isArray(plugins) ||
  plugins.length > 256 ||
  plugins.some(
    (plugin) =>
      !plugin?.manifest?.id ||
      !plugin?.package?.url ||
      !/^[a-f0-9]{64}$/.test(plugin.package.sha256),
  )
) {
  throw new Error('Invalid version 1 catalog')
}
const pluginIds = new Set(plugins.map((plugin) => plugin.manifest.id))
if (
  pluginIds.size !== plugins.length ||
  !Array.isArray(licensedPluginIds) ||
  licensedPluginIds.some((pluginId) => !pluginIds.has(pluginId))
) {
  throw new Error('Duplicate plugin ID or unknown licensed plugin')
}

let authority = null
if (licensing != null) {
  const { issuerId, protocolVersion, baseUrl, keyId, publicKey } = licensing
  const origin = new URL(baseUrl)
  if (
    protocolVersion !== 1 ||
    typeof issuerId !== 'string' ||
    !identifier.test(issuerId) ||
    typeof keyId !== 'string' ||
    !identifier.test(keyId) ||
    origin.protocol !== 'https:' ||
    typeof publicKey !== 'string' ||
    !/^[a-zA-Z0-9+/]{43}=$/.test(publicKey) ||
    (baseUrl !== origin.origin && baseUrl !== `${origin.origin}/`)
  ) {
    throw new Error(
      'Invalid license protocol, issuer, HTTPS origin or Ed25519 public key',
    )
  }
  authority = { issuerId, protocolVersion, baseUrl, keyId, publicKey }
}
if (licensedPluginIds.length > 0 && !authority) {
  throw new Error('Licensed plugins require an authorization service')
}

const key = createPrivateKey(keyPem)
if (key.asymmetricKeyType !== 'ed25519')
  throw new Error('Expected an Ed25519 private key')
const publicKey = createPublicKey(key).export({ format: 'jwk' }).x
const payload = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    generatedAt,
    market: { id, catalogUrl, licensing: authority },
    plugins: plugins.map((plugin) => ({
      ...plugin,
      requiresLicense: licensedPluginIds.includes(plugin.manifest.id),
    })),
  }),
)
const result = JSON.stringify(
  {
    schemaVersion: 2,
    generatedAt,
    plugins,
    signed: {
      publicKey: Buffer.from(publicKey, 'base64url').toString('base64'),
      payload: payload.toString('base64'),
      signature: sign(null, payload, key).toString('base64'),
    },
  },
  null,
  2,
)
if (Buffer.byteLength(result) + 1 > 1024 * 1024)
  throw new Error('Signed catalog exceeds 1 MiB')
await writeFile(outputPath, `${result}\n`)
