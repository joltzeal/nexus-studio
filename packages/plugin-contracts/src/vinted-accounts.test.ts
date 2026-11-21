import { describe, expect, it } from 'vitest'
import {
  AccountAgentSnapshotResultSchema,
  AccountBankRecordSchema,
  AccountCurrentInputSchema,
  AccountObservationInputSchema,
  AccountObservationReserveInputSchema,
  AccountObservationStateSchema,
} from './vinted-accounts'

const now = '2026-11-14T00:00:00.000Z'
const context = {
  operationId: '1198ca69-4f78-4705-ac59-2d48bc790194',
  accountId: '2198ca69-4f78-4705-ac59-2d48bc790194',
  windowId: '3198ca69-4f78-4705-ac59-2d48bc790194',
  bindingRevision: '4198ca69-4f78-4705-ac59-2d48bc790194',
}
const bank = {
  id: '9',
  name: 'Synthetic fixture',
  account_number: '****1234',
  routing_number: '001234567',
  spending_type: 'unknown_platform_type',
  user_id: '123',
  hide_name: true,
  is_default: false,
}

describe('standalone account observation DTO contracts', () => {
  it('accepts unknown account snapshots while requiring explicit status evidence', () => {
    const snapshot = {
      windowId: context.windowId,
      bindingRevision: context.bindingRevision,
      session: null,
      account: {
        accountId: context.accountId,
        account: 'fixture@example.invalid',
        status: 'unknown',
        homepageUrl: '',
        platformUserId: null,
        observation: null,
      },
    }
    expect(AccountAgentSnapshotResultSchema.parse(snapshot).account.status).toBe(
      'unknown',
    )
    expect(
      AccountObservationStateSchema.safeParse({
        sessions: {},
        checks: {},
        statusEvidence: {
          status: 'unknown',
          source: 'official',
          observedAt: now,
          reason: 'legacy_status',
        },
      }).success,
    ).toBe(false)
    expect(
      AccountObservationStateSchema.safeParse({
        sessions: {},
        checks: {},
        statusEvidence: {
          status: 'blocked',
          source: 'official',
          observedAt: now,
          reason: 'current_account_banned',
        },
      }).success,
    ).toBe(true)
  })

  it('preserves independent money precision, currency, time and zero', () => {
    const state = AccountObservationStateSchema.parse({
      wallet: {
        available: {
          amount: '123456789012.3400',
          currency: 'USD',
          observedAt: now,
          source: 'official',
        },
        pending: {
          amount: '0.0',
          currency: 'EUR',
          observedAt: '2026-11-13T00:00:00.000Z',
          source: 'page',
        },
      },
      sessions: {},
      checks: {},
    })
    expect(state.wallet?.available?.amount).toBe('123456789012.3400')
    expect(state.wallet?.available?.currency).toBe('USD')
    expect(state.wallet?.pending).toEqual({
      amount: '0.0',
      currency: 'EUR',
      observedAt: '2026-11-13T00:00:00.000Z',
      source: 'page',
    })
  })

  it('preserves bank masks and leading zeros while rejecting unmasked numbers', () => {
    expect(AccountBankRecordSchema.parse(bank)).toEqual(bank)
    expect(
      AccountBankRecordSchema.safeParse({ ...bank, account_number: '1234567890' })
        .success,
    ).toBe(false)
    expect(
      AccountBankRecordSchema.safeParse({ ...bank, routing_number: 1234567 }).success,
    ).toBe(false)
  })

  it('requires a unique bounded reservation scope and exact binding identity', () => {
    const request = { ...context, domains: ['identity', 'session'] }
    expect(AccountObservationReserveInputSchema.parse(request)).toEqual(request)
    expect(
      AccountObservationReserveInputSchema.safeParse({
        ...context,
        domains: ['session', 'session'],
      }).success,
    ).toBe(false)
    expect(
      AccountObservationReserveInputSchema.safeParse({
        ...request,
        bindingRevision: '',
      }).success,
    ).toBe(false)
  })

  it('accepts only normalized current evidence and exact logout codes', () => {
    const loggedOut = {
      status: 'logged_out',
      reason: 'current_access_denied',
      httpStatus: 401,
      code: 106,
      messageCode: 'access_denied',
    }
    expect(AccountCurrentInputSchema.parse(loggedOut)).toEqual(loggedOut)
    expect(
      AccountCurrentInputSchema.safeParse({ ...loggedOut, code: '106' }).success,
    ).toBe(false)
    expect(
      AccountCurrentInputSchema.safeParse({
        status: 'authenticated',
        reason: 'current_user',
        platformUserId: '123',
        isAccountBanned: 'true',
      }).success,
    ).toBe(false)
  })

  it('distinguishes complete empty bank observations from null or duplicate records', () => {
    const request = {
      ...context,
      sequence: 1,
      observedAt: now,
      source: 'official',
      bankAccounts: {
        beforePlatformUserId: '123',
        afterPlatformUserId: '123',
        records: [],
      },
    }
    expect(AccountObservationInputSchema.parse(request).bankAccounts?.records).toEqual([])
    expect(
      AccountObservationInputSchema.safeParse({ ...request, bankAccounts: null }).success,
    ).toBe(false)
    expect(
      AccountObservationInputSchema.safeParse({
        ...request,
        bankAccounts: { ...request.bankAccounts, records: [bank, bank] },
      }).success,
    ).toBe(false)
    expect(
      AccountObservationInputSchema.safeParse({ ...request, source: 'model' }).success,
    ).toBe(false)
  })

  it('keeps financial values, credentials and implementation data out of agent snapshots', () => {
    const snapshot = {
      windowId: context.windowId,
      bindingRevision: context.bindingRevision,
      session: null,
      account: {
        accountId: context.accountId,
        account: 'fixture@example.invalid',
        status: 'blocked',
        homepageUrl: 'https://www.vinted.com/member/123',
        platformUserId: '123',
        observation: { platformUserId: '123', summary: 'Known fixture' },
      },
    }
    expect(AccountAgentSnapshotResultSchema.parse(snapshot)).toEqual(snapshot)
    for (const field of ['wallet', 'bankAccounts', 'password', 'sessionCookie']) {
      expect(
        AccountAgentSnapshotResultSchema.safeParse({
          ...snapshot,
          account: {
            ...snapshot.account,
            observation: { ...snapshot.account.observation, [field]: {} },
          },
        }).success,
      ).toBe(false)
    }
    expect(
      AccountObservationStateSchema.safeParse({ sessions: {}, checks: {}, secret: 'x' })
        .success,
    ).toBe(false)
  })
})
