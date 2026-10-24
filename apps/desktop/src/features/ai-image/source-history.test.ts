import { describe, expect, it } from 'vitest'
import type { PluginView } from '@/lib/platform/native-plugins'
import { sourceHistoryAvailability } from './source-history'

function plugin(state: PluginView['state'], enabled = true): PluginView {
  return {
    id: 'studio.ai-image',
    name: 'AI image',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
    capabilities: ['image.provider'],
    granted: ['image.provider'],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state,
    enabled,
    methods: [],
    status: null,
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
  }
}

describe('source history plugin gate', () => {
  it('requires a real desktop host and an installed, enabled, running AI plugin', () => {
    expect(sourceHistoryAvailability(false, [plugin('running')])).toBe('desktop')
    expect(sourceHistoryAvailability(true, [])).toBe('missing')
    expect(sourceHistoryAvailability(true, [plugin('available')])).toBe('missing')
    expect(sourceHistoryAvailability(true, [plugin('running', false)])).toBe('disabled')
    expect(sourceHistoryAvailability(true, [plugin('starting')])).toBe('starting')
    expect(sourceHistoryAvailability(true, [plugin('retrying')])).toBe('starting')
    expect(
      sourceHistoryAvailability(true, [
        { ...plugin('running'), id: 'studio.vinted-monitor' },
      ]),
    ).toBe('missing')
    expect(sourceHistoryAvailability(true, [plugin('running')])).toBe('ready')
  })
})
