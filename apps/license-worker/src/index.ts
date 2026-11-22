import { addMonths, base64, cardHash, signLease, verifyDevice } from './crypto'

interface Env {
  DB: D1Database
  CARD_PEPPER: string
  ADMIN_TOKEN: string
  LEASE_SIGNING_KEY: string
  LEASE_KEY_ID: string
  LEASE_ISSUER_ID?: string
}

type Data = Record<string, unknown>
class InvalidBody extends Error {}
const json = (data: Data, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
const reject = (status = 403): Response => json({ error: 'request_denied' }, status)
const string = (value: unknown, max = 256): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null

async function readBody(request: Request): Promise<{ raw: string; data: Data }> {
  const raw = await request.text()
  if (raw.length > 8192) throw new InvalidBody()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new InvalidBody()
  }
  if (data === null || Array.isArray(data) || typeof data !== 'object')
    throw new InvalidBody()
  return { raw, data: data as Data }
}

async function lease(
  env: Env,
  id: string,
  pluginId: string,
  publicKey: string,
  expiresAt: number,
  revision: number,
  now: number,
): Promise<Response> {
  const fields = {
    v: 1,
    licenseId: id,
    pluginId,
    devicePublicKey: publicKey,
    issuedAt: now,
    expiresAt,
    offlineUntil: Math.min(expiresAt, now + 72 * 3600),
    refreshAfter: Math.min(expiresAt, now + 12 * 3600),
    revision,
    keyId: env.LEASE_KEY_ID,
    ...(env.LEASE_ISSUER_ID ? { issuerId: env.LEASE_ISSUER_ID } : {}),
  }
  return json(await signLease(fields, env.LEASE_SIGNING_KEY))
}

async function authenticateDevice(
  request: Request,
  raw: string,
  publicKey: string,
): Promise<{ nonce: string; now: number } | null> {
  try {
    return await verifyDevice(request, raw, publicKey)
  } catch {
    return null
  }
}

