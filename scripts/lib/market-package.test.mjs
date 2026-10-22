import { describe, expect, it } from 'vitest'

import {
  decryptPayload,
  deriveKey,
  encryptPayload,
  readPackage,
  sha256Hex,
  writePackage,
} from './market-package.mjs'

const MANIFEST = {
  apiVersion: 1,
  id: 'test.fixture-plugin',
  version: '1.2.0',
  name: 'Fixture',
  minCoreVersion: '0.1.0',
  capabilities: ['proxy.provider'],
  permissions: {
    networkDomains: ['example.com'],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
}

describe('market package format', () => {
  it('round-trips the encrypted entry point', () => {
    const key = deriveKey(MANIFEST.id, MANIFEST.version)
    const code = Buffer.from('export const answer = 42\n', 'utf8')
    const payload = encryptPayload(code, key)
    expect(payload.subarray(0, 7).toString('utf8')).toBe('NXPAY1\n')
    expect(decryptPayload(payload, key).equals(code)).toBe(true)
    // A different key must fail the authentication tag rather than return junk.
    expect(() => decryptPayload(payload, deriveKey(MANIFEST.id, '9.9.9'))).toThrow()
  })

  it('derives the same key the desktop host uses', () => {
    expect(deriveKey('test.fixture-plugin', '1.2.0').toString('hex')).toBe(
      '04038965c0fc9e471a427e59b5c5d3ba934621b5bba6bf982f0ecc1e4027ddbd',
    )
  })

  it('rejects a package whose body no longer matches its header', () => {
    const files = [
      { path: 'nexus.plugin.json', data: Buffer.from(JSON.stringify(MANIFEST)) },
      { path: 'bootstrap.cjs', data: Buffer.from("require('node:fs')\n") },
    ]
    const bytes = writePackage({
      manifest: MANIFEST,
      entry: 'bootstrap.cjs',
      files,
      createdAt: '2026-10-23T00:00:00.000Z',
    })
    const parsed = readPackage(bytes)
    expect(parsed.header.entry).toBe('bootstrap.cjs')
    expect(parsed.files.map((file) => file.path)).toEqual([
      'nexus.plugin.json',
      'bootstrap.cjs',
    ])
    expect(parsed.header.files[0].sha256).toBe(sha256Hex(files[0].data))

    const corrupted = Buffer.from(bytes)
    corrupted[corrupted.length - 1] ^= 0xff
    expect(() => readPackage(corrupted)).toThrow(/checksum/)
    expect(() => readPackage(Buffer.from('nope'))).toThrow(/nexuspkg/)
  })
})
