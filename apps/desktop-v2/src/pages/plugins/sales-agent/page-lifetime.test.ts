import { expect, it } from 'vitest'
import { PluginPageLifetime } from '../../../raccoon/plugins/page-lifetime'
import { RequestScope } from './state'
import {
  BatchSubmission,
  addDraftProducts,
  assignDraftProducts,
  emptyAgentDraft,
  setDraftWindows,
} from './assignment'
import { product, target } from './test-data'

it('keeps an in-flight scope and original creation identity when Activity hides the page', async () => {
  const lifetime = new PluginPageLifetime(true)
  const scope = new RequestScope()
  const release = lifetime.register(scope)
  const current = scope.begin()
  const submission = new BatchSubmission()
  const draft = assignDraftProducts(
    setDraftWindows(addDraftProducts(emptyAgentDraft(), [product]), [target.id]),
    [product.id],
    target.id,
  )
  const original = submission.prepare(draft, [target])
  lifetime.visible = false
  release()
  expect(current()).toBe(true)
  expect(submission.original()).toEqual(original)
  lifetime.visible = true
  const releaseAgain = lifetime.register(scope)
  expect(current()).toBe(true)
  releaseAgain()
  await Promise.resolve()
  expect(current()).toBe(false)
})

it('invalidates hidden requests when the connection or installed plugin lifetime ends', () => {
  const lifetime = new PluginPageLifetime(false)
  const scope = new RequestScope()
  const cleanup = lifetime.register(scope)
  const current = scope.begin()
  cleanup()
  expect(current()).toBe(true)
  lifetime.dispose()
  expect(current()).toBe(false)
})

it('invalidates a closed dialog after its cleanup settles without reconnecting', async () => {
  const lifetime = new PluginPageLifetime(true)
  const scope = new RequestScope()
  const cleanup = lifetime.register(scope)
  const current = scope.begin()
  cleanup()
  await Promise.resolve()
  expect(current()).toBe(false)
})

it('permits StrictMode effect setup again after its cleanup pass', async () => {
  const lifetime = new PluginPageLifetime(true)
  const scope = new RequestScope()
  lifetime.register(scope)()
  lifetime.dispose()
  const cleanup = lifetime.register(scope)
  const current = scope.begin()
  expect(current()).toBe(true)
  cleanup()
  await Promise.resolve()
  expect(current()).toBe(false)
})

it('preserves the existing pending request during StrictMode Activity reveal replay', async () => {
  const lifetime = new PluginPageLifetime(true)
  const scope = new RequestScope()
  const hide = lifetime.register(scope)
  const pending = scope.begin()
  lifetime.visible = false
  hide()
  await Promise.resolve()
  expect(pending()).toBe(true)
  lifetime.visible = true
  const strictCleanup = lifetime.register(scope)
  strictCleanup()
  lifetime.register(scope)
  await Promise.resolve()
  expect(pending()).toBe(true)
  lifetime.dispose()
  expect(pending()).toBe(false)
})
