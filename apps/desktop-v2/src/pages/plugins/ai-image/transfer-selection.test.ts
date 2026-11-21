import { describe, expect, it, vi } from 'vitest'
import { transferSelection } from './transfer-selection'

const entries = [{ key: 'first' }, { key: 'second' }, { key: 'third' }]

describe('selected reference transfer queue', () => {
  it('does not start a queue whose page is already closed', async () => {
    const transfer = vi.fn(async () => undefined)
    await transferSelection(
      entries,
      () => false,
      () => true,
      transfer,
    )
    expect(transfer).not.toHaveBeenCalled()
  })

  it('stops after the pending upload settles when its page closes', async () => {
    let active = true
    let complete: (() => void) | undefined
    const transfer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
    )
    const running = transferSelection(
      entries,
      () => active,
      () => true,
      transfer,
    )
    expect(transfer).toHaveBeenCalledExactlyOnceWith(entries[0])
    active = false
    complete!()
    await running
    expect(transfer).toHaveBeenCalledTimes(1)
  })

  it('skips removed queued images without dropping the remaining selection', async () => {
    const selected = new Set(entries.map((entry) => entry.key))
    let complete: (() => void) | undefined
    const transfer = vi.fn(async (entry: { key: string }) => {
      if (entry.key === 'first')
        await new Promise<void>((resolve) => {
          complete = resolve
        })
    })
    const running = transferSelection(
      entries,
      () => true,
      (key) => selected.has(key),
      transfer,
    )
    selected.delete('second')
    complete!()
    await running
    expect(transfer.mock.calls.map(([entry]) => entry.key)).toEqual(['first', 'third'])
  })
})
