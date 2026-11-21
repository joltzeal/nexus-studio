import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindCreatedProfile } from './profile-batch-binding.ts'

test('retries a completed association without creating or overwriting another relationship', async () => {
  let writes = 0
  await bindCreatedProfile(
    {
      bindings: async () => ({ items: [{ accountId: 'a', windowId: 'p' }] }),
      bindAccount: async () => {
        writes++
        return { bound: true }
      },
    },
    'a',
    'p',
    async () => true,
    () => true,
  )
  assert.equal(writes, 0)
  await assert.rejects(
    bindCreatedProfile(
      {
        bindings: async () => ({ items: [{ accountId: 'other', windowId: 'p' }] }),
        bindAccount: async () => {
          writes++
          return { bound: true }
        },
      },
      'a',
      'p',
      async () => true,
      () => true,
    ),
    /其他账号/,
  )
  assert.equal(writes, 0)
})

test('confirms duplicate associations and rechecks them before writing', async () => {
  let reads = 0
  const confirmations: string[][] = []
  const writes: unknown[] = []
  const ports = {
    bindings: async () => {
      reads++
      return { items: [{ accountId: 'a', windowId: 'old' }] }
    },
    bindAccount: async (...args: [string, string, boolean]) => {
      writes.push(args)
      return { bound: true }
    },
  }
  await bindCreatedProfile(
    ports,
    'a',
    'p',
    async (duplicates) => {
      confirmations.push(duplicates)
      return true
    },
    () => true,
  )
  assert.equal(reads, 2)
  assert.deepEqual(confirmations, [['old']])
  assert.deepEqual(writes, [
    ['a', 'p', true, { windowAccountId: null, duplicateWindowIds: ['old'] }],
  ])
})

test('cancellation, changed bindings and invalidated sessions prevent association', async () => {
  let writes = 0
  let reads = 0
  const ports = {
    bindings: async () => ({
      items: [{ accountId: 'a', windowId: ++reads === 1 ? 'old' : 'new' }],
    }),
    bindAccount: async () => {
      writes++
      return { bound: true }
    },
  }
  await assert.rejects(
    bindCreatedProfile(
      ports,
      'a',
      'p',
      async () => false,
      () => true,
    ),
    /取消/,
  )
  reads = 0
  await assert.rejects(
    bindCreatedProfile(
      ports,
      'a',
      'p',
      async () => true,
      () => true,
    ),
    /关联已变化/,
  )
  await assert.rejects(
    bindCreatedProfile(
      ports,
      'a',
      'p',
      async () => true,
      () => false,
    ),
    /会话已变化/,
  )
  assert.equal(writes, 0)
})
