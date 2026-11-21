import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startAuthorizationSession } from './authorization-session.ts'

const challenge = {
  authorizationId: 'challenge',
  userCode: 'CODE',
  verificationUri: 'https://microsoft.com/devicelogin',
  expiresAt: '2099-01-01T00:00:00Z',
  intervalSeconds: 5,
}
const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

test('closing during authorization start cancels the late challenge', async () => {
  let resolve!: (value: typeof challenge) => void
  const cancelled: string[] = []
  let delivered = false
  const stop = startAuthorizationSession(
    {
      startAuthorization: () =>
        new Promise((done) => {
          resolve = done
        }),
      pollAuthorization: async () => ({ status: 'expired' as const }),
      cancelAuthorization: async (id) => {
        cancelled.push(id)
      },
    },
    { id: 'm', email: 'm@example.test' },
    {
      challenge: () => {
        delivered = true
      },
      state: () => {},
      error: () => {},
    },
  )
  stop()
  resolve(challenge)
  await flush()
  assert.deepEqual(cancelled, ['challenge'])
  assert.equal(delivered, false)
})

test('authorization polling honors plugin retry delay and stops on terminal state', async () => {
  const scheduled: { run: () => void; delay: number }[] = []
  const states: string[] = []
  let polls = 0
  const stop = startAuthorizationSession(
    {
      startAuthorization: async () => challenge,
      pollAuthorization: async () =>
        ++polls === 1
          ? { status: 'pending' as const, retryAfterSeconds: 12 }
          : { status: 'denied' as const },
      cancelAuthorization: async () => {},
    },
    { id: 'm', email: 'm@example.test' },
    {
      challenge: () => {},
      state: (state) => {
        states.push(state.status)
      },
      error: () => {},
    },
    (run, delay) => {
      scheduled.push({ run, delay })
      return () => {}
    },
  )
  await flush()
  assert.equal(scheduled[0]?.delay, 5000)
  scheduled.shift()!.run()
  await flush()
  assert.equal(scheduled[0]?.delay, 12000)
  scheduled.shift()!.run()
  await flush()
  assert.deepEqual(states, ['pending', 'denied'])
  assert.equal(scheduled.length, 0)
  stop()
})
