import { resolve } from 'node:path'
import { inspectKernelCache } from '../src/kernel-cache.js'
import type { RuntimeWindow } from '../src/profile-runtime.js'

export function runtimeWindow(overrides: Partial<RuntimeWindow> = {}): RuntimeWindow {
  return {
    schema_version: 2,
    id: 'f2d6a163-f605-4e91-a33f-f775e464e950',
    name: 'Synthetic runtime window',
    binding: {
      provider_id: 'cloakbrowser',
      connection_id: 'builtin-cloakbrowser',
      profile_id: 'f2d6a163-f605-4e91-a33f-f775e464e950',
    },
    kernel_version: '155.0.8059.39.2',
    binary_path: '/synthetic/chromium-155.0.8059.39.2-pro/chrome',
    proxy: null,
    proxy_plugin: null,
    proxy_endpoint: null,
    proxy_mode: 'direct',
    settings: {
      platform: '',
      note: '',
      geoip: true,
      timezone: '',
      locale: '',
      viewport: 'default',
      fingerprintSeed: 123456789,
      startUrl: '',
    },
    origin: 'created',
    provider_config: {},
    created_at: 1_794_268_800,
    last_opened_at: null,
    sort_order: 1,
    ...overrides,
  }
}

export async function installedRuntimeWindow(
  binaryPath: string,
  cacheDir: string,
): Promise<RuntimeWindow> {
  const inventory = await inspectKernelCache(cacheDir)
  const kernel = inventory.installed.find(
    (entry) => resolve(entry.binaryPath) === resolve(binaryPath),
  )
  if (!kernel) throw new Error('Test binary must belong to the managed kernel cache')
  return runtimeWindow({
    binary_path: binaryPath,
    kernel_version: kernel.version,
  })
}
