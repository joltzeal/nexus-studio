import { describe, expect, it } from 'vitest'
import { definePluginManifest, PluginManifestSchema } from './index.js'
import type { PluginManifest } from './index.js'

const manifest: PluginManifest = {
  apiVersion: 1,
  id: 'studio.image-demo',
  version: '1.2.3-beta.1+build.42',
  name: 'Image demo',
  minCoreVersion: '0.1.0',
  capabilities: ['image.provider'],
  permissions: {
    networkDomains: ['api.example.com', 'xn--bcher-kva.example'],
    wantsBrowserAccess: false,
    storage: 'none',
    secrets: ['image-api-key'],
  },
}

describe('plugin manifest', () => {
  it('validates a typed manifest without loading or executing plugin code', () => {
    expect(definePluginManifest(manifest)).toEqual(manifest)
  })

  it.each([
    { apiVersion: 2 },
    { apiVersion: '1' },
    { schemaVersion: 1 },
    { capabilities: ['browser.launch'] },
    { id: 'image-demo' },
    { id: 'studio..image' },
    { id: 'studio.image_' },
    { version: 'latest' },
    { version: '01.2.3' },
    { minCoreVersion: '>=1.0.0' },
    { name: '  ' },
    { execute: 'code' },
  ])('rejects incompatible or malformed manifest fields: %j', (overrides) => {
    expect(PluginManifestSchema.safeParse({ ...manifest, ...overrides }).success).toBe(
      false,
    )
  })

  it.each([
    'https://example.com',
    'user:password@example.com',
    'example.com:443',
    'example.com/path',
    'example.com?token=secret',
    '*.example.com',
    '-invalid.example.com',
    'invalid-.example.com',
    'invalid_name.example.com',
    `${'a'.repeat(64)}.example.com`,
    '127.0.0.1',
    '[::1]',
    'localhost',
    '',
  ])('rejects a network permission that is not a domain name: %s', (domain) => {
    expect(
      PluginManifestSchema.safeParse({
        ...manifest,
        permissions: { ...manifest.permissions, networkDomains: [domain] },
      }).success,
    ).toBe(false)
  })

  it('rejects unknown nested permissions and missing permission declarations', () => {
    expect(
      PluginManifestSchema.safeParse({
        ...manifest,
        permissions: { ...manifest.permissions, allowAll: true },
      }).success,
    ).toBe(false)
    expect(PluginManifestSchema.safeParse({ ...manifest, permissions: {} }).success).toBe(
      false,
    )
  })
})
