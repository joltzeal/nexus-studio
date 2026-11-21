import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeWorkspace, type NativeApi } from './controller.ts'
import type { BrowserConnection, BrowserWindow } from '@nexus/contracts/browser'

const capabilities = {
  create: true,
  update: true,
  deleteEnvironment: true,
  attach: false,
  manualProxy: true,
  proxyPlugin: true,
  geoip: true,
  fingerprintSeed: true,
  kernelSelection: true,
  transfer: false,
}
const connection = (
  id = 'builtin-shardbrowser',
  providerId: BrowserConnection['providerId'] = 'shardbrowser',
): BrowserConnection => ({
  id,
  providerId,
  name: id,
  endpoint: '',
  apiKey: null,
  defaultGroupId: null,
  scopeLabel: '',
  scopeId: id,
  scopeConfirmed: true,
  enabled: true,
  revision: 1,
  capabilities,
})
const record = (
  connectionId = 'builtin-shardbrowser',
  state: BrowserWindow['state'] = 'stopped',
): BrowserWindow => ({
  id: 'profile-1',
  name: 'Profile 1',
  providerId: 'shardbrowser',
  connectionId,
  providerProfileId: 'profile-1',
  origin: 'created',
  state,
  version: '152.0.0.1',
  kernelVersion: '152.0.0.1',
  proxy: null,
  proxyPlugin: null,
  proxyEndpoint: null,
  proxyMode: 'direct',
  groupId: null,
  createdAt: 1,
  lastOpenedAt: null,
  sortOrder: 1,
  settings: {
    platform: '其他',
    note: '',
    geoip: true,
    timezone: '',
    locale: '',
    viewport: 'default',
    fingerprintSeed: 1,
    aliasEngine: null,
    operatingSystem: 'host',
    cpuCores: null,
    startUrl: '',
  },
})
function setup(overrides: Partial<NativeApi> = {}) {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const api: NativeApi = {
    async call(command, args) {
      calls.push({ command, args })
      const values: Record<string, unknown> = {
        browser_connection_list: [connection()],
        browser_connection_probe: {
          connected: true,
          message: '内核已就绪',
          scopeId: 'builtin-shardbrowser',
          capabilities,
        },
        browser_window_list: [record()],
        browser_folder_list: [],
        browser_operation_list: [],
        shardbrowser_kernel_status: {
          platform: 'supported',
          installed: [{ version: '152.0.0.1', binaryPath: '/engine' }],
          downloading: false,
        },
      }
      return values[command]
    },
    ...overrides,
  }
  return { workspace: new NativeWorkspace(api), calls }
}

test("loads configured connections and reads the selected connection's records", async () => {
  const { workspace, calls } = setup()
  await workspace.initialize()
  await workspace.loadKernels('shardbrowser')
  assert.equal(workspace.state.connectionId, 'builtin-shardbrowser')
  assert.equal(workspace.state.profiles.length, 1)
  assert.equal(workspace.createBlockReason(), null)
  assert.deepEqual(calls.find((c) => c.command === 'browser_window_list')?.args, {
    connectionId: 'builtin-shardbrowser',
  })
})

test('a fresh workspace selects the always-on BitBrowser instead of an opt-in provider', async () => {
  const { workspace } = setup({
    call: async (command) => {
      if (command === 'browser_connection_list')
        return [
          connection('builtin-bitbrowser', 'bitbrowser'),
          connection('builtin-shardbrowser', 'shardbrowser'),
          connection('builtin-cloakbrowser', 'cloakbrowser'),
        ]
      if (command === 'browser_window_list') return []
      if (command === 'browser_connection_probe')
        return {
          connected: false,
          message: '未检测到比特浏览器本地 API，请先启动比特浏览器',
          scopeId: null,
          capabilities,
        }
      return []
    },
  })
  await workspace.initialize()
  assert.equal(workspace.state.connectionId, 'builtin-bitbrowser')
  assert.match(workspace.createBlockReason() ?? '', /启动比特浏览器/)
})

