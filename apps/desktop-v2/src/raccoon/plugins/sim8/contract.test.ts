import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCategories,
  parseExpirySnapshot,
  parseConfig,
  parseFilterDetail,
  parseOrderApis,
  parsePurchase,
  parseRecordList,
  parseSmsRecord,
} from './parse.ts'
import { SIM8_METHODS, supportsSim8Methods } from './methods.ts'
import { createSim8Api } from './api.ts'
import { sim8OptionalGroup, supportsSim8Page } from './page-contract.ts'
import { createSim8AccountBridge } from './accounts.ts'

const record = {
  tel: '+14155550100',
  token: 'private-link',
  api: 'https://otp.example',
  apiId: 7,
  ordernum: 'ORD-1',
  appId: 2,
  cateId: 1,
  type: 1,
  endTime: '2030-01-01 00:00:00',
  remark: '',
  status: 1,
  renew: 0,
  smsCount: 0,
  voiceCount: 0,
  addedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRead: null,
}

test('validates SIM8 configuration and rejects malformed credentials metadata', () => {
  assert.deepEqual(
    parseConfig({
      baseUrl: 'https://api.cc',
      hasToken: true,
      profile: { username: 'user', nickname: 'Shop', avatar: '', money: 10.5 },
      profileAt: null,
      records: 1,
      storageDurable: true,
    }).profile?.money,
    10.5,
  )
  assert.throws(() =>
    parseConfig({
      baseUrl: 'https://api.cc',
      hasToken: 'yes',
      profile: null,
      profileAt: null,
      records: 0,
      storageDurable: true,
    }),
  )
})

test('validates number records and prevents duplicate telephone rows', () => {
  assert.equal(parseSmsRecord(record).tel, record.tel)
  assert.throws(() => parseSmsRecord({ ...record, tel: 7 }))
  assert.throws(() =>
    parseRecordList({
      items: [record, record],
      total: 2,
      matched: 2,
      storageDurable: true,
    }),
  )
})

test('rejects purchase totals that cannot be confirmed by the returned records', () => {
  assert.throws(() =>
    parsePurchase({
      ordernum: 'ORD-1',
      apiCount: 1,
      requested: 1,
      total: 2,
      truncated: false,
      records: [record],
    }),
  )
})

test('rejects an order page whose count contradicts the supplied records', () => {
  assert.throws(() =>
    parseOrderApis({
      ordernum: 'ORD-1',
      total: 0,
      truncated: false,
      records: [record],
      allocation: {
        ordernum: 'ORD-1',
        allocationStatus: 'completed',
        requestedNum: 1,
        allocatedNum: 1,
        apiCount: 1,
        expireAt: '',
        failureReason: '',
      },
    }),
  )
})

test('rejects filter results with an invalid order identity', () => {
  assert.throws(() =>
    parseFilterDetail({
      orderId: 0,
      ordernum: '',
      name: '',
      countryCode: '',
      country: '',
      appId: null,
      price: 0,
      num: null,
      valid: null,
      money: 0,
      fileUrl: '',
      taskFileUrl: '',
      taskRemark: '',
      status: null,
      createTime: '',
      updateTime: '',
    }),
  )
})

test('gates orders, filtering, and expiry independently from the number pool', () => {
  assert.equal(supportsSim8Methods(SIM8_METHODS.base), true)
  assert.equal(supportsSim8Methods([...SIM8_METHODS.base, ...SIM8_METHODS.orders]), true)
  assert.equal(supportsSim8Methods(SIM8_METHODS.base, 'orders'), false)
  assert.equal(supportsSim8Methods(SIM8_METHODS.base, 'filtering'), false)
  assert.equal(supportsSim8Methods(SIM8_METHODS.base, 'expiry'), false)
  assert.equal(
    supportsSim8Methods([...SIM8_METHODS.base, ...SIM8_METHODS.orders], 'renewals'),
    false,
  )
})

