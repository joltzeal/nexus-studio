import { describe, expect, it } from 'vitest'

import { findRecord, mergeRecords, removeRecord, searchRecords } from './records.js'
import type { PurchasedApi, SmsRecord } from './types.js'

function purchased(overrides: Partial<PurchasedApi> = {}): PurchasedApi {
  return {
    tel: '+14155550100',
    token: 'tok',
    api: 'https://api.cc/api/record?token=tok',
    apiId: null,
    ordernum: 'ORD-1',
    appId: 9,
    cateId: 2,
    type: 1,
    endTime: '2026-11-01 12:00:00',
    remark: '',
    status: 0,
    renew: 0,
    smsCount: 0,
    voiceCount: 0,
    ...overrides,
  }
}

const NOW = '2026-10-24T00:00:00.000Z'
const LATER = '2026-10-24T01:00:00.000Z'

describe('record list', () => {
  it('adds a purchased number', () => {
    const records = mergeRecords([], [purchased()], NOW)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      tel: '+14155550100',
      addedAt: NOW,
      lastRead: null,
    })
  })

  it('replaces the link of a number that was bought again', () => {
    const first = mergeRecords([], [purchased()], NOW)
    const second = mergeRecords(
      first,
      [purchased({ token: 'new', api: 'https://api.cc/api/record?token=new' })],
      LATER,
    )
    expect(second).toHaveLength(1)
    expect(second[0]?.token).toBe('new')
    expect(second[0]?.api).toContain('token=new')
    // The first sighting is what decides its place in the list.
    expect(second[0]?.addedAt).toBe(NOW)
    expect(second[0]?.updatedAt).toBe(LATER)
  })

  it('keeps what a richer row already said when a bare line arrives', () => {
    const rich = mergeRecords([], [purchased({ apiId: 42, remark: '主号' })], NOW)
    const bare = mergeRecords(
      rich,
      [
        purchased({
          apiId: null,
          token: '',
          api: 'https://api.cc/api/record?token=other',
          endTime: '',
          appId: null,
          remark: '',
          status: null,
        }),
      ],
      LATER,
    )
    expect(bare[0]).toMatchObject({
      apiId: 42,
      remark: '主号',
      endTime: '2026-11-01 12:00:00',
      appId: 9,
      status: 0,
    })
  })

  it('sorts newest first', () => {
    const records = mergeRecords([], [purchased({ tel: '1' })], NOW)
    const next = mergeRecords(records, [purchased({ tel: '2' })], LATER)
    expect(next.map((record) => record.tel)).toEqual(['2', '1'])
  })

  it('finds a number regardless of formatting', () => {
    const records = mergeRecords([], [purchased()], NOW)
    expect(findRecord(records, '14155550100')?.tel).toBe('+14155550100')
  })

  it('removes a number and reports whether anything went', () => {
    const records = mergeRecords([], [purchased()], NOW)
    const first = removeRecord(records, '+14155550100')
    expect(first.removed).toBe(true)
    expect(first.records).toHaveLength(0)
    expect(removeRecord(first.records, '+14155550100').removed).toBe(false)
  })

  it('searches number, order and remark', () => {
    const records: SmsRecord[] = mergeRecords(
      [],
      [
        purchased({ remark: '备用' }),
        purchased({ tel: '+14155550101', ordernum: 'X-9' }),
      ],
      NOW,
    )
    expect(searchRecords(records, '备用')).toHaveLength(1)
    expect(searchRecords(records, 'x-9')).toHaveLength(1)
    expect(searchRecords(records, '14155550101')).toHaveLength(1)
    expect(searchRecords(records, '')).toHaveLength(2)
  })
})
