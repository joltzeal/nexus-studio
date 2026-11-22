import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('signs the market identity, authorization policy and package checksum together', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'market-signing-test-'))
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const catalog = join(folder, 'unsigned.json')
    const config = join(folder, 'config.json')
    const key = join(folder, 'private.pem')
    const output = join(folder, 'catalog.json')
    const plugin = {
      manifest: { id: 'example.paid' },
      package: { url: 'plugin.nexuspkg', sha256: 'a'.repeat(64) },
    }
    await writeFile(catalog, JSON.stringify({ schemaVersion: 1, plugins: [plugin] }))
    await writeFile(
      config,
      JSON.stringify({
        id: 'example',
        catalogUrl: 'https://example.com/catalog.json',
        licensedPluginIds: ['example.paid'],
        licensing: {
          issuerId: 'example',
          baseUrl: 'https://licenses.example.com',
          protocolVersion: 1,
          keyId: 'example-1',
          publicKey:
            publicKey
              .export({ format: 'jwk' })
              .x.replaceAll('-', '+')
              .replaceAll('_', '/') + '=',
        },
      }),
    )
    await writeFile(key, privateKey.export({ format: 'pem', type: 'pkcs8' }))
    const signer = fileURLToPath(new URL('../sign-market.mjs', import.meta.url))
    execFileSync(process.execPath, [signer, catalog, config, key, output])

    const result = JSON.parse(await readFile(output, 'utf8'))
    expect(result.schemaVersion).toBe(2)
    const payload = Buffer.from(result.signed.payload, 'base64')
    const signature = Buffer.from(result.signed.signature, 'base64')
    const verifier = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(result.signed.publicKey, 'base64').toString('base64url'),
      },
    })
    expect(verify(null, payload, verifier, signature)).toBe(true)
    expect(JSON.parse(payload.toString())).toMatchObject({
      schemaVersion: 2,
      market: {
        id: 'example',
        catalogUrl: 'https://example.com/catalog.json',
        licensing: { baseUrl: 'https://licenses.example.com' },
      },
      plugins: [{ ...plugin, requiresLicense: true }],
    })
    expect(result.plugins).toEqual([plugin])
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