test('requires the running granted base capability while keeping optional pages independent', () => {
  const base = {
    capabilities: ['verification.provider'],
    granted: ['verification.provider'],
    methods: [...SIM8_METHODS.base],
    enabled: true,
    state: 'running',
  }
  assert.equal(supportsSim8Page(base), true)
  assert.equal(supportsSim8Page({ ...base, state: 'starting' }), false)
  assert.equal(supportsSim8Page({ ...base, granted: [] }), false)
  assert.equal(supportsSim8Page({ ...base, methods: base.methods.slice(1) }), false)
  assert.equal(
    sim8OptionalGroup({ methods: [...base.methods, ...SIM8_METHODS.orders] }, 'orders'),
    true,
  )
  assert.equal(sim8OptionalGroup({ methods: base.methods }, 'orders'), false)
})

test('parses expiry snapshots without accepting malformed dates or duplicate pending numbers', () => {
  const parsed = parseExpirySnapshot({
    items: [{ tel: record.tel, expiresAt: '2030-01-01T00:00:00Z', checkedAt: null }],
    pendingTels: [],
    failed: 0,
    storageDurable: true,
  })
  assert.equal(parsed.items[0]?.tel, record.tel)
  assert.throws(() =>
    parseExpirySnapshot({
      items: [{ tel: record.tel, expiresAt: 'soon', checkedAt: null }],
      pendingTels: [],
      failed: 0,
      storageDurable: true,
    }),
  )
  assert.throws(() =>
    parseExpirySnapshot({
      items: [{ tel: record.tel, expiresAt: '2030-01-01T00:00:00Z', checkedAt: 'later' }],
      pendingTels: [],
      failed: 0,
      storageDurable: true,
    }),
  )
  assert.throws(() =>
    parseExpirySnapshot({
      items: [
        { tel: record.tel, expiresAt: '2030-01-01T00:00:00Z', checkedAt: null },
        { tel: record.tel, expiresAt: '2031-01-01T00:00:00Z', checkedAt: null },
      ],
      pendingTels: [],
      failed: 0,
      storageDurable: true,
    }),
  )
})

test('parses category results and rejects duplicate category identities', () => {
  assert.equal(
    parseCategories({ items: [{ id: 1, name: 'Social', count: null }], total: 1 }).items
      .length,
    1,
  )
  assert.throws(() =>
    parseCategories({
      items: [
        { id: 1, name: 'A', count: null },
        { id: 1, name: 'B', count: 2 },
      ],
      total: 2,
    }),
  )
})

test('routes a purchase through the verification capability with its long deadline', async () => {
  const calls: {
    id: string
    capability: string
    method: string
    payload: unknown
    deadline?: number
  }[] = []
  const api = createSim8Api(async (id, capability, method, payload, parse, deadline) => {
    calls.push({ id, capability, method, payload, deadline })
    return parse({
      ordernum: 'ORD-1',
      apiCount: 1,
      requested: 1,
      total: 1,
      truncated: false,
      records: [record],
    })
  })
  const result = await api.buy({ appId: 2, num: 1 })
  assert.equal(result.records[0]?.tel, record.tel)
  assert.deepEqual(calls[0], {
    id: 'studio.sim8',
    capability: 'verification.provider',
    method: 'sim8.buy.create',
    payload: { appId: 2, num: 1 },
    deadline: 60_000,
  })
})

test('routes expiry reads, refreshes, and dismissals through the SIM8 capability', async () => {
  const calls: { method: string; payload: unknown; deadline?: number }[] = []
  const api = createSim8Api(
    async (_id, _capability, method, payload, parse, deadline) => {
      calls.push({ method, payload, deadline })
      return parse({ items: [], pendingTels: [], failed: 0, storageDurable: true })
    },
  )
  await api.expiryList()
  await api.expiryRefresh([record.tel])
  await api.expiryDismiss(record.tel, '2030-01-01T00:00:00.000Z')
  assert.deepEqual(
    calls.map(({ method, payload, deadline }) => ({ method, payload, deadline })),
    [
      { method: 'sim8.expiry.list', payload: {}, deadline: 30_000 },
      {
        method: 'sim8.expiry.refresh',
        payload: { tels: [record.tel] },
        deadline: 60_000,
      },
      {
        method: 'sim8.expiry.dismiss',
        payload: { tel: record.tel, expiresAt: '2030-01-01T00:00:00.000Z' },
        deadline: 30_000,
      },
    ],
  )
})

