import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PluginCallError } from '../call.ts'
import { createAccountsApi } from './api.ts'
import { supportsAccountBase, supportsAccountOptional } from './api.ts'
import {
  ACCOUNT_METHOD_GROUPS,
  ACCOUNT_STATUS_LABELS,
  DEFAULT_ACCOUNT_STATUS,
} from './model.ts'
import {
  parseAccount,
  parseAccountMailboxTarget,
  parseAccountAddressTarget,
  parseMailboxTarget,
} from './parse.ts'

const account = {
  id: 'account-1',
  loginMethod: 'email',
  account: 'seller@example.test',
  password: 'secret',
  phone: '',
  emailOtpUrl: '',
  smsOtpUrl: '',
  note: '',
  status: 'active',
  homepageUrl: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  mailbox: null,
  address: null,
}
const pageTooLarge = '账号列表单页数据过大，超过消息大小上限，请减少每页账号数后重试。'

test('new-account defaults and account relationship parsers preserve unknown', () => {
  assert.equal(DEFAULT_ACCOUNT_STATUS, 'unknown')
  assert.equal(ACCOUNT_STATUS_LABELS.unknown, '未知')
  assert.equal(parseAccount({ ...account, status: 'unknown' }).status, 'unknown')
  assert.equal(
    parseAccountMailboxTarget({
      id: account.id,
      account: account.account,
      status: 'unknown',
      mailbox: null,
    }).status,
    'unknown',
  )
  assert.equal(
    parseAccountAddressTarget({
      id: account.id,
      account: account.account,
      status: 'unknown',
      address: null,
    }).status,
    'unknown',
  )
  assert.throws(() => parseAccount({ ...account, status: 'unrecognized' }))
})

test('aggregates revision-consistent account pages and validates page totals', async () => {
  const calls: { method: string; payload: unknown; id: string; capability: string }[] = []
  const pageItems = Array.from({ length: 16 }, (_, index) => ({
    ...account,
    id: `account-${index}`,
  }))
  const api = createAccountsApi(
    async (id, capability, method, payload, parse) => {
      calls.push({ id, capability, method, payload })
      const page = (payload as { page: number }).page
      return parse({
        items: page === 1 ? pageItems : [{ ...account, id: 'account-16' }],
        total: 17,
        bindings: [],
        storageDurable: true,
        page,
        pageSize: 16,
        revision: 'same',
      })
    },
    () => null,
  )
  const result = await api.listAccounts()
  assert.equal(result.items.length, 17)
  assert.deepEqual(
    calls.map((call) => [call.id, call.capability, call.method]),
    [
      ['studio.vinted-accounts', 'account.pool', 'vinted.accounts.list'],
      ['studio.vinted-accounts', 'account.pool', 'vinted.accounts.list'],
    ],
  )
  assert.equal((calls[0]?.payload as { revision?: string }).revision, undefined)
})

test('shrinks oversized account pages to one and aggregates every account and binding', async () => {
  const calls: { page: number; pageSize: number; revision?: string }[] = []
  const items = Array.from({ length: 3 }, (_, index) => ({
    ...account,
    id: `account-${index}`,
  }))
  const bindings = items.map((item, index) => ({
    windowId: `profile-${index}`,
    accountId: item.id,
    boundAt: account.createdAt,
    revision: `binding-${index}`,
  }))
  const api = createAccountsApi(async (_id, _cap, _method, payload, parse) => {
    const input = payload as (typeof calls)[number]
    calls.push(input)
    if (input.pageSize > 1) throw new PluginCallError('UNAVAILABLE', pageTooLarge, true)
    return parse({
      items: [items[input.page - 1]],
      bindings: [bindings[input.page - 1]],
      total: items.length,
      page: input.page,
      pageSize: input.pageSize,
      revision: 'complete',
      storageDurable: true,
    })
  })
  assert.deepEqual(await api.listAccounts(), {
    items,
    bindings,
    total: items.length,
    storageDurable: true,
  })
  assert.deepEqual(calls, [
    ...[16, 8, 4, 2, 1].map((pageSize) => ({ page: 1, pageSize })),
    { page: 2, pageSize: 1, revision: 'complete' },
    { page: 3, pageSize: 1, revision: 'complete' },
  ])
})