async function admin(
  request: Request,
  env: Env,
  path: string,
  data: Data,
): Promise<Response> {
  if (
    !env.ADMIN_TOKEN ||
    request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`
  )
    return reject()
  if (path === '/v1/admin/cards') {
    const sku = string(data.sku)
    const count = data.count
    if (
      !sku ||
      !Number.isInteger(count) ||
      (count as number) < 1 ||
      (count as number) > 100
    )
      return reject(400)
    const product = await env.DB.prepare(
      'SELECT sku FROM products WHERE sku = ? AND enabled = 1',
    )
      .bind(sku)
      .first()
    if (!product) return reject(404)
    const codes = Array.from(
      { length: count as number },
      () =>
        `RAC-${base64(crypto.getRandomValues(new Uint8Array(24)))
          .replace(/[+/=]/g, '')
          .toUpperCase()}`,
    )
    await env.DB.batch(
      await Promise.all(
        codes.map(async (code) =>
          env.DB.prepare('INSERT INTO cards (card_hash, sku) VALUES (?, ?)').bind(
            await cardHash(code, env.CARD_PEPPER),
            sku,
          ),
        ),
      ),
    )
    return json({ codes }, 201)
  }
  if (path === '/v1/admin/licenses/revoke') {
    const id = string(data.licenseId)
    if (!id) return reject(400)
    const result = await env.DB.prepare(
      "UPDATE licenses SET status = 'revoked', revision = revision + 1 WHERE id = ? AND status = 'active'",
    )
      .bind(id)
      .run()
    return result.meta.changes ? json({ revoked: true }) : reject(404)
  }
  return reject(404)
}

async function redeem(
  request: Request,
  env: Env,
  raw: string,
  data: Data,
): Promise<Response> {
  const card = string(data.card, 128)
  const pluginId = string(data.pluginId)
  const publicKey = string(data.devicePublicKey)
  if (!card || !pluginId || !publicKey) return reject(400)
  const verified = await authenticateDevice(request, raw, publicKey)
  if (!verified) return reject()
  const { nonce, now } = verified
  // Validate the signing key before the atomic redemption; an invalid key must not consume a card.
  await signLease({ v: 1 }, env.LEASE_SIGNING_KEY)
  const hash = await cardHash(card, env.CARD_PEPPER)
  const product = await env.DB.prepare(
    'SELECT p.plugin_id, p.duration_months FROM cards c JOIN products p ON c.sku = p.sku WHERE c.card_hash = ? AND c.status = ? AND p.enabled = 1',
  )
    .bind(hash, 'available')
    .first<{ plugin_id: string; duration_months: number }>()
  if (!product || product.plugin_id !== pluginId) {
    const existing = await env.DB.prepare(
      "SELECT l.id, l.plugin_id, l.expires_at, l.revision FROM cards c JOIN licenses l ON c.license_id = l.id JOIN devices d ON d.license_id = l.id WHERE c.card_hash = ? AND c.status = 'redeemed' AND l.status = 'active' AND d.status = 'active' AND d.public_key = ? AND l.plugin_id = ? AND l.expires_at > ?",
    )
      .bind(hash, publicKey, pluginId, now)
      .first<{ id: string; plugin_id: string; expires_at: number; revision: number }>()
    if (!existing) return reject()
    const used = await env.DB.prepare(
      'INSERT OR IGNORE INTO nonces (public_key, nonce, used_at) VALUES (?, ?, ?)',
    )
      .bind(publicKey, nonce, now)
      .run()
    if (used.meta.changes !== 1) return reject()
    return lease(
      env,
      existing.id,
      existing.plugin_id,
      publicKey,
      existing.expires_at,
      existing.revision,
      now,
    )
  }
  const id = crypto.randomUUID()
  const expires = addMonths(now, product.duration_months)
  const results = await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO nonces (public_key, nonce, used_at) VALUES (?, ?, ?)',
    ).bind(publicKey, nonce, now),
    env.DB.prepare(
      "UPDATE cards SET status = 'redeemed', license_id = ?, redeemed_at = ? WHERE card_hash = ? AND status = 'available' AND sku IN (SELECT sku FROM products WHERE plugin_id = ? AND enabled = 1)",
    ).bind(id, now, hash, pluginId),
    env.DB.prepare(
      "INSERT INTO licenses (id, plugin_id, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE card_hash = ? AND license_id = ? AND status = 'redeemed')",
    ).bind(id, pluginId, expires, hash, id),
    env.DB.prepare(
      'INSERT INTO devices (license_id, public_key, activated_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM licenses WHERE id = ?)',
    ).bind(id, publicKey, now, id),
  ])
  if (results.some((row) => row.meta.changes !== 1)) return reject()
  return lease(env, id, pluginId, publicKey, expires, 1, now)
}

async function refresh(
  request: Request,
  env: Env,
  raw: string,
  data: Data,
): Promise<Response> {
  const id = string(data.licenseId)
  const publicKey = string(data.devicePublicKey)
  if (!id || !publicKey) return reject(400)
  const verified = await authenticateDevice(request, raw, publicKey)
  if (!verified) return reject()
  const { nonce, now } = verified
  await signLease({ v: 1 }, env.LEASE_SIGNING_KEY)
  const record = await env.DB.prepare(
    "SELECT l.plugin_id, l.expires_at, l.revision FROM licenses l JOIN devices d ON l.id = d.license_id WHERE l.id = ? AND d.public_key = ? AND l.status = 'active' AND d.status = 'active' AND l.expires_at > ?",
  )
    .bind(id, publicKey, now)
    .first<{ plugin_id: string; expires_at: number; revision: number }>()
  if (!record) return reject()
  const used = await env.DB.prepare(
    'INSERT OR IGNORE INTO nonces (public_key, nonce, used_at) VALUES (?, ?, ?)',
  )
    .bind(publicKey, nonce, now)
    .run()
  if (used.meta.changes !== 1) return reject()
  return lease(
    env,
    id,
    record.plugin_id,
    publicKey,
    record.expires_at,
    record.revision,
    now,
  )
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'GET' && new URL(request.url).pathname === '/health')
      return json({ ok: true })
    if (request.method !== 'POST') return reject(404)
    if (!env.DB || !env.CARD_PEPPER || !env.LEASE_SIGNING_KEY || !env.LEASE_KEY_ID)
      return json({ error: 'not_configured' }, 503)
    const path = new URL(request.url).pathname
    if (
      ![
        '/v1/cards/redeem',
        '/v1/leases/refresh',
        '/v1/admin/cards',
        '/v1/admin/licenses/revoke',
      ].includes(path)
    )
      return reject(404)
    try {
      const { raw, data } = await readBody(request)
      if (path.startsWith('/v1/admin/')) return await admin(request, env, path, data)
      if (path === '/v1/cards/redeem') return await redeem(request, env, raw, data)
      return await refresh(request, env, raw, data)
    } catch (error) {
      // Never echo cards, device signatures, SQL diagnostics or key material.
      if (error instanceof InvalidBody) return reject(400)
      return json({ error: 'service_unavailable' }, 503)
    }
  },
} satisfies ExportedHandler<Env>
