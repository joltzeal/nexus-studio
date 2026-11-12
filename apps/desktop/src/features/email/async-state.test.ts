import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred, flushPromises } from '@/features/settings/kernel-test-support'
import { EmailReaderStore, EmailResource } from './async-state'
import { EmailRequestError } from './errors'
import { mailbox, message } from './test-fixtures'
import type { MailMessageDetail, MailMessagePage, MessageReadResult } from './types'

afterEach(() => vi.useRealTimers())

describe('email request lifecycle', () => {
  it('serializes summary polling and skips manual/poll duplicates while an RPC is pending', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    let calls = 0
    const resource = new EmailResource(
      { page: 1 },
      async () => {
        calls += 1
        return pending.promise
      },
      '读取失败',
    )
    resource.start(5_000)
    resource.refresh()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls).toBe(1)
    pending.resolve('committed')
    await flushPromises()
    expect(resource.getSnapshot()).toMatchObject({
      value: 'committed',
      loading: false,
      error: null,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toBe(2)
    resource.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(2)
  })

  it('keeps committed data when a refresh fails and clears the visible error on recovery', async () => {
    let fail = false
    const resource = new EmailResource(
      1,
      async () => {
        if (fail) throw new Error('synthetic-secret')
        return 'committed'
      },
      '列表读取失败，请重试。',
    )
    resource.start()
    await flushPromises()
    fail = true
    resource.refresh()
    await flushPromises()
    expect(resource.getSnapshot()).toMatchObject({
      value: 'committed',
      loading: false,
      error: '列表读取失败，请重试。',
    })
    fail = false
    resource.refresh()
    await flushPromises()
    expect(resource.getSnapshot().error).toBeNull()
    resource.dispose()
  })

  it.each(['success', 'failure'])(
    'ignores obsolete page/filter %s and starts only the latest requested page',
    async (outcome) => {
      const old = deferred<string>()
      const latest = deferred<string>()
      const inputs: string[] = []
      const resource = new EmailResource(
        'account-1/inbox/page-1',
        async (input) => {
          inputs.push(input)
          return inputs.length === 1 ? old.promise : latest.promise
        },
        '读取失败',
      )
      resource.start()
      resource.select('account-1/junkemail/page-1')
      resource.select('account-2/inbox/page-2')
      expect(inputs).toEqual(['account-1/inbox/page-1'])
      if (outcome === 'success') old.resolve('old mail')
      else old.reject(new Error('old failure'))
      await flushPromises()
      expect(resource.getSnapshot()).toMatchObject({
        value: null,
        error: null,
        loading: true,
      })
      expect(inputs).toEqual(['account-1/inbox/page-1', 'account-2/inbox/page-2'])
      latest.resolve('new mail')
      await flushPromises()
      expect(resource.getSnapshot()).toMatchObject({ value: 'new mail', loading: false })
      resource.dispose()
    },
  )

  it.each(['success', 'failure'])(
    'ignores a late %s after reader-close/unmount/process replacement',
    async (outcome) => {
      const pending = deferred<string>()
      const resource = new EmailResource('process-1', () => pending.promise, '读取失败')
      resource.start()
      resource.dispose()
      const snapshot = resource.getSnapshot()
      if (outcome === 'success') pending.resolve('old process data')
      else pending.reject(new Error('old process error'))
      await flushPromises()
      expect(resource.getSnapshot()).toBe(snapshot)
    },
  )

  it('invalidates a read begun before a mutation and queues a fresh read without overlapping', async () => {
    const old = deferred<string>()
    const fresh = deferred<string>()
    let calls = 0
    const resource = new EmailResource(
      1,
      () => (++calls === 1 ? old.promise : fresh.promise),
      '读取失败',
    )
    resource.start()
    resource.invalidate()
    old.resolve('before deletion')
    await flushPromises()
    expect(resource.getSnapshot().value).toBeNull()
    expect(calls).toBe(2)
    fresh.resolve('after deletion')
    await flushPromises()
    expect(resource.getSnapshot().value).toBe('after deletion')
    resource.dispose()
  })

  it('survives effect cleanup/setup without accepting a response from the earlier lifecycle', async () => {
    const old = deferred<string>()
    let calls = 0
    const resource = new EmailResource(
      1,
      () => (++calls === 1 ? old.promise : Promise.resolve('new lifecycle')),
      '读取失败',
    )
    resource.start(5_000)
    resource.dispose()
    resource.start(5_000)
    old.resolve('old lifecycle')
    await flushPromises()
    expect(resource.getSnapshot().value).toBe('new lifecycle')
    resource.dispose()
  })
})

