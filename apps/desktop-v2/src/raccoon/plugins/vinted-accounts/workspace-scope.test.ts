import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceScope } from './workspace-scope.ts'

test('workspace changes clear transient account UI and discard late operations', async () => {
  const scope = new WorkspaceScope('connection-a')
  const operation = scope.begin()
  scope.setTransient({ selected: ['account-1'], dialog: 'edit' })
  let release!: (value: string) => void
  const delayed = new Promise<string>((resolve) => {
    release = resolve
  })
  const pending = scope.guard(operation, delayed, (value) => value)
  scope.switchTo('connection-b')
  assert.deepEqual(scope.transient, { selected: [], dialog: null })
  release('late account data')
  assert.equal(await pending, null)
  assert.equal(scope.current(operation), false)
})

test('identical workspace selection preserves the current request generation', () => {
  const scope = new WorkspaceScope('connection-a')
  const token = scope.begin()
  scope.switchTo('connection-a')
  assert.equal(scope.current(token), true)
})

test('unmount invalidation rejects late responses even after remounting same workspace', () => {
  const scope = new WorkspaceScope('connection-a')
  const token = scope.begin()
  scope.invalidate()
  assert.equal(scope.current(token), false)
})
