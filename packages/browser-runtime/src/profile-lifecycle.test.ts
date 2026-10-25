import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { BrowserContext } from 'playwright-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchPersistentContext } from 'cloakbrowser'
import { resolveOnlineProxyGeo } from './online-proxy-geo.js'
import * as runtime from './profile-runtime.js'
import type { NativeProfile } from './profile-runtime.js'

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
let profile: NativeProfile
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
  profile = {
    schema_version: 1,
    id: 'profile',
    binary_path: binary,
    binding: { profile_id: 'profile', channel_version: '155.0.8059.39.2' },
    proxy: 'http://account:p%40ss@proxy.example:8080',
    settings: {
      platform: '',
      note: '',
      geoip: true,
      timezone: '',
      locale: '',
      viewport: 'default',
      fingerprintSeed: null,
      startUrl: 'https://start.example',
    },
  }
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
    profile.settings!.startUrl = 'https://start.example/private?session=do-not-log'
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
    profile.binding.channel_version = '155.0.8059.39.3'
    await expect(
      runtime.openProfile(join(directory, 'user-data'), profile, commands()),
    ).rejects.toThrow('PROFILE_ENGINE_MISMATCH')
    expect(launchPersistentContext).not.toHaveBeenCalled()
    expect(output).toBe('')
  })

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