test('a remembered provider wins over the BitBrowser default', async () => {
  const { workspace } = setup({
    call: async (command) => {
      if (command === 'browser_connection_list')
        return [
          connection('builtin-bitbrowser', 'bitbrowser'),
          connection('builtin-shardbrowser', 'shardbrowser'),
        ]
      if (command === 'browser_connection_probe')
        return {
          connected: true,
          message: 'ok',
          scopeId: 'builtin-shardbrowser',
          capabilities,
        }
      return []
    },
  })
  await workspace.initialize('builtin-shardbrowser')
  assert.equal(workspace.state.connectionId, 'builtin-shardbrowser')
})

test('a late read from the previous connection never populates the next workspace', async () => {
  let resolveOld!: (value: unknown) => void
  const { workspace } = setup({
    call: async (command, args) => {
      if (command === 'browser_connection_list') return [connection('a'), connection('b')]
      if (command === 'browser_window_list' && args?.connectionId === 'a')
        return new Promise((resolve) => {
          resolveOld = resolve
        })
      if (command === 'browser_window_list') return [record('b')]
      if (command === 'browser_connection_probe')
        return { connected: true, message: 'ok', scopeId: 'b', capabilities }
      if (command === 'shardbrowser_kernel_status')
        return { platform: 'supported', installed: [], downloading: false }
      return []
    },
  })
  const first = workspace.initialize()
  while (!resolveOld) await Promise.resolve()
  await workspace.select('b')
  resolveOld([record('a')])
  await first
  assert.equal(workspace.state.connectionId, 'b')
  assert.equal(workspace.state.profiles[0].connectionId, 'b')
})

test('an observation failure preserves records and marks their runtime unknown', async () => {
  let fail = false
  const base = setup()
  const { workspace } = setup({
    call: async (command, args) => {
      if (fail && command === 'browser_window_list') throw new Error('offline')
      return base.workspace.api.call(command, args)
    },
  })
  await workspace.initialize()
  fail = true
  await assert.rejects(workspace.refresh(), /offline/)
  assert.equal(workspace.state.profiles.length, 1)
  assert.equal(workspace.state.profiles[0].state, 'unknown')
  assert.match(workspace.state.error ?? '', /offline/)
})

test('create errors retain the operation ID and never retry a submitted create automatically', async () => {
  const { workspace, calls } = setup()
  await workspace.initialize()
  await workspace.loadKernels('shardbrowser')
  const original = workspace.api.call.bind(workspace.api)
  workspace.api.call = async (command, args) => {
    if (command === 'browser_window_create') {
      calls.push({ command, args })
      throw new Error('unknown result')
    }
    return original(command, args)
  }
  const input = { ...record(), operationId: '00000000-0000-4000-8000-000000000001' }
  await assert.rejects(workspace.create(input), /unknown result/)
  assert.equal(calls.filter((c) => c.command === 'browser_window_create').length, 1)
  assert.equal(workspace.state.pendingCreateId, input.operationId)
})

test('unknown and missing profiles cannot be launched or deleted', async () => {
  const { workspace, calls } = setup()
  await workspace.initialize()
  workspace.state.profiles = [record(undefined, 'unknown')]
  await assert.rejects(workspace.start('profile-1'), /状态/)
  await assert.rejects(workspace.remove('profile-1'), /停止/)
  assert.equal(
    calls.some(
      (c) =>
        c.command === 'browser_window_start' || c.command === 'browser_window_delete',
    ),
    false,
  )
})

