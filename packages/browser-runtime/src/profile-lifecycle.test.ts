import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { BrowserContext } from 'playwright-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureBinary, launchPersistentContext } from 'cloakbrowser'
import { runtimeWindow } from '../fixtures/runtime-window.js'
import { resolveOnlineProxyGeo } from './online-proxy-geo.js'
import * as runtime from './profile-runtime.js'
import type { RuntimeWindow } from './profile-runtime.js'

vi.mock('cloakbrowser', () => ({
  launchPersistentContext: vi.fn(),
  ensureBinary: vi.fn(),
  validateLicense: vi.fn(),
}))

vi.mock('./online-proxy-geo.js', () => ({ resolveOnlineProxyGeo: vi.fn() }))

vi.mock('./stored-origins.js', () => ({
  initializeStoredOrigins: vi.fn(async () => new Map()),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class ContextDouble extends EventEmitter {
  events: string[] = []
  navigation = deferred<void>()
  navigationOptions: { timeout?: number; waitUntil?: string } | undefined
  offline = false
  storageFailure: Error | undefined
  restoreGate: ReturnType<typeof deferred<void>> | undefined
  restoreFailure: Error | undefined
  closed = false
  captureOptions: unknown
  state = { cookies: [], origins: [] }

  pages() {
    return [
      {
        goto: (_url: string, options?: { timeout?: number; waitUntil?: string }) => {
          this.events.push('navigate')
          this.navigationOptions = options
          return this.navigation.promise
        },
      },
    ]
  }

  async route() {
    this.events.push('block-network')
  }

  async setOffline(offline: boolean) {
    this.offline = offline
    if (!offline) this.events.push('online')
  }

  async storageState(options: unknown) {
    this.captureOptions = options
    if (this.storageFailure) throw this.storageFailure
    return this.state
  }

  async setStorageState() {
    this.events.push('restore')
    if (this.restoreFailure) throw this.restoreFailure
    if (this.restoreGate) await this.restoreGate.promise
  }

  async close() {
    this.closed = true
    this.events.push('close')
    this.navigation.reject(new Error('Target closed'))
    this.emit('close')
  }

  asContext(): BrowserContext {
    return this as unknown as BrowserContext
  }
}

let directory: string
let profile: RuntimeWindow
let context: ContextDouble
let stop: ReturnType<typeof deferred<void>>
let running: Promise<unknown> | undefined
let output: string
let diagnostics: string

async function* commands() {
  await stop.promise
  yield 'stop'
}

beforeEach(async () => {
  vi.stubEnv('CLOAKBROWSER_BINARY_PATH', process.env.CLOAKBROWSER_BINARY_PATH)
  directory = await mkdtemp(join(tmpdir(), 'nexus-profile-lifecycle-'))
  vi.stubEnv('CLOAKBROWSER_CACHE_DIR', directory)
  vi.stubEnv('CLOAKBROWSER_LICENSE_KEY', 'synthetic-lifecycle-key')
  const binary = join(
    directory,
    'chromium-155.0.8059.39.2-pro',
    process.platform === 'darwin'
      ? 'Chromium.app/Contents/MacOS/Chromium'
      : process.platform === 'win32'
        ? 'chrome.exe'
        : 'chrome',
  )
  await mkdir(dirname(binary), { recursive: true })
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdout.write('CloakBrowser 155.0.8059.39.2\\n')\n`,
    { mode: 0o700 },
  )
  profile = runtimeWindow({
    binary_path: binary,
    proxy: 'http://account:p%40ss@proxy.example:8080',
    proxy_mode: 'manual',
    settings: {
      platform: '',
      note: '',
      geoip: true,
      timezone: '',
      locale: '',
      viewport: 'default',
      fingerprintSeed: 123456789,
      startUrl: 'https://start.example',
    },
  })
  context = new ContextDouble()
  // The pending navigation is deliberate; consume rejections in tests that never navigate.
  void context.navigation.promise.catch(() => {})
  stop = deferred<void>()
  output = ''
  diagnostics = ''
  running = undefined
  vi.mocked(launchPersistentContext)
    .mockReset()
    .mockImplementation(async (options) => {
      context.offline = options.contextOptions?.offline ?? false
      return context.asContext()
    })
  vi.mocked(resolveOnlineProxyGeo).mockReset().mockResolvedValue({
    ip: '81.2.69.160',
    timezone: 'Europe/London',
    locale: 'en-GB',
  })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    diagnostics += String(chunk)
    return true
  })
})

afterEach(async () => {
  context.navigation.resolve()
  context.restoreGate?.resolve()
  stop.resolve()
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync()
  if (running) await running.catch(() => {})
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe('profile context lifecycle', () => {
  it.each(['launch', 'snapshot'])(
    'uses only the persisted package, binary and fingerprint after reloading a window for %s',
    async (action) => {
      const path = join(directory, 'window.json')
      await writeFile(path, JSON.stringify(profile))
      const record = JSON.parse(await readFile(path, 'utf8')) as RuntimeWindow
      await writeFile(
        profile.binary_path,
        `#!${process.execPath}\nconsole.log('Chromium 155.0.8059.39')\n`,
      )
      const other = profile.binary_path.replace('155.0.8059.39.2', '155.0.8059.39.3')
      await mkdir(dirname(other), { recursive: true })
      await writeFile(other, '#!/bin/sh\nexit 42\n', { mode: 0o700 })
      vi.stubEnv('CLOAKBROWSER_BINARY_PATH', other)
      vi.stubEnv('CLOAKBROWSER_VERSION', '155.0.8059.39.3')
      for (let attempt = 0; attempt < 2; attempt++) {
        if (action === 'snapshot') {
          await runtime.snapshotProfile(join(directory, 'user-data'), record)
        } else {
          stop.resolve()
          await runtime.openProfile(join(directory, 'user-data'), record, commands())
        }
      }
      expect(launchPersistentContext).toHaveBeenCalledTimes(2)
      for (const [options] of vi.mocked(launchPersistentContext).mock.calls) {
        expect(options.browserVersion).toBe('155.0.8059.39.2')
        expect(options.args).toContain('--fingerprint=123456789')
        expect(options.launchOptions?.executablePath).toBe(record.binary_path)
      }
      expect(process.env.CLOAKBROWSER_BINARY_PATH).toBe(record.binary_path)
      expect(ensureBinary).not.toHaveBeenCalled()
      expect(record).toEqual(profile)
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify(profile))
    },
  )

  it('launches the resolved proxy URL without changing its opaque plugin reference or numeric endpoint', async () => {
    profile.proxy_mode = 'plugin'
    profile.proxy_plugin = 'opaque/plugin-ref:v2'
    profile.proxy_endpoint = 37
    const original = structuredClone(profile)
    stop.resolve()
    await runtime.openProfile(join(directory, 'user-data'), profile, commands())
    expect(vi.mocked(launchPersistentContext).mock.calls[0]![0].proxy).toBe(
      original.proxy,
    )
    expect(profile).toEqual(original)
    expect(output).toBe('NEXUS_READY\n')
    expect(diagnostics).not.toContain('p%40ss')
  })

  it('blocks an unresolved plugin proxy without a direct launch or online request', async () => {
    profile.proxy_mode = 'plugin'
    profile.proxy = null
    profile.proxy_plugin = 'opaque/plugin-ref:v2'
    profile.proxy_endpoint = 37
    const original = structuredClone(profile)
    await expect(
      runtime.openProfile(join(directory, 'user-data'), profile, commands()),
    ).rejects.toThrow('PROFILE_PROXY_MISSING')
    expect(profile).toEqual(original)
    expect(launchPersistentContext).not.toHaveBeenCalled()
    expect(resolveOnlineProxyGeo).not.toHaveBeenCalled()
    expect(output).toBe('')
  })

  it.each(['launch', 'snapshot'])(
    'rejects a missing bound binary before %s even when another revision is installed',
    async (action) => {
      const other = profile.binary_path.replace('155.0.8059.39.2', '155.0.8059.39.3')
      await mkdir(dirname(other), { recursive: true })
      await writeFile(other, '#!/bin/sh\nexit 42\n', { mode: 0o700 })
      await rm(profile.binary_path)
      await expect(
        action === 'snapshot'
          ? runtime.snapshotProfile(join(directory, 'user-data'), profile)
          : runtime.openProfile(join(directory, 'user-data'), profile, commands()),
      ).rejects.toThrow('PROFILE_ENGINE_UNSUPPORTED')
      expect(launchPersistentContext).not.toHaveBeenCalled()
      expect(ensureBinary).not.toHaveBeenCalled()
      expect(output).toBe('')
    },
  )

  it.each(['launch', 'snapshot'])(
    'rejects a different full package revision with the same display version before %s',
    async (action) => {
      await writeFile(
        profile.binary_path,
        `#!${process.execPath}\nconsole.log('Chromium 155.0.8059.39')\n`,
      )
      profile.kernel_version = '155.0.8059.39.3'
      await expect(
        action === 'snapshot'
          ? runtime.snapshotProfile(join(directory, 'user-data'), profile)
          : runtime.openProfile(join(directory, 'user-data'), profile, commands()),
      ).rejects.toThrow('PROFILE_ENGINE_MISMATCH')
      expect(launchPersistentContext).not.toHaveBeenCalled()
      expect(ensureBinary).not.toHaveBeenCalled()
      expect(output).toBe('')
    },
  )

  it.each(['launch', 'snapshot'])(
    'rejects the old schema before %s without reading its binary or calling the SDK',
    async (action) => {
      const record = {
        schema_version: 1,
        id: profile.id,
        binary_path: profile.binary_path,
        binding: {
          profile_id: profile.id,
          channel_version: '155.0.8059.39.2',
        },
        proxy: null,
      } as unknown as RuntimeWindow
      vi.stubEnv('CLOAKBROWSER_LICENSE_KEY', '')
      await expect(
        action === 'snapshot'
          ? runtime.snapshotProfile(join(directory, 'user-data'), record)
          : runtime.openProfile(join(directory, 'user-data'), record, commands()),
      ).rejects.toThrow('PROFILE_RECORD_INVALID')
      expect(launchPersistentContext).not.toHaveBeenCalled()
      expect(resolveOnlineProxyGeo).not.toHaveBeenCalled()
      expect(output).toBe('')
    },
  )

  it.each([
    ['schema', { schema_version: 1 }],
    ['provider', { binding: { ...runtimeWindow().binding, provider_id: 'adspower' } }],
    ['connection', { binding: { ...runtimeWindow().binding, connection_id: 'other' } }],
    ['profile ID', { binding: { ...runtimeWindow().binding, profile_id: 'profile' } }],
    [
      'another profile ID',
      {
        binding: {
          ...runtimeWindow().binding,
          profile_id: '6cd8605b-ad6f-44e3-951a-110380c34483',
        },
      },
    ],
    [
      'channel binding',
      { binding: { profile_id: runtimeWindow().id, channel_version: '155.0.8059.39.2' } },
    ],
    [
      'extra channel binding',
      { binding: { ...runtimeWindow().binding, channel_version: '155.0.8059.39.2' } },
    ],
    ['missing kernel', { kernel_version: undefined }],
    ['null kernel', { kernel_version: null }],
    ['short kernel', { kernel_version: '155' }],
    ['legacy kernel', { kernel_version: 'cloak:155.0.8059.39.2' }],
    ['missing binary', { binary_path: undefined }],
    ['null binary', { binary_path: null }],
    ['relative binary', { binary_path: basename(runtimeWindow().binary_path) }],
    ['missing settings', { settings: undefined }],
    ['null settings', { settings: null }],
    [
      'missing seed',
      { settings: { ...runtimeWindow().settings, fingerprintSeed: undefined } },
    ],
    ['null seed', { settings: { ...runtimeWindow().settings, fingerprintSeed: null } }],
    ['zero seed', { settings: { ...runtimeWindow().settings, fingerprintSeed: 0 } }],
    [
      'fractional seed',
      { settings: { ...runtimeWindow().settings, fingerprintSeed: 1.5 } },
    ],
    [
      'out of range seed',
      { settings: { ...runtimeWindow().settings, fingerprintSeed: 2_147_483_648 } },
    ],
    [
      'snake case settings',
      { settings: { ...runtimeWindow().settings, fingerprint_seed: 42 } },
    ],
    ['provider proxy', { proxy_mode: 'provider' }],
    ['unknown proxy', { proxy_mode: 'automatic' }],
    ['missing proxy mode', { proxy_mode: undefined }],
    ['direct proxy mismatch', { proxy_mode: 'direct' }],
    ['missing plugin reference', { proxy_mode: 'plugin' }],
    ['invalid provider config', { provider_config: [] }],
    ['missing metadata', { created_at: undefined }],
    ['unknown record field', { version: '155.0.8059.39' }],
  ])(
    'rejects an invalid version 2 %s without launch side effects',
    async (_name, overrides) => {
      const record = { ...profile, ...overrides } as RuntimeWindow
      vi.stubEnv('CLOAKBROWSER_LICENSE_KEY', '')
      await expect(
        runtime.openProfile(join(directory, 'user-data'), record, commands()),
      ).rejects.toThrow('PROFILE_RECORD_INVALID')
      expect(launchPersistentContext).not.toHaveBeenCalled()
      expect(resolveOnlineProxyGeo).not.toHaveBeenCalled()
      expect(output).toBe('')
    },
  )

  it('waits for portable restoration before readiness or remote navigation', async () => {
    const path = join(directory, 'portable-state.json')
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        storageState: { cookies: [], origins: [] },
      }),
    )
    context.restoreGate = deferred<void>()
    running = runtime.openProfile(join(directory, 'user-data'), profile, commands())
    await vi.waitFor(() => expect(context.events).toContain('restore'))
    expect(context.offline).toBe(true)
    expect(output).toBe('')
    expect(context.events).not.toContain('navigate')
    context.restoreGate.resolve()
    await vi.waitFor(() => expect(output).toBe('NEXUS_READY\n'))
    expect(context.offline).toBe(false)
    expect(context.events.indexOf('online')).toBeGreaterThan(
      context.events.indexOf('restore'),
    )
    expect(context.events.indexOf('navigate')).toBeGreaterThan(
      context.events.indexOf('online'),
    )
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    stop.resolve()
    await running
  })

  it('closes the context and retains the sidecar when restoration fails', async () => {
    const path = join(directory, 'portable-state.json')
    const bytes = JSON.stringify({
      schemaVersion: 1,
      storageState: { cookies: [], origins: [] },
    })
    await writeFile(path, bytes)
    context.restoreFailure = new Error('Unable to restore IndexedDB')
    await expect(
      runtime.openProfile(join(directory, 'user-data'), profile, commands()),
    ).rejects.toThrow('PORTABLE_STATE_RESTORE_FAILED')
    expect(context.closed).toBe(true)
    expect(context.offline).toBe(true)
    expect(context.events).not.toContain('online')
    expect(context.events).not.toContain('navigate')
    expect(output).toBe('')
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it('announces the real context and accepts stop while the remote start page is pending', async () => {
    running = runtime.openProfile(join(directory, 'user-data'), profile, commands())
    await vi.waitFor(() => expect(output).toBe('NEXUS_READY\n'), { timeout: 500 })
    expect(context.closed).toBe(false)
    expect(context.navigationOptions).toEqual({
      timeout: 30_000,
      waitUntil: 'domcontentloaded',
    })
    stop.resolve()
    await running
    expect(context.closed).toBe(true)
    const options = vi.mocked(launchPersistentContext).mock.calls[0]![0]
    expect(options.proxy).toBe('http://account:p%40ss@proxy.example:8080')
    expect(resolveOnlineProxyGeo).toHaveBeenCalled()
    expect(options.geoip).toBe(false)
    expect(options.browserVersion).toBe('155.0.8059.39.2')
    expect(options.licenseKey).toBe('synthetic-lifecycle-key')
  })

  it('keeps a healthy context usable after start-page timeout and redacts navigation secrets', async () => {
    profile.settings.startUrl = 'https://start.example/private?session=do-not-log'
    running = runtime.openProfile(join(directory, 'user-data'), profile, commands())
    await vi.waitFor(() => expect(context.events).toContain('navigate'))
    context.navigation.reject(
      new Error('Timed out at https://start.example/private?session=do-not-log'),
    )
    await vi.waitFor(() => expect(diagnostics).toContain('PROFILE_START_URL_FAILED'))
    expect(output).toBe('NEXUS_READY\n')
    expect(context.closed).toBe(false)
    expect(diagnostics).not.toContain('do-not-log')
    stop.resolve()
    await running
    expect(context.closed).toBe(true)
  })

  it('does not leave the runner waiting for stdin after the browser closes itself', async () => {
    context.navigation.resolve()
    running = runtime.openProfile(join(directory, 'user-data'), profile, commands())
    await vi.waitFor(() => expect(output).toBe('NEXUS_READY\n'), { timeout: 500 })
    await context.close()
    let finished = false
    void running.then(() => {
      finished = true
    })
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 300 })
  })

  it('fails a stalled SDK launch within a deadline and closes a late context', async () => {
    vi.useFakeTimers()
    const launch = deferred<BrowserContext>()
    vi.mocked(launchPersistentContext).mockReturnValue(launch.promise)
    running = runtime.openProfile(join(directory, 'user-data'), profile, commands())
    const result = expect(running).rejects.toThrow('PROFILE_LAUNCH_TIMEOUT')
    await vi.waitFor(() => expect(launchPersistentContext).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(60_000)
    await result
    expect(output).toBe('')
    launch.resolve(context.asContext())
    await vi.waitFor(() => expect(context.closed).toBe(true))
  })

  it('aborts an SDK network request when launch exceeds its deadline', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        signal = init?.signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }),
    )
    vi.mocked(launchPersistentContext).mockImplementation(async () => {
      await fetch('https://service.example/request')
      return context.asContext()
    })
    running = runtime.openProfile(join(directory, 'user-data'), profile, commands())
    const result = expect(running).rejects.toThrow('PROFILE_LAUNCH_TIMEOUT')
    await vi.waitFor(() => expect(signal).toBeDefined())
    await vi.advanceTimersByTimeAsync(60_000)
    await result
    expect(signal?.aborted).toBe(true)
    expect(output).toBe('')
  })

  it('cancels an SDK background network request after the browser closes', async () => {
    let signal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        signal = init?.signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }),
    )
    vi.mocked(launchPersistentContext).mockImplementation(async () => {
      void fetch('https://service.example/background-refresh').catch(() => {})
      return context.asContext()
    })
    running = runtime.openProfile(join(directory, 'user-data'), profile, commands())
    await vi.waitFor(() => expect(output).toBe('NEXUS_READY\n'))
    expect(signal?.aborted).toBe(false)
    await context.close()
    await running
    expect(signal?.aborted).toBe(true)
  })

  it('does not launch a different binary version or claim readiness', async () => {
    profile.kernel_version = '155.0.8059.39.3'
    await expect(
      runtime.openProfile(join(directory, 'user-data'), profile, commands()),
    ).rejects.toThrow('PROFILE_ENGINE_MISMATCH')
    expect(launchPersistentContext).not.toHaveBeenCalled()
    expect(output).toBe('')
  })

  it.each(['154.0.8000.10', '155.0.8059.39.3'])(
    'rejects a substituted executable reporting %s at the bound path',
    async (version) => {
      const original = structuredClone(profile)
      await writeFile(
        profile.binary_path,
        `#!${process.execPath}\nconsole.log('Chromium ${version}')\n`,
      )
      await expect(
        runtime.openProfile(join(directory, 'user-data'), profile, commands()),
      ).rejects.toThrow('PROFILE_ENGINE_MISMATCH')
      expect(profile).toEqual(original)
      expect(launchPersistentContext).not.toHaveBeenCalled()
      expect(resolveOnlineProxyGeo).not.toHaveBeenCalled()
      expect(output).toBe('')
    },
  )

  it.each(['launch', 'snapshot'])(
    'requires activation before %s even with a cached binary',
    async (action) => {
      vi.stubEnv('CLOAKBROWSER_LICENSE_KEY', '')
      await expect(
        action === 'launch'
          ? runtime.openProfile(join(directory, 'user-data'), profile, commands())
          : runtime.snapshotProfile(join(directory, 'user-data'), profile),
      ).rejects.toThrow('ACTIVATION_REQUIRED')
      expect(launchPersistentContext).not.toHaveBeenCalled()
      expect(resolveOnlineProxyGeo).not.toHaveBeenCalled()
      expect(output).toBe('')
    },
  )

  it.each(['launch', 'snapshot'])(
    'rejects an unmanaged binary before %s without rebinding the profile',
    async (action) => {
      const binary = profile.binary_path.replace('-pro', '')
      await mkdir(dirname(binary), { recursive: true })
      await writeFile(binary, '#!/bin/sh\nexit 42\n', { mode: 0o700 })
      profile.binary_path = binary
      const original = structuredClone(profile)
      await expect(
        action === 'launch'
          ? runtime.openProfile(join(directory, 'user-data'), profile, commands())
          : runtime.snapshotProfile(join(directory, 'user-data'), profile),
      ).rejects.toThrow('PROFILE_ENGINE_UNSUPPORTED')
      expect(launchPersistentContext).not.toHaveBeenCalled()
      expect(profile).toEqual(original)
      expect(output).toBe('')
    },
  )
})

