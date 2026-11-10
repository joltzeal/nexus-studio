import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeRecords } from '../domain/records.js'
import { normalizePurchased } from '../domain/normalize.js'
import type { DispatchContext } from '../rpc/protocol.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
} from '../store/private-store.js'
import { ExpiryService } from './expiry.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function context(): DispatchContext {
  return {
    requestId: 'expiry',
    capability: 'verification.provider',
    method: 'sim8.expiry.refresh',
    payload: {},
    deadlineAt: Date.now() + 60_000,
    assertAlive: () => undefined,
  }
}

async function fixture(store = createMemoryStore()) {
  const clock = { now: new Date(2026, 9, 30, 12) }
  await store.mutate((draft) => {
    draft.records = mergeRecords(
      [],
      normalizePurchased({
        list: [
          {
            tel: '+14155550100',
            api: 'https://sms.example.test/read?token=test',
            end_time: '2026-11-03 12:00:00',
          },
        ],
      }),
      clock.now.toISOString(),
    )
  })
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({ code: 0, expire: '2026-11-04 12:00:00' }),
  )
  const service = new ExpiryService({ store, now: () => clock.now, fetchImpl })
  return { store, clock, fetchImpl, service }
}

describe('expiry checks and daily reminders', () => {
  it('fetches the stored link without the account token, persists expire and leaves OTP untouched', async () => {
    const { store, service, fetchImpl } = await fixture()
    await service.refresh(['14155550100'], context())
    const snapshot = await service.list()
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]?.expiresAt).toBe(new Date(2026, 10, 4, 12).toISOString())
    expect(snapshot.pendingTels).toEqual([])
    expect((await store.read()).records[0]?.lastRead).toBeNull()
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(
      false,
    )
    await service.refresh(['+14155550100'], context())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retains a confirmed date when checks fail and backs off failed or missing expire', async () => {
    const { service, fetchImpl, clock } = await fixture()
    fetchImpl
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(Response.json({ msg: 'no date' }))
    await service.refresh(['14155550100'], context())
    expect((await service.list()).items).toHaveLength(1)
    expect((await service.list()).failed).toBe(1)
    expect((await service.list()).pendingTels).toEqual([])
    clock.now = new Date(clock.now.getTime() + 15 * 60_000)
    expect((await service.list()).pendingTels).toEqual(['+14155550100'])
    await service.refresh(['14155550100'], context())
    expect((await service.list()).failed).toBe(1)
    expect((await service.list()).items[0]?.expiresAt).toBe(
      new Date(2026, 10, 3, 12).toISOString(),
    )
  })

  it('persists today-only dismissal across restart and permits tomorrow or a renewed expiry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-sim8-expiry-'))
    dirs.push(dir)
    const { service, clock } = await fixture(createFileStore(dir))
    const first = (await service.list()).items[0]!
    await service.dismiss(first.tel, first.expiresAt, context())
    const restarted = new ExpiryService({
      store: createFileStore(dir),
      now: () => clock.now,
    })
    expect((await restarted.list()).items).toEqual([])
    clock.now = new Date(2026, 9, 31, 0, 1)
    expect((await restarted.list()).items).toHaveLength(1)
    await restarted.dismiss(first.tel, first.expiresAt, context())
    expect((await restarted.list()).items).toEqual([])
    // Renewal changes the reminder identity even if it is still within seven days.
    const renewedStore = createFileStore(dir)
    await renewedStore.mutate((draft) => {
      draft.records[0]!.endTime = '2026-11-05 12:00:00'
    })
    const renewed = new ExpiryService({
      store: createFileStore(dir),
      now: () => clock.now,
    })
    expect((await renewed.list()).items).toHaveLength(1)
    await expect(renewed.dismiss(first.tel, first.expiresAt, context())).rejects.toThrow(
      '到期时间已变化',
    )
  })

  it('loads old documents without expiry metadata and reports failed dismiss writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-sim8-expiry-'))
    dirs.push(dir)
    const { store, clock } = await fixture()
    await writeFile(join(dir, 'sim8.json'), JSON.stringify(await store.read()))
    const loaded = createFileStore(dir)
    expect(
      (await new ExpiryService({ store: loaded, now: () => clock.now }).list()).items,
    ).toHaveLength(1)
    const failed: PrivateStore = {
      ...loaded,
      kind: 'file',
      durable: true,
      read: () => loaded.read(),
      mutate: async () => {
        throw new Error('disk full')
      },
    }
    const service = new ExpiryService({ store: failed, now: () => clock.now })
    const reminder = (await service.list()).items[0]!
    await expect(
      service.dismiss(reminder.tel, reminder.expiresAt, context()),
    ).rejects.toThrow('disk full')
    expect((await service.list()).items).toHaveLength(1)
  })

  it('does not apply a late response after link replacement or deletion', async () => {
    for (const action of ['replace', 'delete']) {
      const { service, store, fetchImpl } = await fixture()
      let finish!: (value: Response) => void
      fetchImpl.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      )
      const request = service.refresh(['14155550100'], context())
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
      await store.mutate((draft) => {
        if (action === 'delete') draft.records = []
        else draft.records[0]!.api = 'https://sms.example.test/new'
      })
      finish(Response.json({ expire: '2026-11-05 12:00:00' }))
      await request
      expect((await store.read()).records[0]?.endTime).toBe(
        action === 'delete' ? undefined : '2026-11-03 12:00:00',
      )
    }
  })

  it('limits concurrency and shares overlapping checks', async () => {
    const { store, service, fetchImpl } = await fixture()
    await store.mutate((draft) => {
      draft.records = mergeRecords(
        [],
        normalizePurchased({
          list: Array.from({ length: 8 }, (_, index) => ({
            tel: String(100 + index),
            api: `https://sms.example.test/${index}`,
          })),
        }),
        new Date().toISOString(),
      )
    })
    const finish: Array<() => void> = []
    let active = 0
    let maximum = 0
    fetchImpl.mockImplementation(() => {
      active += 1
      maximum = Math.max(maximum, active)
      return new Promise<Response>((resolve) =>
        finish.push(() => {
          active -= 1
          resolve(Response.json({ expire: '2026-11-04 12:00:00' }))
        }),
      )
    })
    const tels = Array.from({ length: 8 }, (_, i) => String(100 + i))
    const first = service.refresh(tels, context())
    const second = service.refresh(tels, context())
    await vi.waitFor(() => expect(finish).toHaveLength(4))
    finish.splice(0).forEach((done) => done())
    await vi.waitFor(() => expect(finish).toHaveLength(4))
    finish.splice(0).forEach((done) => done())
    await Promise.all([first, second])
    expect(maximum).toBe(4)
    expect(fetchImpl).toHaveBeenCalledTimes(8)
  })
})
