import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batchProxySnapshot, templateProxyChoice } from './proxy.ts'
import { poolProxyChoice, profileProxyBinding } from '../profile-proxy.ts'

const capabilities = { manualProxy: true, proxyPlugin: true }

test('selecting a provider-owned proxy template requires an explicit replacement choice', () => {
  const source = {
    proxyMode: 'provider' as const,
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
  }
  const selected = templateProxyChoice(source)
  assert.equal(selected, '__template')
  assert.throws(() => batchProxySnapshot(selected, source, [], capabilities), /明确选择/)
  assert.equal(batchProxySnapshot('', source, [], capabilities).proxyMode, 'direct')
})

test('missing or unsupported required proxy settings never become direct', () => {
  const source = {
    proxyMode: 'manual' as const,
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
  }
  assert.throws(
    () => batchProxySnapshot(templateProxyChoice(source), source, [], capabilities),
    /手动代理/,
  )
  assert.throws(() => batchProxySnapshot('missing', null, [], capabilities), /代理不存在/)
  const plugin = {
    proxyMode: 'plugin' as const,
    proxy: null,
    proxyPlugin: 'example.proxy',
    proxyEndpoint: null,
  }
  assert.throws(
    () => batchProxySnapshot(templateProxyChoice(plugin), plugin, [], capabilities),
    /固定具体端点/,
  )
})

test('a selected library proxy preserves its native library reference', () => {
  const entry = {
    id: 'proxy-1',
    name: 'Fixture',
    kind: 'socks5' as const,
    host: '::1',
    port: 1080,
    username: 'fixture:user',
    password: 'fixture/value',
    country: '',
    notes: '',
  }
  const snapshot = batchProxySnapshot(entry.id, null, [entry], capabilities)
  assert.equal(snapshot.proxyMode, 'manual')
  assert.equal(snapshot.proxyId, entry.id)
  assert.equal(snapshot.proxy, null)
})

test('selecting a concrete plugin endpoint emits only the plugin reference', () => {
  const selected = poolProxyChoice(42)
  assert.deepEqual(batchProxySnapshot(selected, null, [], capabilities), {
    proxyMode: 'plugin',
    proxy: null,
    proxyId: null,
    proxyPlugin: 'studio.proxy-pool',
    proxyEndpoint: 42,
  })
  assert.throws(
    () => batchProxySnapshot(selected, null, [], { ...capabilities, proxyPlugin: false }),
    /不支持代理池/,
  )
  assert.throws(() => profileProxyBinding(`${selected}x`), /标识无效/)
})

test('batch templates retain an existing library reference without reconstructing credentials', () => {
  const source = {
    proxyMode: 'manual' as const,
    proxyId: 'library-id',
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
  }
  assert.deepEqual(
    batchProxySnapshot(templateProxyChoice(source), source, [], capabilities),
    source,
  )
})
