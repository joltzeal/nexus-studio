import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PluginUiProfileStatusController,
  type PluginUiProfilesRequest,
} from './ui-profile-status.ts'
import { TestClock, flush, runtimePlugin } from './ui-runtime.test-support.ts'

const target = {
  pluginId: 'example.plugin',
  viewId: 'profile',
  connectionId: 'connection',
  identity: 'install:process',
}
const profileId = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const status = (id: string) => ({
  profileId: id,
  tone: 'success',
  label: 'Plugin status',
})

test('a navigation icon never authorizes Profile status calls', async () => {
  const clock = new TestClock()
  let calls = 0
  const controller = new PluginUiProfileStatusController({
    clock,
    rpc: async () => {
      calls++
      return { items: [] }
    },
  })
  controller.setCatalog([
    {
      ...runtimePlugin,
      ui: {
        protocolVersion: 1,
        services: [],
        navigation: { icon: { viewBox: '0 0 24 24', paths: ['M1 2h3z'] } },
      },
    },
  ])
  const stop = controller.watch(target, profileId(1))
  clock.advance(5000)
  await flush()
  assert.equal(calls, 0)
  assert.equal(controller.snapshot(target, profileId(1)), null)
  stop()
  controller.dispose()
})

test('visible subscriptions batch into requests of at most 200 with shared duplicate Profiles', async () => {
  const clock = new TestClock()
  const requests: PluginUiProfilesRequest[] = []
  const controller = new PluginUiProfileStatusController({
    clock,
    rpc: async (input) => {
      requests.push(input)
      return { items: input.profileIds.map(status) }
    },
  })
  controller.setCatalog([runtimePlugin])
  const stop = Array.from({ length: 201 }, (_, i) =>
    controller.watch(target, profileId(i)),
  )
  stop.push(controller.watch(target, profileId(0)))
  assert.equal(requests.length, 0)
  clock.advance(0)
  await flush()
  assert.deepEqual(
    requests.map((request) => request.profileIds.length),
    [200, 1],
  )
  assert.equal(controller.snapshot(target, profileId(0))?.label, 'Plugin status')
  for (const unwatch of stop) unwatch()
  assert.equal(controller.snapshot(target, profileId(0)), null)
  clock.advance(5000)
  assert.equal(requests.length, 2)
  controller.dispose()
})

test('polling never overlaps and ignores results for unsubscribed scopes', async () => {
  const clock = new TestClock()
  let calls = 0
  let resolve: (value: unknown) => void = () => {}
  const controller = new PluginUiProfileStatusController({
    clock,
    rpc: () => {
      calls++
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  controller.setCatalog([runtimePlugin])
  const stop = controller.watch(target, profileId(1))
  clock.advance(0)
  clock.advance(20_000)
  assert.equal(calls, 1)
  stop()
  resolve({ items: [status(profileId(1))] })
  await flush()
  assert.equal(controller.snapshot(target, profileId(1)), null)
  controller.dispose()
})

test('rapid unsubscribe and resubscribe retains the in-flight request lock', async () => {
  const clock = new TestClock()
  const requests: PluginUiProfilesRequest[] = []
  const pending: ((value: unknown) => void)[] = []
  const controller = new PluginUiProfileStatusController({
    clock,
    rpc: (input) => {
      requests.push(input)
      return new Promise((resolve) => pending.push(resolve))
    },
  })
  controller.setCatalog([runtimePlugin])
  const stop = controller.watch(target, profileId(1))
  clock.advance(0)
  stop()
  controller.watch(target, profileId(2))
  clock.advance(0)
  assert.equal(requests.length, 1)
  pending[0]!({ items: [status(profileId(1))] })
  await flush()
  assert.equal(controller.snapshot(target, profileId(1)), null)
  clock.advance(0)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1]?.profileIds, [profileId(2)])
  pending[1]!({ items: [status(profileId(2))] })
  await flush()
  assert.equal(controller.snapshot(target, profileId(2))?.tone, 'success')
  controller.dispose()
})

test('catalog failures and invalid responses clear tones and unsupported methods never poll', async () => {
  const clock = new TestClock()
  let calls = 0
  const controller = new PluginUiProfileStatusController({
    clock,
    rpc: async () => {
      calls++
      return { items: [status(profileId(calls === 1 ? 1 : 99))] }
    },
  })
  controller.setCatalog([{ ...runtimePlugin, methods: [] }])
  controller.watch(target, profileId(1))
  clock.advance(5000)
  assert.equal(calls, 0)
  controller.setCatalog([runtimePlugin])
  clock.advance(0)
  await flush()
  assert.equal(controller.snapshot(target, profileId(1))?.tone, 'success')
  clock.advance(5000)
  await flush()
  assert.equal(controller.snapshot(target, profileId(1)), null)
  controller.setCatalog([runtimePlugin], false)
  clock.advance(10_000)
  assert.equal(calls, 2)
  controller.dispose()
})

test('installation replacement invalidates old responses and connection data remains isolated', async () => {
  const clock = new TestClock()
  const pending: ((value: unknown) => void)[] = []
  const controller = new PluginUiProfileStatusController({
    clock,
    rpc: () => new Promise((resolve) => pending.push(resolve)),
  })
  controller.setCatalog([runtimePlugin])
  controller.watch(target, profileId(1))
  controller.watch({ ...target, connectionId: 'other' }, profileId(2))
  clock.advance(0)
  assert.equal(pending.length, 2)
  controller.setCatalog([{ ...runtimePlugin, installation: 'new' }])
  pending[0]!({ items: [status(profileId(1))] })
  pending[1]!({ items: [status(profileId(2))] })
  await flush()
  assert.equal(controller.snapshot(target, profileId(1)), null)
  assert.equal(
    controller.snapshot({ ...target, connectionId: 'other' }, profileId(2)),
    null,
  )
  controller.dispose()
})
