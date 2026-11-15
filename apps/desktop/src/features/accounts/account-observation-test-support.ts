import type { AccountObservationState } from '@nexus/plugin-contracts/vinted-accounts'
import { EMPTY_ACCOUNT, type Account } from './types'

export const observationTime = '2026-11-13T06:00:00.000Z'
export const balanceTime = '2026-11-12T05:00:00.000Z'

export function accountObservation(): AccountObservationState {
  return {
    platformUserId: '123456',
    tags: ['已验证', '活跃卖家'],
    summary: '近期有成交，资料完整。',
    rating: 4.8,
    wallet: {
      available: {
        amount: '123456789012.3400',
        currency: 'EUR',
        source: 'official',
        observedAt: balanceTime,
      },
      pending: {
        amount: '0.00',
        currency: 'GBP',
        source: 'page',
        observedAt: observationTime,
      },
    },
    sessions: {},
    checks: {
      'wallet.available': {
        operationId: '7da0fe99-eb0b-4c31-a975-13d69f456057',
        sequence: 1,
        source: 'official',
        observedAt: observationTime,
        outcome: 'failed',
        code: 'unreadable',
      },
    },
    statusEvidence: {
      status: 'active',
      source: 'official',
      observedAt: balanceTime,
      reason: 'legacy_status',
    },
  }
}

export function observedAccount(overrides: Partial<Account> = {}): Account {
  return {
    ...EMPTY_ACCOUNT,
    id: 'ad203e79-9430-4867-b858-b15f7bba4ea5',
    account: 'seller@example.test',
    password: ' synthetic password ',
    phone: '+33123456789',
    emailOtpUrl: 'https://example.test/mail',
    smsOtpUrl: 'https://example.test/sms',
    note: '用户备注保留',
    homepageUrl: 'https://www.vinted.fr/member/123456',
    address: {
      id: 'address-1',
      street: 'Rue Exemple',
      houseNumber: '12',
      city: 'Paris',
      postalCode: '75001',
      countryCode: 'FR',
      state: null,
      county: null,
      latitude: 48.8566,
      longitude: 2.3522,
      source: 'osm',
      sourceUrl: 'https://www.openstreetmap.org/node/123',
      approximate: false,
      firstName: 'Marie',
      lastName: 'Exemple',
      username: 'marie.exemple',
      linkedAt: balanceTime,
    },
    mailbox: {
      pluginId: 'studio.email',
      mailboxId: 'mailbox-1',
      email: 'mail@example.test',
      linkedAt: balanceTime,
    },
    observation: accountObservation(),
    createdAt: balanceTime,
    updatedAt: observationTime,
    ...overrides,
  }
}
