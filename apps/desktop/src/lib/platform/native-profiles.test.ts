import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { createNativeProfile, type WindowSettings } from './native-profiles'
import type { KernelSelection } from './native-kernels'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

const settings: WindowSettings = {
  platform: 'Vinted',
  note: '',
  geoip: true,
  timezone: '',
  locale: '',
  viewport: 'default',
  fingerprintSeed: 123,
  startUrl: '',
}

beforeEach(() => vi.resetAllMocks())

describe('window kernel selection contract', () => {
  it('explicitly defaults new windows to the base kernel', async () => {
    await createNativeProfile('Window', null, null, null, settings)

    expect(invoke).toHaveBeenCalledExactlyOnceWith('profile_create', {
      name: 'Window',
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      settings,
      kernelKind: 'base',
      browserVersion: null,
      groupId: null,
    })
  })

  it.each<KernelSelection>([
    { kind: 'base', version: '145.0.7632.109.2' },
    { kind: 'latest' },
    { kind: 'latest', version: '155.0.8059.39.1' },
  ])(
    'forwards the chosen kernel without changing proxy or group binding: %j',
    async (kernel) => {
      await createNativeProfile(
        'Window',
        null,
        'studio.proxy-pool',
        7,
        settings,
        kernel,
        'group-1',
      )

      expect(invoke).toHaveBeenCalledExactlyOnceWith('profile_create', {
        name: 'Window',
        proxy: null,
        proxyPlugin: 'studio.proxy-pool',
        proxyEndpoint: 7,
        settings,
        kernelKind: kernel.kind,
        browserVersion: kernel.version ?? null,
        groupId: 'group-1',
      })
    },
  )
})
