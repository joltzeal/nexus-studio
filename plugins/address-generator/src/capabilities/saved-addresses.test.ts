import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AddressGenerator } from './address-generator.js'
import type { ProfileRecord } from '../domain/address.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { Redactor, createLogger } from '../rpc/redact.js'
import type { PublicAddressService } from '../services/overpass.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
} from '../store/private-store.js'
import { createMemoryVault } from '../store/secret-vault.js'

const profile: ProfileRecord = {
  id: 'profile-1',
  street: 'Example Avenue',
  houseNumber: '12',
  city: 'Seattle',
  postalCode: '98101',
  countryCode: 'US',
  state: 'WA',
  county: null,
  latitude: 47.6062,
  longitude: -122.3321,
  source: 'map',
  sourceUrl: '',
  approximate: false,
  firstName: 'Alex',
  lastName: 'Example',
  username: 'alex.example',
}

function generator(store: PrivateStore) {
  const redactor = new Redactor()
  return new AddressGenerator({
    store,
    vault: createMemoryVault(redactor),
    lookup: {
      list: () => {
        throw new Error('Saving an address must not use a network lookup')
      },
    } as unknown as PublicAddressService,
    logger: createLogger(() => undefined, redactor),
    now: () => new Date('2026-11-11T10:00:00.000Z'),
  })
}

function context(method: string, payload: unknown = {}): DispatchContext {
  return {
    requestId: 'saved-address-test',
    capability: 'address.generator',
    method,
    payload,
    deadlineAt: Date.now() + 5000,
    assertAlive: () => undefined,
  }
}

const directories: string[] = []
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'nexus-saved-addresses-'))
  directories.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  )
})

