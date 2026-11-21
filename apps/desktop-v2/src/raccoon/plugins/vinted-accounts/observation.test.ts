import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseObservation } from './observation.ts'

test('account observations preserve unknown balances and exact zero amounts', () => {
  assert.equal(parseObservation(undefined), undefined)
  const result = parseObservation({
    sessions: {},
    checks: {},
    wallet: {
      available: {
        amount: '0.0000',
        currency: 'USD',
        observedAt: '2026-11-19T00:00:00Z',
        source: 'official',
      },
      pending: null,
    },
    tags: ['trusted'],
    rating: 0,
    summary: '<script>text</script>',
  })
  assert.equal(result?.wallet?.available?.amount, '0.0000')
  assert.equal(result?.wallet?.pending, null)
  assert.equal(result?.rating, 0)
  assert.equal(result?.summary, '<script>text</script>')
})

test('observations reject unmasked bank numbers and invalid financial values', () => {
  assert.throws(() =>
    parseObservation({
      sessions: {},
      checks: {},
      wallet: {
        available: {
          amount: 'NaN',
          currency: 'USD',
          observedAt: '2026-11-19T00:00:00Z',
          source: 'official',
        },
        pending: null,
      },
    }),
  )
  assert.throws(() =>
    parseObservation({
      sessions: {},
      checks: {},
      bankAccounts: {
        records: [
          {
            id: '1',
            name: 'Example',
            account_number: '123456789012',
            routing_number: '123456789',
            spending_type: 'checking',
            user_id: '1',
            hide_name: false,
            is_default: true,
          },
        ],
        observedAt: '2026-11-19T00:00:00Z',
        source: 'official',
      },
    }),
  )
})