test('only a CloakBrowser Profile with an unresolved local state can request cleanup', async () => {
  const { workspace, calls } = setup()
  await workspace.initialize()
  workspace.state.profiles = [record(undefined, 'unknown')]
  await assert.rejects(workspace.cleanupCloakSession('profile-1'), /无需核对/)
  const cloak = connection('builtin-cloakbrowser', 'cloakbrowser')
  workspace.state.connections = [cloak]
  workspace.state.connectionId = cloak.id
  const profile = { ...record(cloak.id, 'running'), providerId: cloak.providerId }
  const call = workspace.api.call.bind(workspace.api)
  workspace.api.call = (command, args) => command === 'browser_window_list'
    ? Promise.resolve([{ ...profile, state: 'stopped' }])
    : call(command, args)
  workspace.state.profiles = [profile]
  await assert.rejects(workspace.cleanupCloakSession('profile-1'), /无需核对/)
  workspace.state.profiles = [{ ...profile, state: 'unknown' }]
  await workspace.cleanupCloakSession('profile-1')
  assert.deepEqual(calls.filter((call) => call.command === 'browser_cloakbrowser_cleanup'), [
    { command: 'browser_cloakbrowser_cleanup', args: { id: 'profile-1' } },
  ])
  assert.equal(workspace.state.busy.size, 0)
  assert.equal(workspace.state.profiles[0]?.state, 'stopped')
})

test('known create rejection releases the draft while an unreadable operation retains it', async () => {
  const { workspace } = setup()
  await workspace.initialize()
  await workspace.loadKernels('shardbrowser')
  const original = workspace.api.call.bind(workspace.api)
  workspace.api.call = async (command, args) => {
    if (command === 'browser_window_create') throw new Error('rejected')
    if (command === 'browser_operation_get') return null
    return original(command, args)
  }
  await assert.rejects(
    workspace.create({
      ...record(),
      operationId: '00000000-0000-4000-8000-000000000001',
    }),
  )
  assert.equal(workspace.state.pendingCreateId, null)
  assert.equal(workspace.createBlockReason(), null)
})

test('pending creates loaded after restart block another create', async () => {
  const base = setup()
  const { workspace } = setup({
    call: async (command, args) =>
      command === 'browser_operation_list'
        ? [
            {
              id: 'operation',
              kind: 'create',
              phase: 'uncertain',
              connectionId: 'builtin-shardbrowser',
            },
          ]
        : base.workspace.api.call(command, args),
  })
  await workspace.initialize()
  assert.match(workspace.createBlockReason() ?? '', /核对/)
})

test('cross-connection records are rejected without accepting them into the store', async () => {
  const base = setup()
  const { workspace } = setup({
    call: async (command, args) =>
      command === 'browser_window_list'
        ? [record('different-connection')]
        : base.workspace.api.call(command, args),
  })
  await assert.rejects(workspace.initialize(), /其他 Workspace/)
  assert.deepEqual(workspace.state.profiles, [])
})

test('failed update preserves the record and reports failure', async () => {
  const { workspace } = setup()
  await workspace.initialize()
  const original = workspace.api.call.bind(workspace.api)
  workspace.api.call = async (command, args) => {
    if (command === 'browser_window_update') throw new Error('storage failed')
    return original(command, args)
  }
  await assert.rejects(workspace.update(record()), /storage failed/)
  assert.equal(workspace.state.profiles[0].name, 'Profile 1')
  assert.equal(workspace.state.busy.size, 0)
})

test('a committed create stays successful when the subsequent list refresh fails', async () => {
  const { workspace } = setup()
  await workspace.initialize()
  await workspace.loadKernels('shardbrowser')
  const original = workspace.api.call.bind(workspace.api)
  let created = false
  workspace.api.call = async (command, args) => {
    if (command === 'browser_window_create') {
      created = true
      return record()
    }
    if (created && command === 'browser_window_list') throw new Error('readback offline')
    return original(command, args)
  }
  const result = await workspace.create({
    ...record(),
    operationId: '00000000-0000-4000-8000-000000000001',
  })
  assert.equal(result.id, 'profile-1')
  assert.equal(workspace.state.pendingCreateId, null)
  assert.match(workspace.state.error ?? '', /readback offline/)
})

test('a lost committed create response recovers the existing Profile instead of enabling another create', async () => {
  const { workspace } = setup()
  await workspace.initialize()
  await workspace.loadKernels('shardbrowser')
  const original = workspace.api.call.bind(workspace.api)
  workspace.api.call = async (command, args) => {
    if (command === 'browser_window_create') throw new Error('response lost')
    if (command === 'browser_operation_get')
      return { id: 'operation', phase: 'committed', windowId: 'profile-1' }
    return original(command, args)
  }
  const result = await workspace.create({
    ...record(),
    operationId: '00000000-0000-4000-8000-000000000001',
  })
  assert.equal(result.id, 'profile-1')
  assert.equal(workspace.state.pendingCreateId, null)
})

