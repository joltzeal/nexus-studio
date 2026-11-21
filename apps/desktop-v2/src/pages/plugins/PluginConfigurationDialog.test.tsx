import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { PluginView } from '../../raccoon/plugins/types'
import { PluginConfigurationDialog } from './PluginConfigurationDialog'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }))

const plugin: PluginView = {
  id: 'studio.sim8',
  name: 'SIM8',
  version: '2.0.0',
  apiVersion: 1,
  minCoreVersion: '0.2.0',
  capabilities: ['verification.provider'],
  granted: ['verification.provider'],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
  source: 'installed',
  enabled: true,
  state: 'running',
  methods: ['configuration.export', 'configuration.validate', 'configuration.import'],
  status: {},
  lastError: null,
  storageDurable: true,
  secretSlots: [],
  sourceDirectory: null,
  installation: 'installed-1',
  runtimeGeneration: 'runtime-1',
}
const documentFile = {
  format: 'raccoon-configuration',
  schemaVersion: 2,
  exportedAt: '2026-11-21T00:00:00.000Z',
  preferences: null,
  networkProxy: null,
  plugins: [
    {
      id: 'studio.sim8',
      name: 'SIM8',
      version: '2.0.0',
      configuration: { schemaVersion: 1, data: { token: 'fixture-token' } },
    },
    {
      id: 'studio.email',
      name: '邮箱管理',
      version: '2.0.0',
      configuration: { schemaVersion: 1, data: { autoReceive: false } },
    },
  ],
}

let root: Root
let container: HTMLDivElement
let events: string[]
let savePath: string | null
let openFile: { name: string; content: string } | null
let catalog: PluginView[]
let writeFailure: boolean

beforeEach(() => {
  vi.resetAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.mocked(isTauri).mockReturnValue(true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  events = []
  catalog = [plugin]
  savePath = null
  openFile = { name: 'plugins.json', content: JSON.stringify(documentFile) }
  writeFailure = false
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'plugin_catalog') return structuredClone(catalog)
    if (command === 'configuration_file_import') return openFile
    if (command === 'configuration_file_export') return savePath
    if (command === 'plugin_call') {
      const { input } = args as { input: { method: string; id: string } }
      events.push(input.method)
      if (input.method === 'configuration.export')
        return documentFile.plugins[0]!.configuration
      if (input.method === 'configuration.validate') return { valid: true }
      return { imported: !writeFailure || input.id !== 'studio.sim8' }
    }
    throw new Error(`Unexpected command: ${command}`)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function renderDialog(onClose = vi.fn()) {
  await act(async () => root.render(<PluginConfigurationDialog onClose={onClose} />))
  return onClose
}

function button(label: string) {
  const result = [...document.body.querySelectorAll('button')].find(
    (item) =>
      item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  )
  expect(result, label).toBeDefined()
  return result!
}

async function click(label: string) {
  await act(async () => button(label).click())
}

it('opens a plugin-only selector without fetching secret configurations in advance', async () => {
  await renderDialog()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('插件配置')
  expect(document.body.textContent).toContain('SIM8')
  expect(events).toEqual([])
  expect(document.body.textContent).not.toContain('fixture-token')
})

it('does not report success when saving is cancelled, and reports a real saved file', async () => {
  await renderDialog()
  await click('导出所选（1）')
  expect(document.body.textContent).not.toContain('已导出')
  savePath = '/tmp/fixture-plugins.json'
  await click('导出所选（1）')
  expect(document.body.textContent).toContain('已导出 1 项插件配置')
  expect(document.body.textContent).not.toContain('fixture-token')
})

it('only previews a selected file and disables missing plugins until explicit import', async () => {
  await renderDialog()
  await click('导入')
  await click('选择配置文件')
  expect(events).toEqual([])
  expect(document.body.textContent).toContain('plugins.json')
  expect(document.body.textContent).toContain('插件未安装')
  const missing = document.querySelector<HTMLInputElement>(
    'input[aria-label="选择 邮箱管理"]',
  )
  expect(missing?.disabled).toBe(true)
  await click('导入所选（1）')
  expect(events).toEqual(['configuration.validate', 'configuration.import'])
  expect(document.body.textContent).toContain('已导入 1 项插件配置')
  expect(button('导入所选（0）').getAttribute('aria-disabled')).toBe('true')
})

it('preserves the previous preview if choosing another file is cancelled', async () => {
  await renderDialog()
  await click('导入')
  await click('选择配置文件')
  openFile = null
  await click('选择配置文件')
  expect(document.body.textContent).toContain('plugins.json')
  expect(button('导入所选（1）').getAttribute('aria-disabled')).toBeNull()
  expect(events).toEqual([])
})

it('keeps failed imports selected for retry and marks success only after confirmed writes', async () => {
  await renderDialog()
  await click('导入')
  await click('选择配置文件')
  writeFailure = true
  await click('导入所选（1）')
  expect(document.body.textContent).toContain('1 项失败')
  expect(button('导入所选（1）').getAttribute('aria-disabled')).toBeNull()
  writeFailure = false
  await click('导入所选（1）')
  expect(document.body.textContent).toContain('已导入 1 项插件配置')
  expect(button('导入所选（0）').getAttribute('aria-disabled')).toBe('true')
})

it('does not open native file dialogs or export data in a browser preview', async () => {
  vi.mocked(isTauri).mockReturnValue(false)
  await renderDialog()
  expect(document.body.textContent).toContain('桌面应用')
  expect(button('导出所选（0）').getAttribute('aria-disabled')).toBe('true')
  await click('导出所选（0）')
  expect(invoke).not.toHaveBeenCalled()
})

it('does not continue to save after the page unmounts during export', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'plugin_catalog') return [plugin]
    if (command === 'plugin_call')
      return new Promise((resolve) => {
        finish = resolve
      })
    throw new Error(`Unexpected late command: ${command}`)
  })
  await renderDialog()
  await click('导出所选（1）')
  await act(async () => root.render(null))
  await act(async () => finish(documentFile.plugins[0]!.configuration))
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === 'configuration_file_export'),
  ).toBe(false)
})

