import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Redactor } from '../rpc/redact.js'
import { createFileVault, createMemoryVault } from './secret-vault.js'

describe('file vault', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'proxy-vault-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps values in plaintext next to the inventory', async () => {
    const vault = createFileVault(directory, new Redactor())
    const stored = await vault.put('proxy-password', 'pw-secret')

    expect(stored.ref).toMatch(/^file:proxy-password:/)
    const raw = await readFile(join(directory, 'secrets.json'), 'utf8')
    expect(raw).toContain('pw-secret')
    expect(JSON.parse(raw)[stored.ref]).toBe('pw-secret')
  })

  it('writes the file with owner-only permissions', async () => {
    const vault = createFileVault(directory, new Redactor())
    await vault.put('proxy-password', 'pw-secret')
    const mode = (await stat(join(directory, 'secrets.json'))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('survives a new instance, so a restart does not lose passwords', async () => {
    const first = createFileVault(directory, new Redactor())
    const stored = await first.put('proxy-password', 'pw-secret')

    const second = createFileVault(directory, new Redactor())
    await expect(second.resolve(stored.ref)).resolves.toBe('pw-secret')
  })

  it('drops a reference and fails closed for unknown ones', async () => {
    const vault = createFileVault(directory, new Redactor())
    const stored = await vault.put('proxy-password', 'pw-secret')
    await vault.drop(stored.ref)
    await expect(vault.resolve(stored.ref)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    })
  })

  it('keeps fingerprints stable for duplicate detection', async () => {
    const first = createFileVault(directory, new Redactor())
    const second = createFileVault(directory, new Redactor())
    const left = await first.put('proxy-password', 'pw-secret')
    const right = await second.put('proxy-password', 'pw-secret')
    expect(left.fingerprint).toBe(right.fingerprint)
    expect(left.ref).not.toBe(right.ref)
  })

  it('reports that the memory vault is not durable', async () => {
    const vault = createMemoryVault(new Redactor())
    expect(vault.durable).toBe(false)
    const stored = await vault.put('proxy-password', 'pw-secret')
    await expect(vault.resolve(stored.ref)).resolves.toBe('pw-secret')
  })

  it('accepts a preallocated reference for a journaled transfer and refuses to overwrite it', async () => {
    const vault = createFileVault(directory, new Redactor())
    const ref = 'file:proxy-password:7d11a087-b81f-42a3-bcc4-46c125c70509'
    expect((await vault.put('proxy-password', 'imported-password', ref)).ref).toBe(ref)
    await expect(
      vault.put('proxy-password', 'replacement-password', ref),
    ).rejects.toThrow()
    await expect(vault.resolve(ref)).resolves.toBe('imported-password')
  })

  it('keeps memory and disk unchanged after a failed write or drop, so recovery can retry', async () => {
    const vault = createFileVault(directory, new Redactor())
    const existing = await vault.put('proxy-password', 'keep-password')
    const obstruction = join(directory, 'secrets.json.tmp')
    await mkdir(obstruction)
    const ref = 'file:proxy-password:b44ef56e-69fa-4c40-aed1-6586912645c3'
    await expect(vault.put('proxy-password', 'failed-password', ref)).rejects.toThrow()
    await expect(vault.resolve(ref)).rejects.toThrow()
    await expect(vault.drop(existing.ref)).rejects.toThrow()
    await expect(vault.resolve(existing.ref)).resolves.toBe('keep-password')
    await rm(obstruction, { recursive: true })
    await vault.drop(existing.ref)
    expect(JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8'))).toEqual(
      {},
    )
  })

  it('can drop an unstaged reference without requiring a vault write', async () => {
    const vault = createFileVault(directory, new Redactor())
    const existing = await vault.put('proxy-password', 'keep-password')
    await mkdir(join(directory, 'secrets.json.tmp'))
    await expect(vault.drop('file:proxy-password:not-staged')).resolves.toBeUndefined()
    await expect(vault.resolve(existing.ref)).resolves.toBe('keep-password')
  })
})
