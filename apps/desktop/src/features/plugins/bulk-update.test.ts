import { describe, expect, it } from 'vitest'
import type { MarketEntry, PluginView } from '@/lib/platform/native-plugins'
import { installPendingUpdates, pendingPluginUpdates } from './bulk-update'

const entry = (id: string, state: MarketEntry['state']) => ({ id, state }) as MarketEntry
const plugin = (id: string, state: PluginView['state']) => ({ id, state }) as PluginView

describe('pendingPluginUpdates', () => {
  it('selects only updates for installed plugins, not new installs or current versions', () => {
    expect(
      pendingPluginUpdates(
        [
          entry('new', 'install'),
          entry('stale', 'update'),
          entry('current', 'current'),
          entry('unavailable', 'update'),
          entry('paid', 'update'),
        ],
        [
          plugin('stale', 'retrying'),
          plugin('current', 'running'),
          plugin('unavailable', 'available'),
          plugin('paid', 'unlicensed'),
        ],
        new Set(['stale']),
      ).map((row) => row.id),
    ).toEqual(['stale'])
  })
})

describe('installPendingUpdates', () => {
  it('continues after a failed update and reports progress and failures', async () => {
    const attempted: string[] = []
    const progress: string[] = []
    const result = await installPendingUpdates(
      [entry('one', 'update'), entry('two', 'update'), entry('three', 'update')],
      async (id) => {
        attempted.push(id)
        if (id === 'two') throw new Error('download failed')
      },
      (row, index, total) => progress.push(`${index}/${total}:${row.id}`),
    )
    expect(attempted).toEqual(['one', 'two', 'three'])
    expect(progress).toEqual(['1/3:one', '2/3:two', '3/3:three'])
    expect(result.updated).toBe(2)
    expect(result.failures.map((failure) => failure.entry.id)).toEqual(['two'])
  })
})
