import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, parseList, parseProxy } from './parse.ts'

const row = {
  id: '1',
  name: 'Test endpoint',
  groupId: null,
  schemes: ['http'],
  host: 'proxy.example.com',
  port: 8080,
  username: '',
  enabled: true,
  udp: true,
  hasPassword: false,
  checkStatus: 'unknown',
  checkedScheme: null,
  checkedAt: null,
  exitIp: null,
  previousExitIp: null,
  previousExitIpCheckedAt: null,
  exitIpChanged: false,
  geo: null,
  reputation: null,
  latencyMs: null,
  checkError: null,
}

test('rejects malformed endpoint IDs, schemes and status values before rendering', () => {
  assert.equal(parseProxy(row).id, '1')
  for (const patch of [
    { id: '1e3' },
    { port: 65536 },
    { schemes: [] },
    { checkStatus: 'ready' },
    { enabled: 'true' },
  ]) {
    assert.throws(() => parseProxy({ ...row, ...patch }))
  }
})

test('rejects duplicate and missing inventory pages while permitting an empty last page after deletion', () => {
  assert.throws(() => parseList({ total: 2, limit: 50, offset: 0, items: [] }))
  assert.throws(() => parseList({ total: 2, limit: 50, offset: 0, items: [row, row] }))
  assert.equal(parseList({ total: 0, limit: 50, offset: 50, items: [] }).items.length, 0)
})

test('keeps passwords out of the view and distinguishes unavailable risk from a zero score', () => {
  assert.equal(
    'password' in parseProxy({ ...row, password: 'fixture-never-returned' }),
    false,
  )
  assert.equal(parseProxy(row).reputation, null)
  assert.throws(() =>
    parseConfig({
      defaultEndpointId: '1',
      risk: { enabled: true, cacheSeconds: -1, hasApiKey: false },
    }),
  )
})

test('preserves provider origin on inventory endpoints and validates its identifiers', () => {
  const origin = {
    accountId: '23d4283e-3867-445e-b54e-ba78240ab051',
    subscriptionId: '9784c74b-fcbc-46d9-b65d-f74dbdbb0dfc',
  }
  assert.deepEqual(parseProxy({ ...row, origin }).origin, origin)
  assert.equal(parseProxy({ ...row, origin: null }).origin, null)
  assert.throws(() => parseProxy({ ...row, origin: { ...origin, accountId: '7' } }))
})
