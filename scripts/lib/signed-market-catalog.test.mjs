import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('signs the market identity, authorization policy and package checksum together', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'market-signing-test-'))
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const catalog = join(folder, 'package-index.json')
    const config = join(folder, 'config.json')
    const key = join(folder, 'private.pem')
    const output = join(folder, 'catalog.json')
    const plugin = {
      manifest: { id: 'example.paid' },
      package: { url: 'plugin.nexuspkg', sha256: 'a'.repeat(64) },
    }
    await writeFile(catalog, JSON.stringify({ plugins: [plugin] }))
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
    expect(result).not.toHaveProperty('plugins')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

it('publishes the selected signed catalog after its verified package', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'market-publishing-test-'))
  try {
    const { privateKey } = generateKeyPairSync('ed25519')
    const catalog = join(folder, 'package-index.json')
    const config = join(folder, 'config.json')
    const key = join(folder, 'private.pem')
    const output = join(folder, 'catalog-v2.json')
    const path = 'plugins/example.free/1.0.0.nexuspkg'
    const bytes = Buffer.from('test package')
    await mkdir(join(folder, 'plugins/example.free'), { recursive: true })
    await writeFile(join(folder, path), bytes)
    await writeFile(
      catalog,
      JSON.stringify({
        plugins: [
          {
            manifest: { id: 'example.free', version: '1.0.0' },
            package: {
              url: path,
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          },
        ],
      }),
    )
    await writeFile(
      config,
      JSON.stringify({
        id: 'example',
        catalogUrl: 'https://market.example.com/catalog-v2.json',
        licensedPluginIds: [],
      }),
    )
    await writeFile(key, privateKey.export({ format: 'pem', type: 'pkcs8' }))
    const script = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url))
    execFileSync(process.execPath, [
      script('sign-market.mjs'),
      catalog,
      config,
      key,
      output,
    ])

    const dryRun = () =>
      execFileSync(
        process.execPath,
        [
          script('publish-market.mjs'),
          '--market',
          folder,
          '--catalog',
          'catalog-v2.json',
          '--dry-run',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    const summary = dryRun()
    expect(summary).toContain(`nexus-studio-market/${path}`)
    expect(summary).toContain('nexus-studio-market/catalog-v2.json')
    expect(summary).not.toContain('nexus-studio-market/catalog.json')
    expect(summary.indexOf(`nexus-studio-market/${path}`)).toBeLessThan(
      summary.indexOf('nexus-studio-market/catalog-v2.json'),
    )

    const signed = JSON.parse(await readFile(output, 'utf8'))
    signed.plugins = []
    await writeFile(output, JSON.stringify(signed))
    expect(dryRun()).toContain(`nexus-studio-market/${path}`)

    await writeFile(join(folder, path), Buffer.from('wrong bytes!'))
    expect(() => dryRun()).toThrow(/SHA-256/)

    signed.signed.signature = Buffer.alloc(64).toString('base64')
    await writeFile(output, JSON.stringify(signed))
    expect(() => dryRun()).toThrow(/签名无效/)

    await writeFile(output, JSON.stringify({ schemaVersion: 1, plugins: [] }))
    expect(() => dryRun()).toThrow(/无效的市场目录版本或签名结构/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
