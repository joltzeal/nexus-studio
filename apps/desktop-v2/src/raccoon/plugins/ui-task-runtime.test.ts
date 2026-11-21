import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PluginUiViewSchema, type PluginUiNotice } from '@nexus/plugin-sdk/ui'
import { PluginUiTaskController, type PluginUiTaskRequest } from './ui-task-runtime.ts'
import { TestClock, flush, runtimePlugin } from './ui-runtime.test-support.ts'
import { PluginUiSession } from './ui-session.ts'

const target = {
  pluginId: 'example.plugin',
  viewId: 'profile',
  profileId: 'profile',
  connectionId: 'connection',
  identity: 'install:process',
}
const notice: PluginUiNotice = {
  id: 'result',
  title: 'Result',
  message: 'Complete',
  tone: 'success',
}
const view = (deadlineAt = 31_000, taskId = 'task') =>
  PluginUiViewSchema.parse({
    protocolVersion: 1,
    revision: '1',
    title: 'Example',
    sections: [],
    tasks: [
      {
        id: taskId,
        label: 'Waiting',
        deadlineAt,
        pollIntervalMs: 5000,
        timeoutNotice: { ...notice, id: `timeout-${taskId}`, tone: 'warning' },
      },
    ],
  })

test('tasks register once, poll immediately, skip busy ticks and retain the start cadence', async () => {
  const clock = new TestClock()
  const requests: PluginUiTaskRequest[] = []
  let resolve: (value: unknown) => void = () => {}
  const controller = new PluginUiTaskController({
    clock,
    notice: () => {},
    rpc: (request) => {
      requests.push(request)
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  controller.observe(target, view())
  controller.observe(target, view())
  assert.equal(requests.length, 1)
  clock.advance(12_000)
  assert.equal(requests.length, 1)
  resolve({ state: 'pending' })
  await flush()
  clock.advance(2999)
  assert.equal(requests.length, 1)
  clock.advance(1)
  assert.equal(requests.length, 2)
  controller.dispose()
})

test('a shared task descriptor keeps its first Profile scope when another view observes it', () => {
  const requests: PluginUiTaskRequest[] = []
  const controller = new PluginUiTaskController({
    clock: new TestClock(),
    notice: () => {},
    rpc: (request) => {
      requests.push(request)
      return new Promise(() => {})
    },
  })
  controller.observe(target, view())
  const other = {
    ...target,
    profileId: 'another-profile',
    connectionId: 'another-connection',
  }
  controller.observe(other, view())
  assert.equal(requests.length, 1)
  controller.cancel(other, ['task'])
  assert.equal(requests.length, 2)
  assert.equal(requests[1]?.operation, 'cancel')
  assert.equal(requests[1]?.profileId, target.profileId)
  assert.equal(requests[1]?.connectionId, target.connectionId)
  controller.dispose()
})

test('deadline cancels once and suppresses a late success and replayed descriptor', async () => {
  const clock = new TestClock()
  const requests: PluginUiTaskRequest[] = []
  const notices: string[] = []
  let resolve: (value: unknown) => void = () => {}
  const controller = new PluginUiTaskController({
    clock,
    notice: (_, item) => notices.push(item.id),
    rpc: (request) => {
      requests.push(request)
      if (request.operation === 'cancel') return Promise.reject(new Error('already gone'))
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  controller.observe(target, view(6000))
  clock.advance(5000)
  resolve({ state: 'done', notices: [notice] })
  await flush()
  controller.observe(target, view(6000))
  assert.deepEqual(notices, ['timeout-task'])
  assert.equal(requests.filter((item) => item.operation === 'cancel').length, 1)
  controller.dispose()
})

test('response acceptance checks deadline before delivering any notices', async () => {
  const clock = new TestClock()
  const notices: string[] = []
  let resolve: (value: unknown) => void = () => {}
  const controller = new PluginUiTaskController({
    clock,
    notice: (_, item) => notices.push(item.id),
    rpc: (request) =>
      request.operation === 'cancel'
        ? Promise.resolve(null)
        : new Promise((done) => {
            resolve = done
          }),
  })
  controller.observe(target, view(6000))
  clock.time = 6000
  resolve({ state: 'done', notices: [notice] })
  await flush()
  assert.deepEqual(notices, ['timeout-task'])
  controller.dispose()
})

test('catalog replacement cancels old work and excludes late results', async () => {
  const clock = new TestClock()
  const notices: string[] = []
  const requests: PluginUiTaskRequest[] = []
  let resolve: (value: unknown) => void = () => {}
  const controller = new PluginUiTaskController({
    clock,
    notice: (_, item) => notices.push(item.id),
    rpc: (request) => {
      requests.push(request)
      return request.operation === 'cancel'
        ? Promise.resolve(null)
        : new Promise((done) => {
            resolve = done
          })
    },
  })
  controller.setCatalog([runtimePlugin])
  controller.observe(target, view())
  controller.setCatalog([{ ...runtimePlugin, runtimeGeneration: 'replacement' }])
  resolve({ state: 'done', notices: [notice] })
  await flush()
  clock.advance(30_000)
  assert.deepEqual(notices, [])
  assert.equal(requests.filter((item) => item.operation === 'cancel').length, 1)
  controller.dispose()
})

test('view and task notices are deduplicated while failed polls retry safely until deadline', async () => {
  const clock = new TestClock()
  const notices: string[] = []
  const errors: string[] = []
  let calls = 0
  const controller = new PluginUiTaskController({
    clock,
    notice: (_, item) => notices.push(item.id),
    error: (message) => errors.push(message),
    rpc: async () => {
      if (++calls === 1) throw new Error('sensitive failure details')
      return { state: 'done', notices: [notice, notice] }
    },
  })
  const withNotice = { ...view(), notices: [notice] }
  controller.observe(target, withNotice)
  controller.observe(target, withNotice)
  await flush()
  clock.advance(5000)
  await flush()
  assert.equal(calls, 2)
  assert.deepEqual(notices, ['result'])
  assert.deepEqual(errors, ['插件任务暂时无法读取，将继续等待至截止时间'])
  clock.advance(30_000)
  assert.deepEqual(notices, ['result'])
  controller.dispose()
})

test('task concurrency is bounded and disabled plugins cannot enqueue work', () => {
  const clock = new TestClock()
  const requests: PluginUiTaskRequest[] = []
  const controller = new PluginUiTaskController({
    clock,
    maxTasks: 1,
    notice: () => {},
    rpc: (request) => {
      requests.push(request)
      return new Promise(() => {})
    },
  })
  controller.observe(target, view())
  controller.observe(target, view(31_000, 'second'))
  assert.deepEqual(
    requests.map((item) => [item.taskId, item.operation]),
    [
      ['task', 'poll'],
      ['second', 'cancel'],
    ],
  )
  controller.setCatalog([{ ...runtimePlugin, enabled: false }])
  controller.observe(target, view(31_000, 'third'))
  assert.equal(requests.length, 3)
  controller.dispose()
})

test('registered tasks continue after their originating panel session closes', async () => {
  const clock = new TestClock()
  const notices: string[] = []
  let resolve: (value: unknown) => void = () => {}
  const controller = new PluginUiTaskController({
    clock,
    notice: (_, item) => notices.push(item.id),
    rpc: () =>
      new Promise((done) => {
        resolve = done
      }),
  })
  const session = new PluginUiSession(
    async () => ({ sessionId: 'session', view: view() }),
    controller.observe,
  )
  await session.open(target)
  session.close()
  resolve({ state: 'done', notices: [notice] })
  await flush()
  assert.deepEqual(notices, ['result'])
  assert.equal(session.snapshot().view, null)
  controller.dispose()
})

test('explicit cancellation suppresses deadline timeout and a late successful poll', async () => {
  const clock = new TestClock()
  const requests: PluginUiTaskRequest[] = []
  const notices: string[] = []
  let resolve: (value: unknown) => void = () => {}
  const controller = new PluginUiTaskController({
    clock,
    notice: (_, item) => notices.push(item.id),
    rpc: (request) => {
      requests.push(request)
      if (request.operation === 'cancel')
        return Promise.reject(new Error('already cancelled'))
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  controller.observe(target, view(6000))
  controller.cancel(target, ['task'])
  clock.advance(10_000)
  resolve({ state: 'done', notices: [notice] })
  await flush()
  controller.observe(target, view(20_000))
  assert.deepEqual(notices, [])
  assert.deepEqual(
    requests.map((request) => request.operation),
    ['poll', 'cancel'],
  )
  controller.dispose()
})

test('another Profile cancels a shared task using its original native scope', async () => {
  const clock = new TestClock()
  const requests: PluginUiTaskRequest[] = []
  const notices: string[] = []
  let resolve: (value: unknown) => void = () => {}
  const controller = new PluginUiTaskController({
    clock,
    notice: (_, item) => notices.push(item.id),
    rpc: (request) => {
      requests.push(request)
      if (request.operation === 'cancel') return Promise.resolve(null)
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  controller.observe(target, view(6000))
  const otherProfile = {
    ...target,
    profileId: 'other-profile',
    connectionId: 'other-connection',
  }
  controller.cancel(otherProfile, ['task', 'task'])
  assert.deepEqual(requests[1], { ...target, taskId: 'task', operation: 'cancel' })
  controller.observe(otherProfile, view(6000))
  clock.advance(10_000)
  resolve({ state: 'done', notices: [notice] })
  await flush()
  assert.equal(requests.length, 2)
  assert.deepEqual(notices, [])
  controller.dispose()
})

test('cancelled view tasks take precedence over descriptors in that and later snapshots', () => {
  const clock = new TestClock()
  const requests: PluginUiTaskRequest[] = []
  const controller = new PluginUiTaskController({
    clock,
    notice: () => {},
    rpc: async (request) => {
      requests.push(request)
      return { state: 'pending' }
    },
  })
  controller.observe(target, { ...view(), cancelledTasks: ['task'] })
  controller.observe(target, view())
  clock.advance(40_000)
  assert.deepEqual(requests, [])
  controller.dispose()
})

test('cancellation is isolated by plugin and process identity before task lookup', async () => {
  const clock = new TestClock()
  const requests: PluginUiTaskRequest[] = []
  const notices: string[] = []
  let resolve: (value: unknown) => void = () => {}
  const controller = new PluginUiTaskController({
    clock,
    notice: (_, item) => notices.push(item.id),
    rpc: (request) => {
      requests.push(request)
      if (request.operation === 'cancel') return Promise.resolve(null)
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  controller.setCatalog([runtimePlugin])
  controller.observe(target, view())
  controller.cancel({ ...target, pluginId: 'other.plugin' }, ['task'])
  controller.cancel({ ...target, identity: 'install:stale-process' }, ['task'])
  assert.equal(requests.length, 1)
  resolve({ state: 'done', notices: [notice] })
  await flush()
  assert.deepEqual(notices, ['result'])
  controller.dispose()
})
