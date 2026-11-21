import assert from 'node:assert/strict'
import test from 'node:test'
import { createApiClient } from '../client.js'

const configuration = { endpoint: 'http://127.0.0.1:43123', token: 'test-token' }

test('accepts only an explicit local origin and a nonempty token', () => {
  for (const endpoint of [
    undefined,
    'http://localhost:1234',
    'https://127.0.0.1:1234',
    'http://192.0.2.1',
    'http://127.0.0.1/path',
    'http://user:pass@127.0.0.1',
    'http://127.0.0.1?token=value',
  ]) {
    assert.throws(() => createApiClient({ ...configuration, endpoint }))
  }
  for (const token of [undefined, '', ' ', 'a b', 'a\nb']) {
    assert.throws(() => createApiClient({ ...configuration, token }))
  }
})

test('requires explicit scope before sending and keeps concurrent connections separate', async () => {
  const requests = []
  const api = createApiClient({
    ...configuration,
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return Response.json({ connectionId: url.searchParams.get('connectionId') })
    },
  })
  for (const connectionId of [undefined, '', ' ', 'a\nb', 'a'.repeat(257)]) {
    await assert.rejects(api('/automation/projects', { connectionId }), /connectionId/)
  }
  assert.equal(requests.length, 0)
  const results = await Promise.all([
    api('/automation/projects', { connectionId: 'connection-a' }),
    api('/automation/runs', { connectionId: 'connection-b' }),
  ])
  assert.deepEqual(results, [
    { connectionId: 'connection-a' },
    { connectionId: 'connection-b' },
  ])
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token')
  assert.equal(requests[0].options.redirect, 'error')
})

test('serializes stable run operation identity without retrying uncertain writes', async () => {
  let attempts = 0
  const api = createApiClient({
    ...configuration,
    fetchImpl: async (url, options) => {
      attempts++
      assert.equal(url.searchParams.get('connectionId'), 'connection-a')
      assert.deepEqual(JSON.parse(options.body), { operationId: 'stable-operation' })
      throw new Error('transport failed with private details')
    },
  })
  await assert.rejects(
    api('/automation/projects/id/run', {
      connectionId: 'connection-a',
      method: 'POST',
      body: { operationId: 'stable-operation' },
    }),
    /Reconcile/,
  )
  assert.equal(attempts, 1)
})

test('surfaces structured service errors and invalid response errors', async () => {
  const api = createApiClient({
    ...configuration,
    fetchImpl: async () =>
      Response.json(
        { code: 'scope_mismatch', error: 'Resource belongs to another Workspace' },
        { status: 403 },
      ),
  })
  await assert.rejects(
    api('/automation/projects', { connectionId: 'a' }),
    /scope_mismatch/,
  )
  const invalid = createApiClient({
    ...configuration,
    fetchImpl: async () => new Response('bad gateway', { status: 502 }),
  })
  await assert.rejects(
    invalid('/automation/projects', { connectionId: 'a' }),
    /invalid response/,
  )
})
