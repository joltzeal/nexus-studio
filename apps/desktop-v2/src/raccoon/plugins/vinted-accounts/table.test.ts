import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Account } from './model.ts'
import {
  EMPTY_ACCOUNT_FILTERS,
  filterAccounts,
  formatAccountCreatedAt,
  indexAccountProfiles,
  paginateAccounts,
  retainAccountSelection,
} from './table.ts'

test('formats an absolute date and relative age, including older accounts', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  assert.match(formatAccountCreatedAt('2026-11-20T10:00:00Z', now).absolute, /2026/)
  assert.equal(formatAccountCreatedAt('2026-11-20T10:00:00Z', now).relative, '2小时前')
  assert.equal(formatAccountCreatedAt('2026-10-20T12:00:00Z', now).relative, '31天前')
  assert.deepEqual(formatAccountCreatedAt('invalid', now), {
    absolute: '—',
    relative: '',
  })
})

test('projects Profile names by UUID and retains relationships with unreadable Profiles', () => {
  const result = indexAccountProfiles(
    [
      { accountId: 'one', windowId: 'profile-a' },
      { accountId: 'one', windowId: 'profile-b' },
      { accountId: 'two', windowId: 'unknown' },
    ],
    [{ id: 'profile-b', name: 'Shop B', connectionId: 'workspace-b' }],
  )
  assert.deepEqual(result.get('one'), [
    { id: 'profile-a', name: null, connectionId: null },
    { id: 'profile-b', name: 'Shop B', connectionId: 'workspace-b' },
  ])
  assert.deepEqual(result.get('two'), [{ id: 'unknown', name: null, connectionId: null }])
})

const account = (id: string, patch: Partial<Account> = {}): Account => ({
  id,
  account: `${id}@example.test`,
  password: '',
  loginMethod: 'email',
  phone: '',
  emailOtpUrl: '',
  smsOtpUrl: '',
  status: 'active',
  note: '',
  homepageUrl: '',
  mailbox: null,
  address: null,
  createdAt: '2026-11-19T00:00:00Z',
  updatedAt: '2026-11-19T00:00:00Z',
  ...patch,
})

test('combines all v1 filters and includes account bindings from other Workspaces', () => {
  const rows = [
    account('match', {
      loginMethod: 'google',
      phone: '123',
      note: 'Blue',
      status: 'pending',
    }),
    account('no-phone', { loginMethod: 'google', note: 'blue', status: 'pending' }),
    account('no-binding', {
      loginMethod: 'google',
      phone: '456',
      note: 'blue',
      status: 'pending',
    }),
    account('wrong-login', { phone: '123', note: 'blue', status: 'pending' }),
    account('wrong-status', { loginMethod: 'google', phone: '123', note: 'blue' }),
  ]
  const bindings = rows
    .filter((row) => row.id !== 'no-binding')
    .map((row) => ({
      accountId: row.id,
      windowId: `other-workspace-${row.id}`,
    }))
  const result = filterAccounts(rows, bindings, {
    query: ' BLUE ',
    status: 'pending',
    loginMethod: 'google',
    phone: 'with',
    binding: 'bound',
  })
  assert.deepEqual(
    result.map((row) => row.id),
    ['match'],
  )
  assert.deepEqual(
    filterAccounts(rows, bindings, {
      ...EMPTY_ACCOUNT_FILTERS,
      binding: 'unbound',
    }).map((row) => row.id),
    ['no-binding'],
  )
  assert.deepEqual(
    filterAccounts(rows, bindings, {
      ...EMPTY_ACCOUNT_FILTERS,
      phone: 'without',
    }).map((row) => row.id),
    ['no-phone'],
  )
})

test('searches associated email and sorts newest first with stable ties and invalid dates last', () => {
  const rows = [
    account('invalid', { createdAt: 'invalid' }),
    account('older', { createdAt: '2026-11-18T00:00:00Z' }),
    account('first'),
    account('second'),
  ]
  assert.deepEqual(
    filterAccounts(rows, [], EMPTY_ACCOUNT_FILTERS).map((row) => row.id),
    ['first', 'second', 'older', 'invalid'],
  )
  const linked = account('linked', {
    mailbox: {
      pluginId: 'studio.email',
      mailboxId: 'mailbox',
      email: 'Linked@Example.test',
      linkedAt: rows[0]!.createdAt,
    },
  })
  assert.deepEqual(
    filterAccounts([linked], [], {
      ...EMPTY_ACCOUNT_FILTERS,
      query: ' linked@example.test ',
    }),
    [linked],
  )
  assert.equal(rows[0]?.id, 'invalid')
})

test('paginates 20, 50 and 100 rows while clamping stale or invalid page numbers', () => {
  const rows = Array.from({ length: 51 }, (_, index) => account(String(index)))
  assert.equal(paginateAccounts(rows, 2, 20).items[0]?.id, '20')
  assert.equal(paginateAccounts(rows, 2, 50).items.length, 1)
  assert.equal(paginateAccounts(rows, 9, 100).page, 1)
  assert.equal(paginateAccounts(rows, Number.NaN, 20).page, 1)
  assert.deepEqual(paginateAccounts([], 3, 20), {
    page: 1,
    pageCount: 1,
    total: 0,
    items: [],
  })
})

test('retains selections across filters and pagination while removing deleted and completed accounts', () => {
  const rows = [account('one'), account('two'), account('three')]
  const selected = new Set(['one', 'two', 'deleted'])
  assert.deepEqual([...retainAccountSelection(selected, rows)], ['one', 'two'])
  assert.deepEqual([...retainAccountSelection(selected, rows, ['one'])], ['two'])
  assert.deepEqual([...selected], ['one', 'two', 'deleted'])
})