test('restarts at page one with a new revision and discards partial oversized results', async () => {
  const calls: { page: number; pageSize: number; revision?: string }[] = []
  const latest = Array.from({ length: 17 }, (_, index) => ({
    ...account,
    id: `latest-${index}`,
  }))
  const api = createAccountsApi(async (_id, _cap, _method, payload, parse) => {
    const input = payload as (typeof calls)[number]
    calls.push(input)
    if (input.pageSize === 16 && input.page === 2)
      throw new PluginCallError('UNAVAILABLE', pageTooLarge, true)
    const items =
      input.pageSize === 16
        ? Array.from({ length: 16 }, (_, index) => ({ ...account, id: `old-${index}` }))
        : latest.slice((input.page - 1) * input.pageSize, input.page * input.pageSize)
    return parse({
      items,
      bindings: items.map((item) => ({
        windowId: `profile-${item.id}`,
        accountId: item.id,
        boundAt: account.createdAt,
        revision: 'binding',
      })),
      total: 17,
      page: input.page,
      pageSize: input.pageSize,
      revision: input.pageSize === 16 ? 'old' : 'new',
      storageDurable: input.pageSize === 16,
    })
  })
  const result = await api.listAccounts()
  assert.deepEqual(result.items, latest)
  assert.equal(result.bindings.length, latest.length)
  assert.ok(result.bindings.every((binding) => binding.accountId.startsWith('latest-')))
  assert.equal(result.storageDurable, false)
  assert.deepEqual(calls, [
    { page: 1, pageSize: 16 },
    { page: 2, pageSize: 16, revision: 'old' },
    { page: 1, pageSize: 8 },
    { page: 2, pageSize: 8, revision: 'new' },
    { page: 3, pageSize: 8, revision: 'new' },
  ])
})

test('bounds overflow recovery and preserves custom page-size validation', async () => {
  for (const [initialSize, expectedSizes] of [
    [undefined, [16, 8, 4, 2, 1]],
    [3, [3, 1]],
    [1, [1]],
  ] as const) {
    const sizes: number[] = []
    const overflow = new PluginCallError('UNAVAILABLE', pageTooLarge, true)
    const api = createAccountsApi(async (_id, _cap, _method, payload) => {
      sizes.push((payload as { pageSize: number }).pageSize)
      throw overflow
    })
    await assert.rejects(api.listAccounts(initialSize), (error) => error === overflow)
    assert.deepEqual(sizes, expectedSizes)
  }
  let calls = 0
  const api = createAccountsApi(async () => {
    calls++
    throw new Error('unexpected RPC')
  })
  for (const size of [0, -1, 1.5, 17, Number.NaN, Number.POSITIVE_INFINITY])
    await assert.rejects(api.listAccounts(size), /账号页大小无效/)
  assert.equal(calls, 0)
})

test('only trusted size errors trigger recovery and malformed pages never retry', async () => {
  const forged = Object.assign(new Error(pageTooLarge), {
    name: 'PluginCallError',
    code: 'UNAVAILABLE',
    retryable: true,
  })
  for (const failure of [
    new PluginCallError('UNAVAILABLE', '账号存储读取失败', true),
    new PluginCallError('INTERNAL', pageTooLarge, true),
    new Error(pageTooLarge),
    { code: 'UNAVAILABLE', message: pageTooLarge, retryable: true },
    forged,
  ]) {
    let calls = 0
    const api = createAccountsApi(async () => {
      calls++
      throw failure
    })
    await assert.rejects(api.listAccounts(), (error) => error === failure)
    assert.equal(calls, 1)
  }
  let calls = 0
  const malformed = createAccountsApi(async (_id, _cap, _method, _payload, parse) => {
    calls++
    return parse({ items: [] })
  })
  await assert.rejects(malformed.listAccounts())
  assert.equal(calls, 1)
})

test('rejects a changed smaller-attempt revision without further size recovery', async () => {
  const sizes: number[] = []
  const api = createAccountsApi(async (_id, _cap, _method, payload, parse) => {
    const { page, pageSize } = payload as { page: number; pageSize: number }
    sizes.push(pageSize)
    if (pageSize === 16) throw new PluginCallError('UNAVAILABLE', pageTooLarge, true)
    return parse({
      items: Array.from({ length: page === 1 ? 8 : 1 }, (_, index) => ({
        ...account,
        id: `page-${page}-${index}`,
      })),
      bindings: [],
      total: 9,
      page,
      pageSize,
      revision: `revision-${page}`,
      storageDurable: true,
    })
  })
  await assert.rejects(api.listAccounts(), /账号列表已变化/)
  assert.deepEqual(sizes, [16, 8, 8])
})

test('stops overflow recovery when the Workspace changes', async () => {
  let scope = 'connection-1'
  let calls = 0
  const api = createAccountsApi(
    async () => {
      calls++
      scope = 'connection-2'
      throw new PluginCallError('UNAVAILABLE', pageTooLarge, true)
    },
    () => scope,
  )
  await assert.rejects(api.listAccounts(), /Workspace 已切换/)
  assert.equal(calls, 1)
})