it('does not reimport successful plugins when retrying the failed item', async () => {
  catalog.push({ ...plugin, id: 'studio.email', name: '邮箱管理' })
  await renderDialog()
  await click('导入')
  await click('选择配置文件')
  writeFailure = true
  await click('导入所选（2）')
  expect(document.body.textContent).toContain('已导入 1 项，1 项失败')
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="选择 邮箱管理"]')
      ?.disabled,
  ).toBe(true)
  writeFailure = false
  await click('导入所选（1）')
  const imported = vi
    .mocked(invoke)
    .mock.calls.filter(
      ([command, args]) =>
        command === 'plugin_call' &&
        (args as { input: { id: string; method: string } }).input.method ===
          'configuration.import',
    )
  expect(
    imported.map(([, args]) => (args as { input: { id: string } }).input.id),
  ).toEqual(['studio.sim8', 'studio.email', 'studio.sim8'])
})

it('blocks double submission and closing while an import is in progress', async () => {
  await renderDialog()
  await click('导入')
  await click('选择配置文件')
  const native = vi.mocked(invoke).getMockImplementation()!
  let finish!: (value: unknown) => void
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (
      command === 'plugin_call' &&
      (args as { input: { method: string } }).input.method === 'configuration.validate'
    )
      return new Promise((resolve) => {
        finish = resolve
      })
    return native(command, args)
  })
  const onClose = vi.fn()
  await act(async () => root.render(<PluginConfigurationDialog onClose={onClose} />))
  await click('导入所选（1）')
  await click('导入所选（1）')
  await click('关闭')
  await click('关闭插件配置')
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => finish({ valid: true }))
  expect(events).toEqual(['configuration.import'])
  expect(document.body.textContent).toContain('已导入 1 项插件配置')
})
