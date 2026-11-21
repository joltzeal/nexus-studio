import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { PluginView } from './types'
import {
  exportPluginConfiguration,
  importPluginConfiguration,
  openPluginConfigurationFile,
  parsePluginConfiguration,
  pluginConfigurationTargets,
  savePluginConfigurationFile,
} from './configuration'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

function plugin(id: string, patch: Partial<PluginView> = {}): PluginView {
  return {
    id,
    name: id,
    version: '2.0.0',
    apiVersion: 1,
    minCoreVersion: '0.2.0',
    capabilities: ['image.provider'],
    granted: ['image.provider'],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: ['configuration.export', 'configuration.validate', 'configuration.import'],
    status: {},
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
    installation: 'install-1',
    runtimeGeneration: 'runtime-1',
    ...patch,
  }
}

const entry = (id: string) => ({
  id,
  name: id,
  version: '2.0.0',
  configuration: { schemaVersion: 1 as const, data: { apiKey: 'fixture-only' } },
})
const archive = (...ids: string[]) => ({
  format: 'raccoon-configuration' as const,
  schemaVersion: 2 as const,
  exportedAt: '2026-11-21T00:00:00.000Z',
  preferences: null,
  networkProxy: null,
  plugins: ids.map(entry),
})

let catalog: PluginView[]
let events: string[]
let rpc: (method: string, id: string) => unknown

beforeEach(() => {
  vi.resetAllMocks()
  catalog = [plugin('studio.ai-image'), plugin('studio.sim8')]
  events = []
  rpc = (method) =>
    method === 'configuration.export'
      ? { schemaVersion: 1, data: { apiKey: 'fixture-only' } }
      : method === 'configuration.validate'
        ? { valid: true }
        : { imported: true }
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'plugin_catalog') return structuredClone(catalog)
    if (command === 'plugin_call') {
      const { input } = args as {
        input: {
          id: string
          method: string
          capability: string
          expectedIdentity?: string
        }
      }
      expect(input.capability).toBe('image.provider')
      expect(input.expectedIdentity).toBe('install-1:runtime-1')
      events.push(`${input.id}:${input.method}`)
      return rpc(input.method, input.id)
    }
    throw new Error(`Unexpected native command: ${command}`)
  })
})

it('exports only selected plugin settings with no application settings or business records', async () => {
  const result = await exportPluginConfiguration(['studio.sim8'])
  expect(result).toEqual({ ...archive('studio.sim8'), exportedAt: expect.any(String) })
  expect(events).toEqual(['studio.sim8:configuration.export'])
})

it('shows why installed plugins are unavailable and excludes uninstalled candidates', () => {
  const targets = pluginConfigurationTargets([
    plugin('studio.running'),
    plugin('studio.offline', { state: 'retrying' }),
    plugin('studio.unlicensed', { state: 'unlicensed' }),
    plugin('studio.unsupported', { methods: [] }),
    plugin('studio.ungranted', { granted: [] }),
    plugin('studio.unidentified', { runtimeGeneration: null }),
    plugin('studio.candidate', { state: 'available', enabled: false }),
  ])
  expect(targets.map(({ id, available }) => [id, available])).toEqual([
    ['studio.running', true],
    ['studio.offline', false],
    ['studio.unlicensed', false],
    ['studio.unsupported', false],
    ['studio.ungranted', false],
    ['studio.unidentified', false],
  ])
  expect(targets.slice(1).every((target) => Boolean(target.reason))).toBe(true)
})

it('rejects unavailable or unknown selections before reading any configuration', async () => {
  catalog[1] = plugin('studio.sim8', { methods: [] })
  await expect(
    exportPluginConfiguration(['studio.ai-image', 'studio.sim8']),
  ).rejects.toThrow()
  await expect(exportPluginConfiguration(['studio.missing'])).rejects.toThrow()
  await expect(exportPluginConfiguration([])).rejects.toThrow()
  expect(events).toEqual([])
})

it('rejects old formats, duplicate records, oversized and invalid JSON files', () => {
  for (const value of [
    { ...archive(), format: 'nexus-configuration', schemaVersion: 1 },
    { ...archive(), schemaVersion: 3 },
    archive('studio.sim8', 'studio.sim8'),
    {
      ...archive(),
      plugins: [
        { ...entry('studio.sim8'), configuration: { schemaVersion: 99, data: {} } },
      ],
    },
  ])
    expect(() => parsePluginConfiguration(JSON.stringify(value))).toThrow()
  expect(() => parsePluginConfiguration('not json')).toThrow()
  expect(() => parsePluginConfiguration(' '.repeat(8 * 1024 * 1024 + 1))).toThrow()
})

