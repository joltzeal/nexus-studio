import type { UiClock } from './ui-clock.ts'
import type { PluginView } from './types.ts'

export class TestClock implements UiClock {
  time = 1000
  private sequence = 0
  private timers = new Map<number, { at: number; callback: () => void }>()
  now = () => this.time
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.sequence
    this.timers.set(id, { at: this.time + delay, callback })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout = (id: ReturnType<typeof setTimeout>) => {
    this.timers.delete(id as unknown as number)
  }
  advance(ms: number) {
    const end = this.time + ms
    while (true) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
    }
    this.time = end
  }
}

export const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

export const runtimePlugin: PluginView = {
  id: 'example.plugin',
  name: 'Example',
  version: '1',
  apiVersion: 1,
  minCoreVersion: '0.2',
  capabilities: ['example'],
  granted: ['example'],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
  source: 'test',
  state: 'running',
  enabled: true,
  methods: ['ui.profile.status'],
  status: null,
  lastError: null,
  storageDurable: true,
  secretSlots: [],
  sourceDirectory: null,
  installation: 'install',
  runtimeGeneration: 'process',
  ui: {
    protocolVersion: 1,
    services: [],
    profileTable: {
      title: 'Example',
      viewId: 'profile',
      capability: 'example',
      icon: { viewBox: '0 0 24 24', paths: ['M0 0'] },
    },
  },
}
