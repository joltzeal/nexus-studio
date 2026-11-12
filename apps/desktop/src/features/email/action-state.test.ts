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
})