it('validates all selected plugins before any write and leaves unselected records alone', async () => {
  expect(
    await importPluginConfiguration(archive('studio.ai-image', 'studio.sim8'), [
      'studio.ai-image',
      'studio.sim8',
    ]),
  ).toEqual([
    { id: 'studio.ai-image', name: 'studio.ai-image', success: true },
    { id: 'studio.sim8', name: 'studio.sim8', success: true },
  ])
  expect(events).toEqual([
    'studio.ai-image:configuration.validate',
    'studio.sim8:configuration.validate',
    'studio.ai-image:configuration.import',
    'studio.sim8:configuration.import',
  ])
  events = []
  await importPluginConfiguration(archive('studio.ai-image', 'studio.sim8'), [
    'studio.sim8',
  ])
  expect(events).toEqual([
    'studio.sim8:configuration.validate',
    'studio.sim8:configuration.import',
  ])
})

it('does not write any plugin when a later validation fails', async () => {
  rpc = (_method, id) => (id === 'studio.sim8' ? { valid: false } : { valid: true })
  await expect(
    importPluginConfiguration(archive('studio.ai-image', 'studio.sim8'), [
      'studio.ai-image',
      'studio.sim8',
    ]),
  ).rejects.toThrow()
  expect(events).toEqual([
    'studio.ai-image:configuration.validate',
    'studio.sim8:configuration.validate',
  ])
})

it('imports a selected item from a compact archive without charging pretty-print whitespace to its budget', async () => {
  const large = archive(
    'studio.ai-image',
    ...Array.from({ length: 63 }, (_, index) => `studio.extra-${index}`),
  )
  for (const plugin of large.plugins) {
    Object.assign(plugin.configuration, {
      data: { values: Array<number>(55_000).fill(0) },
    })
  }
  const content = JSON.stringify(large)
  expect(new TextEncoder().encode(content).byteLength).toBeLessThan(8 * 1024 * 1024)
  expect(
    await importPluginConfiguration(parsePluginConfiguration(content), [
      'studio.ai-image',
    ]),
  ).toEqual([{ id: 'studio.ai-image', name: 'studio.ai-image', success: true }])
  expect(events).toEqual([
    'studio.ai-image:configuration.validate',
    'studio.ai-image:configuration.import',
  ])
})

it('rejects missing plugins and unknown selection IDs before validation or writes', async () => {
  await expect(
    importPluginConfiguration(archive('studio.ai-image', 'studio.missing'), [
      'studio.ai-image',
      'studio.missing',
    ]),
  ).rejects.toThrow()
  await expect(
    importPluginConfiguration(archive('studio.ai-image'), ['studio.sim8']),
  ).rejects.toThrow()
  expect(events).toEqual([])
})

it('requires actual write confirmation and returns per-plugin partial results', async () => {
  rpc = (method, id) =>
    method === 'configuration.validate'
      ? { valid: true }
      : { imported: id === 'studio.ai-image' }
  expect(
    await importPluginConfiguration(archive('studio.ai-image', 'studio.sim8'), [
      'studio.ai-image',
      'studio.sim8',
    ]),
  ).toEqual([
    { id: 'studio.ai-image', name: 'studio.ai-image', success: true },
    { id: 'studio.sim8', name: 'studio.sim8', success: false, error: expect.any(String) },
  ])
})

it.each(['installation', 'runtimeGeneration', 'version'] as const)(
  'does not write to a plugin whose %s changes after preflight',
  async (key) => {
    rpc = () => {
      catalog[0] = plugin('studio.ai-image', { [key]: 'changed' })
      return { valid: true }
    }
    const results = await importPluginConfiguration(archive('studio.ai-image'), [
      'studio.ai-image',
    ])
    expect(results).toEqual([
      {
        id: 'studio.ai-image',
        name: 'studio.ai-image',
        success: false,
        error: expect.any(String),
      },
    ])
    expect(events).toEqual(['studio.ai-image:configuration.validate'])
  },
)

it('stops issuing operations after its dialog session ends', async () => {
  let current = true
  rpc = () => {
    current = false
    return { valid: true }
  }
  await expect(
    importPluginConfiguration(
      archive('studio.ai-image', 'studio.sim8'),
      ['studio.ai-image', 'studio.sim8'],
      () => current,
    ),
  ).rejects.toThrow()
  expect(events).toEqual(['studio.ai-image:configuration.validate'])
})

it('preserves cancellation from native file dialogs and parses a chosen file before preview', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
  expect(await savePluginConfigurationFile(archive('studio.sim8'))).toBeNull()
  expect(await openPluginConfigurationFile()).toBeNull()
  vi.mocked(invoke).mockResolvedValueOnce({
    name: 'plugins.json',
    content: JSON.stringify(archive('studio.sim8')),
  })
  expect(await openPluginConfigurationFile()).toEqual({
    name: 'plugins.json',
    archive: archive('studio.sim8'),
  })
  expect(events).toEqual([])
})

it('rejects malformed native results and plugin configuration without revealing its values', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ name: 'plugins.json', content: 'bad json' })
  await expect(openPluginConfigurationFile()).rejects.toThrow()
  rpc = () => ({ schemaVersion: 99, data: { apiKey: 'fixture-only' } })
  await expect(exportPluginConfiguration(['studio.ai-image'])).rejects.not.toThrow(
    'fixture-only',
  )
})