test('rejects changed revisions, duplicate account identities, and duplicate window bindings', async () => {
  for (const changedRevision of [true, false]) {
    let page = 0
    const api = createAccountsApi(
      async (_id, _capability, _method, _payload, parse) => {
        page++
        const items =
          page === 1
            ? Array.from({ length: 16 }, (_, index) => ({
                ...account,
                id: `account-${index}`,
              }))
            : [{ ...account, id: changedRevision ? 'account-last' : 'account-0' }]
        return parse({
          items,
          total: 17,
          bindings:
            page === 1
              ? [
                  {
                    windowId: 'window-1',
                    accountId: 'account-0',
                    boundAt: account.createdAt,
                    revision: 'r1',
                  },
                ]
              : [],
          storageDurable: true,
          page,
          pageSize: 16,
          revision: changedRevision && page === 2 ? 'two' : 'one',
        })
      },
      () => null,
    )
    await assert.rejects(api.listAccounts())
  }
  const duplicateBindings = createAccountsApi(
    async (_id, _capability, _method, payload, parse) => {
      const page = (payload as { page: number }).page
      if (page === 2)
        return parse({
          items: [{ ...account, id: 'account-16' }],
          total: 17,
          bindings: [
            {
              windowId: 'window-1',
              accountId: 'account-16',
              boundAt: account.createdAt,
              revision: 'r2',
            },
          ],
          storageDurable: true,
          page,
          pageSize: 16,
          revision: 'same',
        })
      return parse({
        items: Array.from({ length: 16 }, (_, index) => ({
          ...account,
          id: index === 0 ? 'account-1' : `page-one-${index}`,
        })),
        total: 17,
        bindings: [
          {
            windowId: 'window-1',
            accountId: 'account-1',
            boundAt: account.createdAt,
            revision: 'r1',
          },
        ],
        storageDurable: true,
        page,
        pageSize: 16,
        revision: 'same',
      })
    },
    () => null,
  )
  await assert.rejects(duplicateBindings.listAccounts(), /窗口关联/)
})

test('imports mailbox identities without overwriting duplicate account records', async () => {
  const calls: unknown[] = []
  const api = createAccountsApi(
    async (_id, _capability, method, payload, parse) => {
      calls.push({ method, payload })
      return parse({ total: 1, inserted: 1, skipped: 0 })
    },
    () => null,
  )
  const report = await api.importMailboxes({
    mailboxes: [{ mailboxId: 'mail-1', email: 'mail@example.test' }],
    loginMethod: 'email',
    phone: '',
    emailOtpUrl: '',
    smsOtpUrl: '',
    status: 'pending',
    homepageUrl: '',
    note: '',
    expectedDuplicateIds: [],
  })
  assert.equal(report.inserted, 1)
  assert.equal((calls[0] as { method: string }).method, 'vinted.accounts.mailbox.import')
})

test('both mailbox import entries strip source credentials and reject normalized input duplicates before RPC', async () => {
  const payloads: unknown[] = []
  const api = createAccountsApi(async (_id, _cap, _method, payload, parse) => {
    payloads.push(payload)
    return parse({ total: 1, inserted: 1, skipped: 0 })
  })
  const input = {
    mailboxes: [
      {
        mailboxId: 'm1',
        email: 'mail@example.test',
        password: 'synthetic-secret',
        refreshToken: 'synthetic-token',
      },
    ],
    loginMethod: 'email' as const,
    phone: '',
    emailOtpUrl: '',
    smsOtpUrl: '',
    status: 'pending' as const,
    homepageUrl: '',
    note: '',
    expectedDuplicateIds: [],
    password: 'synthetic-root-secret',
  }
  await api.mailboxImport(input)
  await api.importMailboxes(input)
  assert.doesNotMatch(JSON.stringify(payloads), /synthetic|password|refreshToken/)
  await assert.rejects(async () =>
    api.importMailboxes({
      ...input,
      mailboxes: [
        ...input.mailboxes,
        { ...input.mailboxes[0]!, mailboxId: 'm2', email: 'MAIL@example.test' },
      ],
    }),
  )
  assert.equal(payloads.length, 2)
})

test('rejects duplicate and orphan bindings on the first account page', async () => {
  for (const patch of [
    { items: [account, account], total: 2 },
    {
      bindings: [
        { windowId: 'profile-1', accountId: 'missing', boundAt: account.createdAt },
      ],
    },
    {
      bindings: Array.from({ length: 2 }, () => ({
        windowId: 'profile-1',
        accountId: account.id,
        boundAt: account.createdAt,
      })),
    },
    { total: 2001 },
    { total: 2 },
  ]) {
    const api = createAccountsApi(async (_id, _cap, _method, _payload, parse) =>
      parse({
        items: [account],
        total: 1,
        bindings: [],
        page: 1,
        pageSize: 16,
        revision: 'r1',
        storageDurable: true,
        ...patch,
      }),
    )
    await assert.rejects(api.listAccounts())
  }
})

