import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMailboxRelations, duplicateAccountIds } from './mailbox-relations.ts'

const target = {
  id: 'a1',
  account: 'seller',
  status: 'active' as const,
  mailbox: {
    pluginId: 'studio.email' as const,
    mailboxId: 'old',
    email: 'old@example.test',
    linkedAt: '2026-01-01T00:00:00Z',
  },
}
const mailbox = { id: 'm1', email: 'seller@example.test', enabled: true }

test('changed or disabled source mailbox blocks linking and importing', async () => {
  let writes = 0
  for (const current of [
    { ...mailbox, email: 'changed@example.test' },
    { ...mailbox, enabled: false },
  ]) {
    const relations = createMailboxRelations(
      {
        assignMailbox: async () => {
          writes++
        },
        importMailboxes: async () => {
          writes++
        },
      },
      { getMailbox: async () => current },
    )
    await assert.rejects(relations.link(target, mailbox), /邮箱/)
    await assert.rejects(
      relations.import({
        mailboxes: [{ mailboxId: mailbox.id, email: mailbox.email }],
        expectedDuplicateIds: [],
        loginMethod: 'email',
        status: 'pending',
        phone: '',
        emailOtpUrl: '',
        smsOtpUrl: '',
        homepageUrl: '',
        note: '',
      }),
      /邮箱/,
    )
  }
  assert.equal(writes, 0)
})

test('unlink works without email plugin and uses the displayed expected relation', async () => {
  const writes: unknown[] = []
  const relations = createMailboxRelations(
    {
      assignMailbox: async (...args) => {
        writes.push(args)
      },
      importMailboxes: async () => {},
    },
    {
      getMailbox: async () => {
        throw new Error('email offline')
      },
    },
  )
  await relations.link(target, null)
  assert.deepEqual(writes, [['a1', null, 'old']])
})

test('failed association is propagated and never reported as saved', async () => {
  const relations = createMailboxRelations(
    {
      assignMailbox: async () => {
        throw new Error('write failed')
      },
      importMailboxes: async () => {},
    },
    { getMailbox: async () => mailbox },
  )
  await assert.rejects(relations.link(target, mailbox), /write failed/)
})

test('duplicate preview includes every account with a normalized matching email', () => {
  const ids = duplicateAccountIds(
    [{ mailboxId: 'm1', email: 'SELLER@example.test' }],
    [
      { id: 'first', account: 'seller@example.test' },
      { id: 'last', account: 'Seller@example.test' },
    ],
  )
  assert.deepEqual(ids, ['first', 'last'])
})

test('duplicate preview matches linked mailbox UUID and linked normalized address', () => {
  assert.deepEqual(
    duplicateAccountIds(
      [{ mailboxId: 'm1', email: 'SELLER@example.test' }],
      [
        {
          id: 'a1',
          account: 'other',
          mailbox: { mailboxId: 'm1', email: 'old@example.test' },
        },
        {
          id: 'a2',
          account: 'another',
          mailbox: { mailboxId: 'm2', email: ' seller@example.test ' },
        },
      ],
    ),
    ['a1', 'a2'],
  )
})

test('closing during source verification prevents a subsequent relation write', async () => {
  let live = true
  let writes = 0
  const relations = createMailboxRelations(
    {
      assignMailbox: async () => {
        writes++
      },
      importMailboxes: async () => {
        writes++
      },
    },
    {
      getMailbox: async () => {
        live = false
        return mailbox
      },
    },
  )
  await assert.rejects(
    relations.link(target, mailbox, () => live),
    /关闭|切换/,
  )
  live = true
  await assert.rejects(
    relations.import(
      {
        mailboxes: [{ mailboxId: mailbox.id, email: mailbox.email }],
        expectedDuplicateIds: [],
        loginMethod: 'email',
        status: 'pending',
        phone: '',
        emailOtpUrl: '',
        smsOtpUrl: '',
        homepageUrl: '',
        note: '',
      },
      () => live,
    ),
    /关闭|切换/,
  )
  assert.equal(writes, 0)
})