const page = (patch: Partial<MailMessagePage> = {}): MailMessagePage => ({
  items: [message(), message({ id: 'message-2', subject: 'Second subject' })],
  nextCursor: 'page-2',
  total: 25,
  unread: 12,
  ...patch,
})
const detail = (id = 'message-1', isRead = false): MailMessageDetail => ({
  ...message({ id, isRead }),
  to: [],
  body: 'Readable body',
  html: '<p>Readable body</p>',
  truncated: false,
})
const readers: EmailReaderStore[] = []
function reader() {
  const api = {
    list: vi.fn().mockResolvedValue(page()),
    get: vi.fn().mockResolvedValue(detail()),
    setRead: vi.fn().mockImplementation(async (input) => ({
      updatedIds: input.messageIds,
      failures: [],
      isRead: input.isRead,
    })),
  }
  const changed = vi.fn()
  const store = new EmailReaderStore(mailbox(), api, changed)
  readers.push(store)
  store.start()
  return { store, api, changed }
}
afterEach(() => {
  for (const store of readers.splice(0)) store.dispose()
})

describe('mail reader confirmed state and scope', () => {
  it('only marks unread mail after its current detail succeeds, with expected email on every RPC', async () => {
    const { store, api, changed } = reader()
    await flushPromises()
    const pending = deferred<MailMessageDetail>()
    api.get.mockReturnValueOnce(pending.promise)
    store.selectMessage('message-1')
    expect(api.setRead).not.toHaveBeenCalled()
    expect(api.get).toHaveBeenCalledExactlyOnceWith({
      accountId: 'mailbox-1',
      expectedEmail: 'reader@example.test',
      folder: 'inbox',
      messageId: 'message-1',
    })
    pending.resolve(detail())
    await flushPromises()
    expect(api.list).toHaveBeenCalledWith({
      accountId: 'mailbox-1',
      expectedEmail: 'reader@example.test',
      folder: 'inbox',
      readState: 'all',
    })
    expect(api.setRead).toHaveBeenCalledExactlyOnceWith({
      accountId: 'mailbox-1',
      expectedEmail: 'reader@example.test',
      folder: 'inbox',
      messageIds: ['message-1'],
      isRead: true,
    })
    expect(store.getSnapshot().detail).toMatchObject({
      body: 'Readable body',
      isRead: true,
    })
    expect(store.getSnapshot().list?.unread).toBe(11)
    expect(changed).toHaveBeenCalledOnce()
  })

  it('never writes for a failed or superseded detail, including a late success after close', async () => {
    const { store, api } = reader()
    await flushPromises()
    api.get.mockRejectedValueOnce(new Error('synthetic-secret'))
    store.selectMessage('message-1')
    await flushPromises()
    expect(api.setRead).not.toHaveBeenCalled()
    expect(store.getSnapshot().detailError).toContain('读取失败')
    const pending = deferred<MailMessageDetail>()
    api.get.mockReturnValueOnce(pending.promise)
    store.refreshDetail()
    store.selectMessage('message-2')
    api.get.mockResolvedValue(detail('message-2', true))
    store.dispose()
    pending.resolve(detail())
    await flushPromises()
    expect(api.setRead).not.toHaveBeenCalled()
  })

  it('keeps readable body and real unread state after a write-only 403 and retries only explicitly', async () => {
    const { store, api, changed } = reader()
    await flushPromises()
    api.setRead.mockRejectedValueOnce(new EmailRequestError('PERMISSION_DENIED'))
    store.selectMessage('message-1')
    await flushPromises()
    expect(store.getSnapshot()).toMatchObject({
      detail: { body: 'Readable body', isRead: false },
      writeError: expect.stringContaining('修改已读状态'),
      writing: false,
    })
    expect(store.getSnapshot().list?.items[0]?.isRead).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    store.refreshDetail()
    await flushPromises()
    expect(api.setRead).toHaveBeenCalledTimes(1)
    await store.markRead(['message-1'], true)
    expect(store.getSnapshot().detail?.isRead).toBe(true)
    expect(store.getSnapshot().writeError).toBeNull()
  })

  it('applies only confirmed successes, retains failed selection and shows safe partial errors', async () => {
    const { store, api } = reader()
    await flushPromises()
    store.selectAll(true)
    api.setRead.mockResolvedValueOnce({
      updatedIds: ['message-1'],
      failures: [{ messageId: 'message-2', code: 'PERMISSION_DENIED' }],
      isRead: true,
    })
    await store.markRead(store.getSnapshot().selectedIds, true)
    expect(store.getSnapshot().list?.items.map((item) => item.isRead)).toEqual([
      true,
      false,
    ])
    expect(store.getSnapshot().selectedIds).toEqual(['message-2'])
    expect(store.getSnapshot().writeError).toContain('1 封未更新')
    expect(store.getSnapshot().writeError).toContain('修改已读状态')
    await store.markRead(['message-1'], false)
    expect(store.getSnapshot().list?.items[0]?.isRead).toBe(false)
    expect(store.getSnapshot().list?.unread).toBe(12)
  })

  it('retains selected detail when a confirmed read removes the row from unread results', async () => {
    const { store } = reader()
    await flushPromises()
    store.setReadState('unread')
    await flushPromises()
    store.selectMessage('message-1')
    await flushPromises()
    expect(store.getSnapshot().list?.items.map((item) => item.id)).toEqual(['message-2'])
    expect(store.getSnapshot().selected?.id).toBe('message-1')
    expect(store.getSnapshot().detail?.body).toBe('Readable body')
    await store.markRead(['message-1'], false)
    expect(store.getSnapshot().detail?.isRead).toBe(false)
  })

  it('does not auto-mark again when a user explicitly marks the open message unread', async () => {
    const { store, api } = reader()
    await flushPromises()
    store.selectMessage('message-1')
    await flushPromises()
    await store.markRead(['message-1'], false)
    store.refreshDetail()
    await flushPromises()
    expect(api.setRead).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().detail?.isRead).toBe(false)
  })

  it('polls single-flight, preserves detail and checkbox selection, and discards a poll older than a write', async () => {
    vi.useFakeTimers()
    const { store, api } = reader()
    await flushPromises()
    api.get.mockResolvedValueOnce(detail('message-1', true))
    store.selectMessage('message-1')
    store.toggleSelection('message-2', true)
    await flushPromises()
    const pending = deferred<MailMessagePage>()
    api.list.mockReturnValueOnce(pending.promise)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(api.list).toHaveBeenCalledTimes(2)
    await store.markRead(['message-2'], true)
    pending.resolve(page())
    await flushPromises()
    expect(store.getSnapshot().detail?.body).toBe('Readable body')
    expect(
      store.getSnapshot().list?.items.find((item) => item.id === 'message-2')?.isRead,
    ).toBe(true)
    store.toggleSelection('message-1', true)
    api.list.mockResolvedValueOnce(page({ items: [message({ isRead: true })] }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.getSnapshot().selectedIds).toEqual(['message-1'])
    expect(store.getSnapshot().detail?.id).toBe('message-1')
  })

  it.each(
    ['folder', 'filter', 'page', 'close'].flatMap((scope) =>
      ['success', 'failure'].map((outcome) => ({ scope, outcome })),
    ),
  )(
    'ignores late read-state $outcome after $scope changes',
    async ({ scope, outcome }) => {
      const { store, api, changed } = reader()
      await flushPromises()
      const pending = deferred<MessageReadResult>()
      api.setRead.mockReturnValueOnce(pending.promise)
      const write = store.markRead(['message-1'], true)
      if (scope === 'folder') store.setFolder('junkemail')
      if (scope === 'filter') store.setReadState('read')
      if (scope === 'page') store.nextPage()
      if (scope === 'close') store.dispose()
      if (outcome === 'success')
        pending.resolve({ updatedIds: ['message-1'], failures: [], isRead: true })
      else pending.reject(new Error('refresh_token=synthetic-secret'))
      await write
      expect(changed).not.toHaveBeenCalled()
      expect(store.getSnapshot().detail).toBeNull()
      expect(store.getSnapshot().writeError).toBeNull()
    },
  )

  it('resets cursor, selection and detail with filters and prevents old lists from replacing the newest scope', async () => {
    const { store, api } = reader()
    await flushPromises()
    store.toggleSelection('message-1', true)
    const pending = deferred<MailMessagePage>()
    api.list.mockReturnValueOnce(pending.promise)
    store.refreshList()
    store.nextPage()
    store.setReadState('read')
    store.setFolder('junkemail')
    pending.resolve(page({ items: [message({ subject: 'Obsolete' })] }))
    await flushPromises()
    expect(api.list).toHaveBeenLastCalledWith({
      accountId: 'mailbox-1',
      expectedEmail: 'reader@example.test',
      folder: 'junkemail',
      readState: 'read',
    })
    expect(store.getSnapshot()).toMatchObject({
      page: 1,
      selectedIds: [],
      selected: null,
    })
    expect(store.getSnapshot().list?.items[0]?.subject).not.toBe('Obsolete')
  })

  it('freezes the expected email snapshot and never redirects a reader when the mailbox object changes', async () => {
    const account = mailbox()
    const api = {
      list: vi.fn().mockResolvedValue(page()),
      get: vi.fn().mockResolvedValue(detail()),
      setRead: vi
        .fn()
        .mockResolvedValue({ updatedIds: ['message-1'], failures: [], isRead: true }),
    }
    const store = new EmailReaderStore(account, api)
    readers.push(store)
    account.email = 'other@example.test'
    store.start()
    await flushPromises()
    store.selectMessage('message-1')
    await flushPromises()
    for (const method of [api.list, api.get, api.setRead])
      expect(method.mock.calls[0]?.[0].expectedEmail).toBe('reader@example.test')
  })

  it('ignores a late detail and only auto-marks the newest selection', async () => {
    const { store, api } = reader()
    await flushPromises()
    const old = deferred<MailMessageDetail>()
    api.get.mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail('message-2'))
    store.selectMessage('message-1')
    store.selectMessage('message-2')
    await flushPromises()
    old.resolve(detail('message-1'))
    await flushPromises()
    expect(store.getSnapshot().detail?.id).toBe('message-2')
    expect(api.setRead).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ messageIds: ['message-2'] }),
    )
  })

  it('keeps a newer confirmed unread write when an older detail refresh arrives', async () => {
    const { store, api } = reader()
    await flushPromises()
    store.selectMessage('message-1')
    await flushPromises()
    const old = deferred<MailMessageDetail>()
    api.get.mockReturnValueOnce(old.promise)
    store.refreshDetail()
    await store.markRead(['message-1'], false)
    old.resolve(detail('message-1', true))
    await flushPromises()
    expect(store.getSnapshot().detail?.isRead).toBe(false)
    expect(api.setRead).toHaveBeenCalledTimes(2)
  })

  it('starts a deferred auto-mark for the newest loaded detail after an unrelated bulk write settles', async () => {
    const { store, api } = reader()
    await flushPromises()
    const pending = deferred<MessageReadResult>()
    api.setRead.mockReturnValueOnce(pending.promise)
    const bulk = store.markRead(['message-2'], true)
    store.selectMessage('message-1')
    await flushPromises()
    expect(api.setRead).toHaveBeenCalledTimes(1)
    pending.resolve({ updatedIds: ['message-2'], failures: [], isRead: true })
    await bulk
    await flushPromises()
    expect(api.setRead).toHaveBeenCalledTimes(2)
    expect(api.setRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageIds: ['message-1'] }),
    )
  })

  it('retains working read actions after effect cleanup/setup while rejecting an earlier lifecycle intent', async () => {
    const { store, api } = reader()
    await flushPromises()
    const oldScope = store.getSnapshot().scope
    store.dispose()
    store.start()
    await flushPromises()
    await store.markRead(['message-1'], true, oldScope)
    expect(api.setRead).not.toHaveBeenCalled()
    await store.markRead(['message-1'], true, store.getSnapshot().scope)
    expect(api.setRead).toHaveBeenCalledOnce()
  })
})