test('selects an enabled CloakBrowser workspace and reads only its kernel status', async () => {
  const base = setup()
  const cloak = connection('builtin-cloakbrowser', 'cloakbrowser')
  const { workspace } = setup({
    call: async (command, args) => {
      if (command === 'browser_connection_list') return [cloak]
      if (
        command === 'browser_window_list' ||
        command === 'browser_folder_list' ||
        command === 'browser_operation_list'
      )
        return []
      if (command === 'browser_connection_probe')
        return { connected: true, message: 'ok', scopeId: cloak.id, capabilities }
      if (command === 'kernel_status')
        return {
          cacheDir: '/synthetic/cache',
          platform: 'darwin-arm64',
          activationConfigured: true,
          installed: [],
          download: {
            phase: 'idle',
            percent: null,
            downloadedMb: null,
            totalMb: null,
            attempt: null,
            version: null,
            requestedVersion: null,
            error: null,
          },
        }
      return base.workspace.api.call(command, args)
    },
  })
  await workspace.initialize()
  assert.equal(workspace.state.connectionId, cloak.id)
  await workspace.loadKernels()
  assert.equal(workspace.state.cloakKernels?.platform, 'darwin-arm64')
  assert.equal(
    base.calls.some((call) => call.command.startsWith('shardbrowser_')),
    false,
  )
})

test('CloakBrowser creation needs an activation probe but not a preinstalled kernel', async () => {
  const base = setup()
  const cloak = connection('builtin-cloakbrowser', 'cloakbrowser')
  const { workspace } = setup({
    call: async (command, args) => {
      if (command === 'browser_connection_list') return [cloak]
      if (
        command === 'browser_window_list' ||
        command === 'browser_folder_list' ||
        command === 'browser_operation_list'
      )
        return []
      if (command === 'browser_connection_probe')
        return {
          connected: false,
          message: '请先在应用设置中保存并验证激活码',
          scopeId: cloak.id,
          capabilities,
        }
      return base.workspace.api.call(command, args)
    },
  })
  await workspace.initialize()
  assert.match(workspace.createBlockReason() ?? '', /激活码/)
  workspace.state.probe = {
    connected: true,
    message: 'ok',
    scopeId: cloak.id,
    capabilities,
  }
  assert.equal(workspace.createBlockReason(), null)
})

test('ShardBrowser still requires an installed kernel before creation', async () => {
  const base = setup()
  const { workspace } = setup({
    call: async (command, args) => {
      if (command === 'shardbrowser_kernel_status')
        return { platform: 'supported', installed: [], downloading: false }
      return base.workspace.api.call(command, args)
    },
  })
  await workspace.initialize()
  await workspace.loadKernels('shardbrowser')
  assert.match(workspace.createBlockReason() ?? '', /下载 ShardBrowser 内核/)
})

test('enabling CloakBrowser selects the returned connection', async () => {
  const cloak = connection('builtin-cloakbrowser', 'cloakbrowser')
  let enabled = false
  const base = setup()
  const { workspace } = setup({
    call: async (command, args) => {
      if (command === 'browser_managed_cloakbrowser_set') {
        enabled = args?.enabled === true
        return cloak
      }
      if (command === 'browser_connection_list')
        return enabled ? [connection(), cloak] : [connection()]
      if (
        command === 'browser_window_list' ||
        command === 'browser_folder_list' ||
        command === 'browser_operation_list'
      ) {
        return args?.connectionId === cloak.id
          ? []
          : base.workspace.api.call(command, args)
      }
      if (command === 'browser_connection_probe')
        return { connected: true, message: 'ok', scopeId: cloak.id, capabilities }
      return base.workspace.api.call(command, args)
    },
  })
  await workspace.initialize()
  await workspace.enable('cloakbrowser', true)
  assert.equal(workspace.state.connectionId, cloak.id)
})