test('relation target DTOs reject credentials instead of retaining them', () => {
  assert.throws(() =>
    parseAccountMailboxTarget({
      id: 'a',
      account: 'a',
      status: 'active',
      mailbox: null,
      password: 'secret',
    }),
  )
  assert.throws(() =>
    parseMailboxTarget({
      id: 'm',
      email: 'm@example.test',
      enabled: true,
      status: 'active',
      refreshToken: 'secret',
    }),
  )
})

test('mailbox writes verify both identity and email before reporting success', async () => {
  const api = createAccountsApi(async (_id, _cap, _method, _payload, parse) =>
    parse({
      mailbox: {
        pluginId: 'studio.email',
        mailboxId: 'mail-1',
        email: 'changed@example.test',
        linkedAt: account.createdAt,
      },
      updatedAt: account.updatedAt,
      storageDurable: true,
    }),
  )
  await assert.rejects(
    api.assignMailbox(
      account.id,
      { pluginId: 'studio.email', mailboxId: 'mail-1', email: 'seller@example.test' },
      null,
    ),
  )
})

test('account gate rejects missing base methods and gates optional groups independently', () => {
  const plugin = {
    enabled: true,
    state: 'running',
    capabilities: ['account.pool'],
    granted: ['account.pool'],
    methods: [...ACCOUNT_METHOD_GROUPS.base] as string[],
  }
  assert.equal(supportsAccountBase(plugin), true)
  assert.equal(supportsAccountBase({ ...plugin, granted: [] }), false)
  for (const missing of ACCOUNT_METHOD_GROUPS.base)
    assert.equal(
      supportsAccountBase({
        ...plugin,
        methods: plugin.methods.filter((method) => method !== missing),
      }),
      false,
    )
  assert.equal(supportsAccountOptional(plugin, 'mailbox'), false)
  assert.equal(
    supportsAccountOptional({ methods: [...ACCOUNT_METHOD_GROUPS.mailbox] }, 'mailbox'),
    true,
  )
})

test('mailbox target aggregation rejects changed totals and repeated identities', async () => {
  for (const repeated of [false, true]) {
    const api = createAccountsApi(async (_id, _cap, _method, payload, parse) => {
      const { page, pageSize } = payload as { page: number; pageSize: number }
      return parse({
        page,
        pageSize,
        total: page === 2 && !repeated ? 52 : 51,
        storageDurable: true,
        items: Array.from({ length: page === 1 ? 50 : 1 }, (_, index) => ({
          id: `mail-${page === 1 || repeated ? index : 50}`,
          email: `mail${page}-${index}@example.test`,
          enabled: true,
          status: 'active',
        })),
      })
    })
    await assert.rejects(api.emailTargetsAll())
  }
})

test('base64 imports respect encoded payload limit before calling the plugin', async () => {
  let calls = 0
  const api = createAccountsApi(async () => {
    calls++
    throw new Error('unexpected RPC')
  })
  await assert.rejects(
    api.importAccounts('accounts.xlsx', { base64: 'A'.repeat(512 * 1024 + 4) }),
  )
  assert.equal(calls, 0)
})

test('order-watch details retain candidate checks and notification history', async () => {
  const api = createAccountsApi(async (_id, _cap, _method, payload, parse) => {
    assert.deepEqual(payload, { accountId: 'account-1' })
    return parse({
      items: [
        {
          accountId: 'account-1',
          candidates: [
            {
              id: 'candidate-1',
              itemId: '123',
              itemUrl: 'https://www.vinted.com/items/123',
              title: 'Example',
              imageUrl: null,
              lastSeenAt: null,
              missingAt: account.createdAt,
              checkedAt: account.updatedAt,
              status: 'sold',
              checkError: null,
              notifiedAt: null,
              notifyError: 'Bark failed',
            },
          ],
        },
      ],
    })
  })
  const detail = await api.orderWatchHistory('account-1')
  assert.equal(detail[0]?.status, 'sold')
  assert.equal(detail[0]?.notifyError, 'Bark failed')
})

test('Profile binding only reports success for the requested account and Profile', async () => {
  const api = createAccountsApi(async (_id, _cap, _method, _payload, parse) =>
    parse({
      bound: true,
      duplicates: [],
      binding: {
        accountId: 'another-account',
        windowId: 'another-profile',
        boundAt: account.createdAt,
        revision: 'revision',
      },
    }),
  )
  await assert.rejects(api.bindAccount('account-1', 'profile-1'))
})
