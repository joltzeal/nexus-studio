import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PluginUiSession } from './ui-session.ts'
import { PluginUiTaskController } from './ui-task-runtime.ts'

const target = {
  pluginId: 'example.plugin',
  viewId: 'profile',
  profileId: 'profile-a',
  connectionId: 'connection-a',
  identity: 'installation-a:process-a',
}
const view = {
  protocolVersion: 1,
  revision: 'revision-a',
  title: 'Example',
  sections: [],
  actions: [],
}

test('late open response cannot replace a newer Profile panel', async () => {
  const pending: ((value: unknown) => void)[] = []
  const closed: string[] = []
  const session = new PluginUiSession(async (input) => {
    if (input.operation === 'close') {
      closed.push(input.profileId)
      return null
    }
    return new Promise((resolve) => pending.push(resolve))
  })
  const first = session.open(target)
  const second = session.open({ ...target, profileId: 'profile-b' })
  pending[1]!({ sessionId: 'session-b', view })
  await second
  pending[0]!({ sessionId: 'session-a', view })
  await first
  assert.equal(session.snapshot().target?.profileId, 'profile-b')
  assert.equal(session.snapshot().sessionId, 'session-b')
  assert.equal(closed.includes('profile-a'), true)
})

test('malformed plugin views remain errors and a closed panel discards dispatch results', async () => {
  let resolveDispatch: (value: unknown) => void = () => {}
  const session = new PluginUiSession(async (input) => {
    if (input.operation === 'close') return null
    if (input.operation === 'dispatch')
      return new Promise((resolve) => {
        resolveDispatch = resolve
      })
    return { sessionId: 'session-a', view }
  })
  await session.open(target)
  const request = session.dispatch('refresh', {})
  session.close()
  resolveDispatch({ sessionId: 'session-a', view })
  await request
  assert.equal(session.snapshot().target, null)
  const invalid = new PluginUiSession(async () => ({
    sessionId: 's',
    view: { ...view, protocolVersion: 2 },
  }))
  await invalid.open(target)
  assert.equal(invalid.snapshot().view, null)
  assert.ok(invalid.snapshot().error)
})

test('only accepted parsed open and dispatch views reach the app runtime', async () => {
  const observed: string[] = []
  const session = new PluginUiSession(
    async (input) => ({
      sessionId: 'session',
      view: { ...view, revision: input.operation },
    }),
    (scope, next) =>
      observed.push(`${scope.profileId}:${next.revision}:${next.tasks.length}`),
  )
  await session.open(target)
  await session.dispatch('refresh', {})
  session.close()
  assert.deepEqual(observed, ['profile-a:open:0', 'profile-a:dispatch:0'])
})

test('declared refresh transitions preserve metadata and cannot replay a notice', async () => {
  const delivered: string[] = []
  const controller = new PluginUiTaskController({
    rpc: async () => null,
    notice: (_, notice) => delivered.push(notice.id),
  })
  let revision = 0
  const session = new PluginUiSession(async (input) => {
    if (input.operation === 'dispatch') {
      assert.equal(input.actionId, 'refresh')
      assert.deepEqual(input.values, {})
      assert.equal(input.revision, '1')
    }
    return {
      sessionId: 'session',
      view: {
        ...view,
        revision: String(++revision),
        actions: [{ id: 'refresh', label: '读取最新资料' }],
        refresh: { actionId: 'refresh', intervalMs: 5000 },
        notices: [{ id: 'result', title: '完成', message: '资料已更新' }],
      },
    }
  }, controller.observe)
  await session.open(target)
  assert.equal(await session.dispatch('refresh', {}), true)
  assert.deepEqual(session.snapshot().view?.refresh, {
    actionId: 'refresh',
    intervalMs: 5000,
  })
  assert.equal(session.snapshot().view?.revision, '2')
  assert.deepEqual(delivered, ['result'])
  session.close()
  controller.dispose()
})