describe('portable snapshot lifecycle', () => {
  it('snapshots an unresolved plugin proxy offline and preserves its numeric endpoint', async () => {
    profile.proxy_mode = 'plugin'
    profile.proxy = null
    profile.proxy_plugin = 'opaque/plugin-ref:v2'
    profile.proxy_endpoint = 37
    const original = structuredClone(profile)
    await runtime.snapshotProfile(join(directory, 'user-data'), profile)
    const options = vi.mocked(launchPersistentContext).mock.calls[0]![0]
    expect(options.proxy).toBeUndefined()
    expect(options.geoip).toBe(false)
    expect(options.args).toContain('--fingerprint=123456789')
    expect(resolveOnlineProxyGeo).not.toHaveBeenCalled()
    expect(profile).toEqual(original)
    expect(output).toBe('')
  })

  it('recaptures a not-yet-opened imported profile without consuming its pending state', async () => {
    const path = join(directory, 'portable-state.json')
    const bytes = JSON.stringify({
      schemaVersion: 1,
      storageState: { cookies: [], origins: [] },
    })
    await writeFile(path, bytes)
    await runtime.snapshotProfile(join(directory, 'user-data'), profile)
    expect(context.events).toEqual(['block-network', 'restore', 'close'])
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it('captures decrypted storage offline with the pinned headless engine and closes before returning', async () => {
    const state = await runtime.snapshotProfile(join(directory, 'user-data'), profile)
    expect(state).toEqual({
      schemaVersion: 1,
      storageState: { cookies: [], origins: [] },
    })
    expect(context.captureOptions).toEqual({ indexedDB: true, opfs: true })
    expect(context.events).toEqual(['block-network', 'close'])
    expect(context.offline).toBe(true)
    expect(context.closed).toBe(true)
    expect(vi.mocked(launchPersistentContext).mock.calls[0]![0]).toMatchObject({
      headless: true,
      geoip: false,
      browserVersion: '155.0.8059.39.2',
      contextOptions: { serviceWorkers: 'block' },
    })
    expect(output).toBe('')
  })

  it('closes the snapshot browser even when IndexedDB serialization fails', async () => {
    context.storageFailure = new Error('Unable to serialize IndexedDB')
    await expect(
      runtime.snapshotProfile(join(directory, 'user-data'), profile),
    ).rejects.toThrow('Unable to serialize IndexedDB')
    expect(context.closed).toBe(true)
    expect(output).toBe('')
  })
})
