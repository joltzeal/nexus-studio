import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import worker from '../src/index'
import { base64, sha256 } from '../src/crypto'

const encoder = new TextEncoder()
const adminToken = 'test-admin-token'
const pepper = 'test-card-pepper'
const origin = 'https://license.example'
type TestEnv = Parameters<typeof worker.fetch>[1]

let runtime: Miniflare
let env: TestEnv
let signingKey: string
let device: CryptoKeyPair

async function call(
  path: string,
  data: Record<string, unknown>,
  key?: CryptoKeyPair,
  nonce = crypto.randomUUID().replaceAll('-', ''),
): Promise<Response> {
  const body = JSON.stringify(data)
  const headers = new Headers({ 'content-type': 'application/json' })
  if (path.startsWith('/v1/admin/')) {
    headers.set('authorization', `Bearer ${adminToken}`)
  } else if (key) {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const message = `v1\nPOST\n${path}\n${timestamp}\n${nonce}\n${await sha256(body)}`
    headers.set('x-device-time', timestamp)
    headers.set('x-device-nonce', nonce)
    headers.set(
      'x-device-signature',
      base64(
        new Uint8Array(
          await crypto.subtle.sign('Ed25519', key.privateKey, encoder.encode(message)),
        ),
      ),
    )
  }
  return worker.fetch(
    new Request(`${origin}${path}`, { method: 'POST', headers, body }),
    env,
  )
}

async function publicKey(key: CryptoKeyPair): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)))
}

async function issueCard(sku = 'sales-agent-month'): Promise<string> {
  const response = await call('/v1/admin/cards', { sku, count: 1 })
  expect(response.status).toBe(201)
  const { codes } = (await response.json()) as { codes: string[] }
  return codes[0]
}

async function redeem(
  card: string,
  key = device,
  nonce?: string,
  pluginId = 'studio.sales-agent',
): Promise<Response> {
  return call(
    '/v1/cards/redeem',
    { card, pluginId, devicePublicKey: await publicKey(key) },
    key,
    nonce,
  )
}

beforeEach(async () => {
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: 'license-test',
          compatibilityDate: '2026-11-15',
          manifest: {
            mainModule: 'worker.mjs',
            modules: {
              'worker.mjs': {
                type: 'esm',
                contents: 'export default { fetch() { return new Response("ok") } }',
              },
            },
          },
          env: { DB: { type: 'd1', name: 'license-test' } },
        },
      },
    ],
  })
  const db = await runtime.getD1Database('DB')
  for (const migrationName of ['0001_init.sql', '0002_all_plugin_products.sql']) {
    const migration = await readFile(
      fileURLToPath(new URL(`../migrations/${migrationName}`, import.meta.url)),
      'utf8',
    )
    await db.batch(
      migration
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => db.prepare(statement)),
    )
  }
  const signingPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  signingKey = base64(
    new Uint8Array(await crypto.subtle.exportKey('pkcs8', signingPair.privateKey)),
  )
  device = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  env = {
    DB: db as TestEnv['DB'],
    CARD_PEPPER: pepper,
    ADMIN_TOKEN: adminToken,
    LEASE_SIGNING_KEY: signingKey,
    LEASE_KEY_ID: 'test-key',
  }
})

afterEach(async () => {
  await runtime.dispose()
})

describe('license Worker with D1', () => {
  it('issues plugin-scoped cards for all first-party plugin SKUs', async () => {
    const plugins = [
      'studio.address-generator',
      'studio.ai-image',
      'studio.email',
      'studio.products',
      'studio.proxy-pool',
      'studio.sales-agent',
      'studio.shared-supply',
      'studio.sim8',
      'studio.vinted-accounts',
      'studio.vinted-monitor',
      'studio.window-sync',
    ]
    for (const pluginId of plugins) {
      const key = pluginId.replace('studio.', '')
      const card = await issueCard(`${key}-month`)
      const response = await redeem(card, device, undefined, pluginId)
      expect(response.status, pluginId).toBe(200)
      const { payload } = (await response.json()) as {
        payload: { pluginId: string }
      }
      expect(payload.pluginId).toBe(pluginId)
    }
  })

  it('issues SIM8 cards bound to SIM8 only', async () => {
    const card = await issueCard('sim8-month')
    expect((await redeem(card)).status).toBe(403)
    const response = await redeem(card, device, undefined, 'studio.sim8')
    expect(response.status).toBe(200)
    const { payload } = (await response.json()) as {
      payload: { pluginId: string; expiresAt: number }
    }
    expect(payload.pluginId).toBe('studio.sim8')
    expect(payload.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })
  it('redeems once, refreshes, and recovers a lost response on the same device', async () => {
    const card = await issueCard()
    const first = await redeem(card)
    expect(first.status).toBe(200)
    const { payload } = (await first.json()) as { payload: { licenseId: string } }
    expect((await redeem(card)).status).toBe(200)
    expect(
      (
        await call(
          '/v1/leases/refresh',
          { licenseId: payload.licenseId, devicePublicKey: await publicKey(device) },
          device,
        )
      ).status,
    ).toBe(200)
    const result = await env.DB.prepare('SELECT COUNT(*) AS total FROM licenses').first<{
      total: number
    }>()
    expect(result?.total).toBe(1)
  })

  it('allows only one device to win concurrent redemption of a card', async () => {
    const card = await issueCard()
    const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    const responses = await Promise.all([redeem(card), redeem(card, other)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
    const license = await env.DB.prepare('SELECT COUNT(*) AS total FROM licenses').first<{
      total: number
    }>()
    const devices = await env.DB.prepare('SELECT COUNT(*) AS total FROM devices').first<{
      total: number
    }>()
    expect(license?.total).toBe(1)
    expect(devices?.total).toBe(1)
  })

  it('rejects nonce replay and a different device after redemption', async () => {
    const card = await issueCard()
    const nonce = 'a'.repeat(32)
    expect((await redeem(card, device, nonce)).status).toBe(200)
    expect((await redeem(card, device, nonce)).status).toBe(403)
    const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    expect((await redeem(card, other)).status).toBe(403)
  })

  it('rejects refreshing a revoked license', async () => {
    const card = await issueCard()
    const response = await redeem(card)
    const { payload } = (await response.json()) as { payload: { licenseId: string } }
    const revoked = await call('/v1/admin/licenses/revoke', {
      licenseId: payload.licenseId,
    })
    expect(revoked.status).toBe(200)
    const refreshed = await call(
      '/v1/leases/refresh',
      { licenseId: payload.licenseId, devicePublicKey: await publicKey(device) },
      device,
    )
    expect(refreshed.status).toBe(403)
  })

  it('does not consume a card when the server signing key is invalid', async () => {
    const card = await issueCard()
    env.LEASE_SIGNING_KEY = 'invalid'
    expect((await redeem(card)).status).toBe(503)
    env.LEASE_SIGNING_KEY = signingKey
    expect((await redeem(card)).status).toBe(200)
  })

  it('reports an unavailable database as a service failure', async () => {
    await env.DB.exec('DROP TABLE cards;')
    const response = await call('/v1/admin/cards', {
      sku: 'sales-agent-month',
      count: 1,
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'service_unavailable' })
  })
})