describe('saved addresses', () => {
  it('persists the whole selected profile and restores it after reopening the plugin', async () => {
    const path = await directory()
    const plugin = generator(createFileStore(path))
    const saved = await plugin.call(context('address.saved.save', { profile }))
    expect(saved).toEqual({
      item: { ...profile, savedAt: '2026-11-11T10:00:00.000Z' },
      created: true,
      storageDurable: true,
    })
    const reopened = generator(createFileStore(path))
    expect(await reopened.call(context('address.saved.list'))).toMatchObject({
      items: [{ ...profile, savedAt: '2026-11-11T10:00:00.000Z' }],
      total: 1,
      page: 1,
      pageSize: 20,
      storageDurable: true,
    })
  })

  it('keeps the saved identity when the same location is generated again', async () => {
    const plugin = generator(createMemoryStore())
    await plugin.call(context('address.saved.save', { profile }))
    const result = await plugin.call(
      context('address.saved.save', {
        profile: {
          ...profile,
          id: 'profile-2',
          firstName: 'Other',
          street: '  EXAMPLE Avenue ',
        },
      }),
    )
    expect(result).toMatchObject({
      item: { id: 'profile-1', firstName: 'Alex' },
      created: false,
    })
    expect(await plugin.call(context('address.saved.list'))).toMatchObject({ total: 1 })
  })

  it('preserves concurrent saves while the file store is first loading', async () => {
    const path = await directory()
    const plugin = generator(createFileStore(path))
    await Promise.all([
      plugin.call(context('address.saved.list')),
      ...Array.from({ length: 12 }, (_, index) =>
        plugin.call(
          context('address.saved.save', {
            profile: { ...profile, id: `parallel-${index}`, houseNumber: String(index) },
          }),
        ),
      ),
    ])
    const reopened = generator(createFileStore(path))
    expect(await reopened.call(context('address.saved.list'))).toMatchObject({
      total: 12,
    })
  })

  it('rejects reusing a profile ID for a different address', async () => {
    const plugin = generator(createMemoryStore())
    await plugin.call(context('address.saved.save', { profile }))
    await expect(
      plugin.call(
        context('address.saved.save', { profile: { ...profile, city: 'Portland' } }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await plugin.call(context('address.saved.list'))).toMatchObject({
      total: 1,
      items: [{ id: profile.id, city: 'Seattle' }],
    })
  })

  it('searches and paginates saved addresses with the newest first', async () => {
    const plugin = generator(createMemoryStore())
    for (let index = 0; index < 24; index += 1) {
      await plugin.call(
        context('address.saved.save', {
          profile: { ...profile, id: `profile-${index}`, houseNumber: String(index) },
        }),
      )
    }
    const result = await plugin.call(
      context('address.saved.list', { query: 'SEATTLE', page: 2, pageSize: 10 }),
    )
    expect(result).toMatchObject({ total: 24, page: 2, pageSize: 10 })
    expect((result as { items: ProfileRecord[] }).items.map((entry) => entry.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `profile-${13 - index}`),
    )
    expect(
      await plugin.call(context('address.saved.list', { query: 'unknown city' })),
    ).toMatchObject({
      items: [],
      total: 0,
    })
  })

  it('removes a saved profile durably and is idempotent', async () => {
    const path = await directory()
    const plugin = generator(createFileStore(path))
    await plugin.call(context('address.saved.save', { profile }))
    expect(
      await plugin.call(context('address.saved.remove', { id: profile.id })),
    ).toEqual({ removed: true })
    expect(
      await plugin.call(context('address.saved.remove', { id: profile.id })),
    ).toEqual({ removed: false })
    expect(
      await generator(createFileStore(path)).call(context('address.saved.list')),
    ).toMatchObject({ total: 0 })
  })

  it('preserves the previous saved data when writing fails', async () => {
    const path = await directory()
    const store = createFileStore(path)
    const plugin = generator(store)
    await plugin.call(context('address.saved.save', { profile }))
    await mkdir(join(path, 'address-generator.json.tmp'))
    await expect(
      plugin.call(context('address.saved.remove', { id: profile.id })),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(await plugin.call(context('address.saved.list'))).toMatchObject({ total: 1 })
    expect(
      await generator(createFileStore(path)).call(context('address.saved.list')),
    ).toMatchObject({ total: 1 })
  })

  it('adds an empty saved collection to an existing map configuration without losing its key reference', async () => {
    const path = await directory()
    await writeFile(
      join(path, 'address-generator.json'),
      JSON.stringify({
        schemaVersion: 1,
        maps: { apiKeyRef: 'fixture-ref' },
      }),
    )
    const store = createFileStore(path)
    const plugin = generator(store)
    expect(await plugin.call(context('address.saved.list'))).toMatchObject({
      items: [],
      total: 0,
    })
    await plugin.call(context('address.saved.save', { profile }))
    expect(
      JSON.parse(await readFile(join(path, 'address-generator.json'), 'utf8')),
    ).toMatchObject({
      maps: { apiKeyRef: 'fixture-ref' },
      savedProfiles: [{ id: 'profile-1' }],
    })
  })

  it('rejects incomplete or oversized requests and leaves the collection unchanged', async () => {
    const plugin = generator(createMemoryStore())
    for (const value of [
      { ...profile, postalCode: '' },
      { ...profile, latitude: 100 },
      { ...profile, countryCode: 'UNKNOWN' },
    ]) {
      await expect(
        plugin.call(context('address.saved.save', { profile: value })),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    await expect(
      plugin.call(context('address.saved.list', { pageSize: 51 })),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await plugin.call(context('address.saved.list'))).toMatchObject({ total: 0 })
  })

  it('keeps a maximum-sized saved page below the host message limit', async () => {
    const plugin = generator(createMemoryStore())
    const escaped = '\u0001'
    for (let index = 0; index < 50; index += 1) {
      await plugin.call(
        context('address.saved.save', {
          profile: {
            ...profile,
            id: `sized-${index}`,
            street: escaped.repeat(200),
            houseNumber: String(index),
            city: escaped.repeat(120),
            postalCode: escaped.repeat(16),
            state: escaped.repeat(120),
            county: escaped.repeat(120),
            sourceUrl: escaped.repeat(2048),
            firstName: escaped.repeat(80),
            lastName: escaped.repeat(80),
          },
        }),
      )
    }
    const result = await plugin.call(context('address.saved.list', { pageSize: 50 }))
    expect(result).toMatchObject({ total: 50, pageSize: 50 })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024 - 1024)
  })

  it('checks cancellation again before mutating saved addresses', async () => {
    const store = createMemoryStore()
    const plugin = generator(store)
    const call = context('address.saved.save', { profile })
    call.assertAlive = () => {
      throw new Error('cancelled')
    }
    await expect(plugin.call(call)).rejects.toThrow('cancelled')
    expect(await store.read()).toMatchObject({ savedProfiles: [] })
  })
})
