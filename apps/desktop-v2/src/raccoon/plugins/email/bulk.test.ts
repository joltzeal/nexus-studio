import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mailboxImportInput,
  readMailboxImportFile,
  readMailboxImportPreview,
  validateMailboxSelection,
} from './bulk.ts'

const mailbox = { id: 'm1', email: 'seller@example.test', enabled: true }
const fields = {
  loginMethod: 'email' as const,
  status: 'pending' as const,
  note: '  imported  ',
}

test('selection rejects empty, oversized, duplicate UUID/email, paused and too-long emails', () => {
  for (const items of [
    [],
    Array.from({ length: 101 }, (_, index) => ({
      ...mailbox,
      id: `${index}`,
      email: `${index}@example.test`,
    })),
    [mailbox, mailbox],
    [mailbox, { ...mailbox, id: 'm2', email: 'SELLER@example.test' }],
    [{ ...mailbox, enabled: false }],
    [{ ...mailbox, email: `${'a'.repeat(190)}@example.test` }],
  ])
    assert.throws(() => validateMailboxSelection(items))
})

test('account bridge contains only mailbox identities and declared account fields', () => {
  const result = mailboxImportInput(
    [
      {
        ...mailbox,
        password: 'synthetic-secret',
        refreshToken: 'synthetic-token',
        clientId: 'client',
      } as typeof mailbox,
    ],
    fields,
    ['a1'],
  )
  assert.deepEqual(result.mailboxes, [{ mailboxId: mailbox.id, email: mailbox.email }])
  assert.equal(result.note, 'imported')
  assert.doesNotMatch(JSON.stringify(result), /synthetic|clientId|refreshToken|password/)
})

test('duplicate preview counts skipped mailboxes independently of matching account count', async () => {
  const result = await readMailboxImportPreview([mailbox], async () => ({
    total: 2,
    items: [
      { id: 'a1', account: mailbox.email, status: 'active', mailbox: null },
      {
        id: 'a2',
        account: 'seller',
        status: 'active',
        mailbox: {
          pluginId: 'studio.email',
          mailboxId: mailbox.id,
          email: mailbox.email,
          linkedAt: '2026-11-19T00:00:00Z',
        },
      },
    ],
  }))
  assert.equal(result.skipped, 1)
  assert.deepEqual(result.expectedDuplicateIds, ['a1', 'a2'])
})

test('pagination changes and a closed source scope stop duplicate review', async () => {
  const account = {
    id: 'a1',
    account: 'seller',
    status: 'active' as const,
    mailbox: null,
  }
  await assert.rejects(
    readMailboxImportPreview([mailbox], async () => ({ total: 2, items: [account] })),
    /分页/,
  )
  let calls = 0
  await assert.rejects(
    readMailboxImportPreview(
      [mailbox],
      async () => {
        calls++
        return { total: 0, items: [] }
      },
      () => false,
    ),
    /页面/,
  )
  assert.equal(calls, 0)
})

test('file import preserves credentials as text while checking UTF-8 TXT and size', async () => {
  const text = '\uFEFFseller@example.test----synthetic----client----token\n'
  assert.equal(
    await readMailboxImportFile({
      name: 'mailboxes.txt',
      size: text.length,
      text: async () => text,
    }),
    text.slice(1),
  )
  for (const file of [
    { name: 'mailboxes.xlsx', size: 10, text: async () => '' },
    { name: 'mailboxes.txt', size: 512 * 1024 + 1, text: async () => '' },
    { name: 'mailboxes.txt', size: 3, text: async () => '\uFFFD' },
  ])
    await assert.rejects(readMailboxImportFile(file))
})