test('does not return saved tokens and routes SMS results through validated parsing', async () => {
  const calls: { method: string; payload: unknown }[] = []
  const api = createSim8Api(async (_id, _capability, method, payload, parse) => {
    calls.push({ method, payload })
    if (method === 'sim8.config.set')
      return parse({
        baseUrl: 'https://api.cc',
        hasToken: true,
        profile: null,
        profileAt: null,
        records: 0,
        storageDurable: true,
      })
    return parse({
      tel: record.tel,
      result: {
        code: '1234',
        body: 'code 1234',
        truncated: false,
        contentType: 'text/plain',
        fetchedAt: '2030-01-01T00:00:00Z',
      },
    })
  })
  const config = await api.saveConfig({
    token: 'never-echo-this',
    baseUrl: 'https://api.cc',
  })
  const sms = await api.readSms(record.tel)
  assert.equal(config.hasToken, true)
  assert.equal(JSON.stringify(config).includes('never-echo-this'), false)
  assert.deepEqual(calls, [
    {
      method: 'sim8.config.set',
      payload: { token: 'never-echo-this', baseUrl: 'https://api.cc' },
    },
    { method: 'sim8.sms.read', payload: { tel: record.tel } },
  ])
  assert.equal(sms.result.code, '1234')
})

test('preserves unknown account status, every field and revision when attaching a SIM8 number', async () => {
  const account = {
    id: 'account-1',
    loginMethod: 'email',
    account: 'seller@example.com',
    password: 'keep-secret',
    phone: '',
    emailOtpUrl: 'https://mail.example/otp',
    smsOtpUrl: '',
    note: 'seller',
    status: 'unknown',
    homepageUrl: 'https://vinted.example/member',
    address: null,
    mailbox: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  } as const
  const calls: { method: string; payload: unknown }[] = []
  let listCount = 0
  const bridge = createSim8AccountBridge(
    async (_id, _capability, method, payload, parse) => {
      calls.push({ method, payload })
      if (method === 'vinted.accounts.list') {
        listCount++
        return parse({
          items: [account],
          total: 1,
          page: 1,
          pageSize: 16,
          revision: `rev-${listCount}`,
          bindings: [],
          storageDurable: true,
        })
      }
      return parse({
        item: {
          ...account,
          phone: record.tel,
          smsOtpUrl: record.api,
          updatedAt: '2026-01-03T00:00:00.000Z',
        },
        created: false,
      })
    },
  )
  const targets = await bridge.list()
  assert.deepEqual(targets, [
    { id: account.id, account: account.account, phone: '', smsOtpUrl: '' },
  ])
  await bridge.attachTo(targets[0]!.id, record)
  assert.equal(JSON.stringify(targets).includes(account.password), false)
  assert.equal(JSON.stringify(targets).includes(account.emailOtpUrl), false)
  const listCalls = calls.filter((call) => call.method === 'vinted.accounts.list')
  assert.equal(listCalls.length, 2)
  const write = calls.find((call) => call.method === 'vinted.accounts.save')
  assert.deepEqual(write, {
    method: 'vinted.accounts.save',
    payload: {
      id: account.id,
      expectedUpdatedAt: account.updatedAt,
      loginMethod: account.loginMethod,
      account: account.account,
      password: account.password,
      phone: record.tel,
      emailOtpUrl: account.emailOtpUrl,
      smsOtpUrl: record.api,
      note: account.note,
      status: account.status,
      homepageUrl: account.homepageUrl,
    },
  })
})

test('rejects an account save response that does not confirm the attached number', async () => {
  const account = {
    id: 'account-1',
    loginMethod: 'email',
    account: 'seller@example.com',
    password: '',
    phone: '',
    emailOtpUrl: '',
    smsOtpUrl: '',
    note: '',
    status: 'active',
    homepageUrl: '',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
  const bridge = createSim8AccountBridge(
    async (_id, _capability, method, _payload, parse) => {
      if (method === 'vinted.accounts.list')
        return parse({
          items: [account],
          total: 1,
          page: 1,
          pageSize: 16,
          revision: 'rev-1',
          bindings: [],
          storageDurable: true,
        })
      return parse({ item: account, created: false })
    },
  )
  await assert.rejects(bridge.attachTo(account.id, record), /写入未确认/)
})
