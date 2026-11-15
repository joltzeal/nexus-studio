import { describe, expect, it } from 'vitest'
import { deferred, flushPromises } from '@/features/settings/kernel-test-support'
import { EmailAction } from './action-state'

describe('email write lifecycle', () => {
  it('prevents duplicate writes and preserves the dialog after failure with a safe error', async () => {
    const pending = deferred<string>()
    const action = new EmailAction('邮箱保存失败，请重试。')
    action.start()
    let calls = 0
    let committed = ''
    const write = () => {
      calls += 1
      return pending.promise
    }
    void action.run(write, (value) => {
      committed = value
    })
    void action.run(write, () => {
      committed = 'duplicate'
    })
    expect(calls).toBe(1)
    expect(action.getSnapshot().busy).toBe(true)
    pending.reject(new Error('password=synthetic-secret'))
    await flushPromises()
    expect(committed).toBe('')
    expect(action.getSnapshot()).toEqual({ busy: false, error: '邮箱保存失败，请重试。' })
    await action.run(
      async () => 'saved',
      (value) => {
        committed = value
      },
    )
    expect(committed).toBe('saved')
    expect(action.getSnapshot().error).toBeNull()
    action.dispose()
  })

  it.each(['success', 'failure'])(
    'ignores a late write %s after closing or replacing the plugin',
    async (outcome) => {
      const pending = deferred<string>()
      const action = new EmailAction('失败')
      action.start()
      let saved = false
      void action.run(
        () => pending.promise,
        () => {
          saved = true
        },
      )
      action.dispose()
      const snapshot = action.getSnapshot()
      if (outcome === 'success') pending.resolve('old process')
      else pending.reject(new Error('old failure'))
      await flushPromises()
      expect(saved).toBe(false)
      expect(action.getSnapshot()).toBe(snapshot)
    },
  )

  it.each(['success', 'failure'])(
    'reconciles a %s settled while hidden before allowing another physical write',
    async (outcome) => {
      const pending = deferred<string>()
      const action = new EmailAction('排队失败，请核对后重试。')
      action.start()
      let writes = 0
      const receipts: string[] = []
      const write = () => {
        writes += 1
        return pending.promise
      }
      void action.run(write, (receipt) => receipts.push(receipt))
      action.dispose()
      const hiddenSnapshot = action.getSnapshot()
      if (outcome === 'success') pending.resolve('persisted queue receipt')
      else pending.reject(new Error('refresh_token=synthetic-secret'))
      await flushPromises()
      expect(action.getSnapshot()).toBe(hiddenSnapshot)
      expect(receipts).toEqual([])
      await action.run(write, (receipt) => receipts.push(receipt))
      expect(writes).toBe(1)

      action.start()
      expect(action.getSnapshot()).toEqual({
        busy: false,
        error: outcome === 'failure' ? '排队失败，请核对后重试。' : null,
      })
      expect(receipts).toEqual(outcome === 'success' ? ['persisted queue receipt'] : [])
      action.start()
      expect(receipts).toHaveLength(outcome === 'success' ? 1 : 0)
      await action.run(
        async () => {
          expect(action.getSnapshot().busy).toBe(true)
          writes += 1
          return 'next explicit receipt'
        },
        (receipt) => receipts.push(receipt),
      )
      expect(writes).toBe(2)
      expect(receipts[receipts.length - 1]).toBe('next explicit receipt')
      action.dispose()
    },
  )

  it.each(['success', 'failure'])(
    'retains single flight when shown before a hidden %s settles',
    async (outcome) => {
      const pending = deferred<string>()
      const action = new EmailAction('排队失败，请核对后重试。')
      action.start()
      let writes = 0
      const receipts: string[] = []
      const write = () => {
        writes += 1
        return pending.promise
      }
      void action.run(write, (receipt) => receipts.push(receipt))
      action.dispose()
      action.start()
      await action.run(write, (receipt) => receipts.push(receipt))
      expect(action.getSnapshot().busy).toBe(true)
      expect(writes).toBe(1)
      if (outcome === 'success') pending.resolve('persisted queue receipt')
      else pending.reject(new Error('private upstream response'))
      await flushPromises()
      expect(action.getSnapshot()).toEqual({
        busy: false,
        error: outcome === 'failure' ? '排队失败，请核对后重试。' : null,
      })
      expect(receipts).toEqual(outcome === 'success' ? ['persisted queue receipt'] : [])
      action.dispose()
    },
  )
})
