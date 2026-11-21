import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROXY_POOL_PAGE_METHODS, supportsProxyPoolPage } from './page-contract.ts'

test('requires every method used by the desktop-v2 proxy pool page', () => {
  assert.equal(supportsProxyPoolPage(PROXY_POOL_PAGE_METHODS), true)
  assert.equal(supportsProxyPoolPage(PROXY_POOL_PAGE_METHODS.slice(0, -1)), false)
  assert.equal(
    supportsProxyPoolPage(['proxy.list', 'proxy.create', 'proxy.check']),
    false,
  )
})

test('excludes the removed Decodo port generator from the page contract', () => {
  assert.equal(PROXY_POOL_PAGE_METHODS.join(' ').includes('proxy.strategy.decodo'), false)
})
