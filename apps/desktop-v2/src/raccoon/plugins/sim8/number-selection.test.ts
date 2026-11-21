import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalPhone,
  loadNumberChoices,
  numberChoicePage,
} from './number-selection.ts'
import type { SmsRecord } from './types.ts'

const record: SmsRecord = {
  tel: '+1 (415) 555-0100',
  token: 'private',
  api: 'https://sms.example/private',
  apiId: 1,
  ordernum: 'ORDER',
  appId: 1,
  cateId: 1,
  type: 1,
  endTime: '2026-11-18T00:00:00Z',
  remark: 'Saved number',
  status: 1,
  renew: 0,
  smsCount: 0,
  voiceCount: 0,
  addedAt: '2026-11-17T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
  lastRead: null,
}
test('number selection uses supplied digits and identifies current, shared and expired records', () => {
  const accounts = [
    {
      id: 'current',
      account: 'current@example.test',
      phone: '+14155550100',
      smsOtpUrl: '',
    },
    {
      id: 'other',
      account: 'other@example.test',
      phone: '1 415 555 0100',
      smsOtpUrl: '',
    },
  ]
  assert.equal(canonicalPhone('0044 (020)'), '0044020')
  const page = numberChoicePage(
    [record],
    accounts,
    'current',
    '1415555',
    1,
    Date.parse('2026-11-19'),
  )
  assert.equal(page.items[0]?.current, true)
  assert.equal(page.items[0]?.expired, true)
  assert.deepEqual(
    page.items[0]?.others.map((owner) => owner.id),
    ['other'],
  )
})
test('search and pagination retain all matching numbers and clamp the last page', () => {
  const records = Array.from({ length: 41 }, (_, index) => ({
    ...record,
    tel: String(index),
    remark: `Row ${index}`,
  }))
  assert.equal(numberChoicePage(records, [], undefined, '', 1).items.length, 20)
  assert.equal(numberChoicePage(records, [], undefined, '', 2).items.length, 20)
  const last = numberChoicePage(records, [], undefined, '', 9)
  assert.equal(last.page, 3)
  assert.equal(last.items[0]?.record.tel, '40')
  assert.equal(numberChoicePage(records, [], undefined, 'row 40', 1).total, 1)
})
test('unknown account occupancy preserves usable records while a record read failure stays an error', async () => {
  const result = await loadNumberChoices(
    async () => ({ items: [record] }),
    async () => {
      throw new Error('unavailable')
    },
  )
  assert.equal(result.accounts, null)
  assert.equal(result.records.length, 1)
  await assert.rejects(
    loadNumberChoices(
      async () => {
        throw new Error('private')
      },
      async () => [],
    ),
    /号码池读取失败/,
  )
})
