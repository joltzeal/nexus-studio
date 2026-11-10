import { describe, expect, it } from 'vitest'
import { runtimeWindow } from '../fixtures/runtime-window.js'
import { parseRuntimeWindow, type RuntimeWindow } from './index.js'

describe('version 2 built-in runtime window', () => {
  it('preserves the serialized record, opaque plugin reference and numeric pinned proxy endpoint', () => {
    const record: RuntimeWindow = runtimeWindow({
      proxy_mode: 'plugin',
      proxy: 'http://synthetic-user:p%40ss@proxy.example:8080',
      proxy_plugin: 'opaque/plugin-ref:v2',
      proxy_endpoint: 37,
      provider_config: { marker: { values: [1, 'opaque', null, false] } },
      origin: 'attached',
      last_opened_at: 1_794_268_900,
      sort_order: -1,
    })
    const serialized = JSON.stringify(record)
    const parsed = parseRuntimeWindow(JSON.parse(serialized) as unknown)
    expect(parsed).toEqual(record)
    expect(parsed.proxy_endpoint).toBe(37)
    expect(JSON.stringify(parsed)).toBe(serialized)
  })

  it.each([null, 1, Number.MAX_SAFE_INTEGER])(
    'preserves a nullable positive safe integer proxy endpoint %j',
    (proxy_endpoint) => {
      const record = runtimeWindow({
        proxy_mode: 'plugin',
        proxy_plugin: 'opaque/plugin-ref:v2',
        proxy_endpoint,
      })
      expect(parseRuntimeWindow(record).proxy_endpoint).toBe(proxy_endpoint)
    },
  )

  it.each([
    '37',
    'opaque/endpoint-ref:v2',
    '',
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    -Infinity,
    true,
    {},
    [],
    undefined,
  ])('rejects an invalid proxy endpoint without coercion (%j)', (proxy_endpoint) => {
    const record = runtimeWindow({
      proxy_mode: 'plugin',
      proxy_plugin: 'opaque/plugin-ref:v2',
    })
    expect(() => parseRuntimeWindow({ ...record, proxy_endpoint })).toThrow(
      'PROFILE_RECORD_INVALID',
    )
  })

  it.each([4, 5])(
    'requires and preserves an explicit full %s-part kernel version',
    (parts) => {
      const record = runtimeWindow({
        kernel_version: parts === 4 ? '155.0.8059.39' : '155.0.8059.39.2',
      })
      expect(parseRuntimeWindow(record).kernel_version).toBe(record.kernel_version)
    },
  )

  it.each([1, 2_147_483_647])(
    'preserves a fixed fingerprint seed at the boundary %s',
    (seed) => {
      const record = runtimeWindow()
      record.settings.fingerprintSeed = seed
      expect(parseRuntimeWindow(record).settings.fingerprintSeed).toBe(seed)
    },
  )

  it('accepts an unresolved plugin proxy for offline snapshots without resolving or rewriting it', () => {
    const record = runtimeWindow({
      proxy_mode: 'plugin',
      proxy_plugin: 'opaque/plugin-ref:v2',
      proxy_endpoint: 37,
    })
    expect(parseRuntimeWindow(record)).toEqual(record)
    expect(record.proxy).toBeNull()
  })

  it.each(Object.keys(runtimeWindow()))(
    'rejects a missing required field %s without defaulting it',
    (field) => {
      const record: Record<string, unknown> = { ...runtimeWindow() }
      delete record[field]
      expect(() => parseRuntimeWindow(record)).toThrow('PROFILE_RECORD_INVALID')
    },
  )

  it.each(Object.keys(runtimeWindow().settings))(
    'rejects a missing camelCase settings field %s',
    (field) => {
      const record = runtimeWindow()
      const settings: Record<string, unknown> = { ...record.settings }
      delete settings[field]
      expect(() => parseRuntimeWindow({ ...record, settings })).toThrow(
        'PROFILE_RECORD_INVALID',
      )
    },
  )

  it.each([
    ['array origin', { origin: ['created'] }],
    ['unknown origin', { origin: 'imported' }],
    ['blank name', { name: ' ' }],
    ['invalid window ID', { id: 'profile' }],
    ['null provider config', { provider_config: null }],
    ['array provider config', { provider_config: [] }],
    ['string timestamp', { created_at: '1794268800' }],
    ['negative timestamp', { created_at: -1 }],
    ['fractional last-opened timestamp', { last_opened_at: 1.5 }],
    ['invalid sort order', { sort_order: 1.5 }],
    ['unknown record version field', { version: '155.0.8059.39' }],
  ])('rejects malformed metadata: %s', (_label, overrides) => {
    expect(() => parseRuntimeWindow({ ...runtimeWindow(), ...overrides })).toThrow(
      'PROFILE_RECORD_INVALID',
    )
  })

  it.each([null, [], 'record', 2, false])('rejects a non-record payload %j', (value) => {
    expect(() => parseRuntimeWindow(value)).toThrow('PROFILE_RECORD_INVALID')
  })
})
