import { describe, expect, it } from 'vitest'
import type {
  AccountAgentSnapshotInput,
  AccountAgentSnapshotResult,
  AccountObservationInput,
  AccountObservationResult,
} from '@nexus/plugin-vinted-accounts/agent-contracts'

import {
  AccountAgentSnapshotInputSchema,
  AccountAgentSnapshotResultSchema,
  AccountObservationInputSchema,
  AccountObservationResultSchema,
} from './agent-contracts.js'

const windowId = '22222222-2222-4222-8222-222222222222'
const accountId = '11111111-1111-4111-8111-111111111111'
const input: AccountObservationInput = {
  operationId: '33333333-3333-4333-8333-333333333333',
  accountId,
  windowId,
  observedAt: '2026-11-13T08:00:00.000Z',
  source: 'official',
}
const snapshotInput: AccountAgentSnapshotInput = { windowId }
const snapshot: AccountAgentSnapshotResult = {
  account: {
    accountId,
    account: 'seller@example.test',
    status: 'active',
    homepageUrl: 'https://www.vinted.fr/member/123-seller',
    platformUserId: '123',
    observation: null,
  },
  windowId,
}
const receipt: AccountObservationResult = {
  operationId: input.operationId,
  accountId,
  applied: true,
  storageDurable: true,
}

describe('public account Agent contracts', () => {
  it('validates the coordinator snapshot and observation receipt using public types', () => {
    expect(AccountObservationInputSchema.parse(input)).toEqual(input)
    expect(AccountAgentSnapshotInputSchema.parse(snapshotInput)).toEqual(snapshotInput)
    expect(AccountAgentSnapshotResultSchema.parse(snapshot)).toEqual(snapshot)
    expect(AccountObservationResultSchema.parse(receipt)).toEqual(receipt)
  })

  it.each(['password', 'mailbox', 'emailOtpUrl', 'smsOtpUrl', 'phone', 'note'])(
    'rejects %s in the snapshot projection',
    (field) => {
      expect(
        AccountAgentSnapshotResultSchema.safeParse({
          ...snapshot,
          account: { ...snapshot.account, [field]: 'synthetic' },
        }).success,
      ).toBe(false)
    },
  )

  it.each([
    { windowId, account: null },
    { ...snapshot, storageDurable: true },
    { ...snapshot, account: { ...snapshot.account, accountId: 'not-a-uuid' } },
    { ...snapshot, account: { ...snapshot.account, platformUserId: 'seller' } },
    { windowId, accountId },
  ])('rejects a differing coordinator response shape %j', (value) => {
    expect(AccountAgentSnapshotResultSchema.safeParse(value).success).toBe(false)
  })

  it.each([null, {}, { windowId: 'window-1' }, { windowId, accountId }])(
    'rejects invalid or broader snapshot input %j',
    (value) => {
      expect(AccountAgentSnapshotInputSchema.safeParse(value).success).toBe(false)
    },
  )
})
