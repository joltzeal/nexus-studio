import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OrderWatchSession, orderWatchHttpUrl } from './order-watch-session.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('monitor reads and mutations share one non-overlapping operation slot', async () => {
  const session = new OrderWatchSession(() => 'plugin-1/workspace-1')
  session.start()
  const reading = deferred()
  let calls = 0
  const first = session.run(async (current) => {
    calls++
    await reading.promise
    assert.equal(current(), true)
  })
  assert.equal(
    await session.run(async () => {
      calls++
    }),
    false,
  )
  assert.equal(calls, 1)
  reading.resolve()
  assert.equal(await first, true)
  assert.equal(
    await session.run(async () => {
      calls++
    }),
    true,
  )
  assert.equal(calls, 2)
})

test('Workspace and source-plugin changes invalidate delayed monitor results', async () => {
  for (const changed of ['plugin-1/workspace-2', 'plugin-2/workspace-1', null]) {
    let identity: string | null = 'plugin-1/workspace-1'
    const session = new OrderWatchSession(() => identity)
    session.start()
    const reading = deferred()
    let applied = false
    const first = session.run(async (current) => {
      await reading.promise
      if (current()) applied = true
    })
    identity = changed
    reading.resolve()
    await first
    assert.equal(applied, false)
  }
})

test('unmount and remount reject old work without releasing a new operation', async () => {
  const session = new OrderWatchSession(() => 'plugin-1/workspace-1')
  session.start()
  const oldRead = deferred()
  let oldCurrent = true
  const old = session.run(async (current) => {
    await oldRead.promise
    oldCurrent = current()
  })
  session.stop()
  assert.equal(await session.run(async () => assert.fail('unmounted RPC')), false)
  session.start()
  const newRead = deferred()
  const fresh = session.run(async (current) => {
    await newRead.promise
    assert.equal(current(), true)
  })
  oldRead.resolve()
  await old
  assert.equal(oldCurrent, false)
  assert.equal(await session.run(async () => assert.fail('overlapping RPC')), false)
  newRead.resolve()
  await fresh
})

test('unavailable monitor sessions cannot start requests or continue writes', async () => {
  let identity: string | null = null
  const session = new OrderWatchSession(() => identity)
  session.start()
  assert.equal(await session.run(async () => assert.fail('unavailable RPC')), false)
  identity = 'plugin-1/workspace-1'
  const write = deferred()
  let refreshed = false
  const pending = session.run(async (current) => {
    await write.promise
    if (current()) refreshed = true
  })
  session.stop()
  write.resolve()
  await pending
  assert.equal(refreshed, false)
})

test('monitor links only expose absolute HTTP URLs without embedded credentials', () => {
  assert.equal(
    orderWatchHttpUrl('https://www.vinted.com/items/123'),
    'https://www.vinted.com/items/123',
  )
  assert.equal(
    orderWatchHttpUrl('http://www.vinted.com/member/123'),
    'http://www.vinted.com/member/123',
  )
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,test',
    '/items/123',
    'https://user:secret@example.test',
    '',
  ])
    assert.equal(orderWatchHttpUrl(value), null)
})
