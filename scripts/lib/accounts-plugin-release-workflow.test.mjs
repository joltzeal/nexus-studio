import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writePackage } from './market-package.mjs'

const root = resolve(import.meta.dirname, '../..')
const workflow = readFileSync(
  join(root, '.github/workflows/accounts-plugin-release.yml'),
  'utf8',
)
const directories = []
const methods = [
  'vinted.accounts.list',
  'vinted.accounts.save',
  'vinted.accounts.remove',
  'vinted.accounts.import',
  'vinted.accounts.template',
  'vinted.accounts.otp',
  'vinted.accounts.bind',
  'vinted.accounts.unbind',
  'vinted.accounts.bindings',
  'vinted.accounts.address.targets',
  'vinted.accounts.address.set',
  'window.detach',
  'transfer.export',
  'transfer.import',
  'transfer.rollback',
  'transfer.commit',
  'vinted.accounts.orders.settings.get',
  'vinted.accounts.orders.settings.save',
  'vinted.accounts.orders.bark.test',
  'vinted.accounts.orders.list',
  'vinted.accounts.orders.run',
  'vinted.accounts.orders.enabled',
  'configuration.export',
  'configuration.validate',
  'configuration.import',
]

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function write(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
}

function json(file, data) {
  write(file, JSON.stringify(data))
}

function command(name) {
  const section = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0]
  expect(section, name).toBeDefined()
  const lines = section.split('\n')
  const index = lines.findIndex((line) => line.startsWith('        run: '))
  expect(index, name).toBeGreaterThanOrEqual(0)
  const value = lines[index].slice('        run: '.length)
  return value === '|'
    ? lines
        .slice(index + 1)
        .filter((line) => line.startsWith('          ') || line === '')
        .map((line) => line.slice(10))
        .join('\n')
    : value
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-account-release-'))
  directories.push(directory)
  const market = join(directory, 'market with spaces')
  const manifest = {
    apiVersion: 1,
    id: 'studio.vinted-accounts',
    version: '1.1.0',
    name: 'Account release fixture',
    minCoreVersion: '0.1.21',
    capabilities: ['account.pool'],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
  }
  const packageJson = {
    name: '@nexus/plugin-vinted-accounts',
    version: manifest.version,
    type: 'module',
  }
  const container = {
    manifest: structuredClone(manifest),
    entry: 'bootstrap.cjs',
    files: [
      { path: 'nexus.plugin.json', data: Buffer.from(JSON.stringify(manifest)) },
      { path: 'bootstrap.cjs', data: Buffer.from('opaque fixture\n') },
    ],
  }
  const url = `plugins/${manifest.id}/${manifest.version}.nexuspkg`
  const file = join(market, url)
  const catalog = {
    schemaVersion: 1,
    plugins: [{ manifest: structuredClone(manifest), package: { url } }],
  }
  const methodFile = join(
    directory,
    'plugins/vinted-accounts/dist/src/capabilities/accounts.js',
  )
  write(methodFile, `export const ACCOUNT_METHODS = ${JSON.stringify(methods)}\n`)
  write(
    join(directory, 'scripts/lib/market-package.mjs'),
    readFileSync(join(root, 'scripts/lib/market-package.mjs')),
  )
  const started = join(directory, 'started')
  const report = { methods: [...methods].reverse() }
  write(
    join(directory, 'scripts/verify-package.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs'
writeFileSync(process.env.TEST_STARTED, 'yes')
const report = JSON.parse(readFileSync(process.env.TEST_REPORT, 'utf8'))
if (report.error) throw new Error(report.error)
console.log('ok studio.vinted-accounts 1.1.0')
console.log('   \\u65b9\\u6cd5 ' + report.methods.length +
  ' \\u4e2a\\uff1a' + report.methods.join(', '))
`,
  )
  return {
    directory,
    market,
    manifest,
    packageJson,
    container,
    catalog,
    file,
    methodFile,
    report,
    started,
    verify(tag = 'plugin-vinted-accounts@1.1.0') {
      json(join(directory, 'plugins/vinted-accounts/package.json'), packageJson)
      json(join(directory, 'plugins/vinted-accounts/dist/nexus.plugin.json'), manifest)
      const bytes = writePackage(container)
      write(file, bytes)
      catalog.plugins[0].package.size ??= bytes.length
      catalog.plugins[0].package.sha256 ??= createHash('sha256')
        .update(bytes)
        .digest('hex')
      json(join(market, 'catalog.json'), catalog)
      json(join(directory, 'report.json'), report)
      return spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-e',
          '-o',
          'pipefail',
          '-c',
          command('Verify artifact and plugin startup'),
        ],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            PLUGIN_MARKET_DIR: market,
            GITHUB_REF_NAME: tag,
            TEST_STARTED: started,
            TEST_REPORT: join(directory, 'report.json'),
          },
          encoding: 'utf8',
          timeout: 15_000,
        },
      )
    },
  }
}

describe('account plugin independent release', () => {
  it('uses a plugin-only tag, pinned tooling and read-only permissions', () => {
    expect(workflow).toContain("- 'plugin-vinted-accounts@*'")
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('version: 11.17.0')
    expect(workflow).toContain('node-version-file: .node-version')
    expect(workflow).toContain('run: pnpm install --frozen-lockfile')
    expect(workflow).not.toMatch(
      /secrets\.|wrangler|cloudflare|contents: write|continue-on-error|always\(\)/i,
    )
    expect(command('Build account plugin and dependencies')).toBe(
      "pnpm -r --filter '@nexus/plugin-vinted-accounts...' build",
    )
    expect(command('Check account plugin')).toContain(
      'pnpm exec vitest run plugins/vinted-accounts scripts/lib/accounts-plugin-release-workflow.test.mjs --maxWorkers=2',
    )
    expect(command('Pack account plugin')).toContain(
      'mktemp -d "$RUNNER_TEMP/plugin-market.XXXXXX"',
    )
    expect(command('Pack account plugin')).toContain(
      'node scripts/pack-plugin.mjs plugins/vinted-accounts --out "$market_dir"',
    )
    expect(command('Pack account plugin')).not.toMatch(/plugins\/(ai-image|sim8)/)
    const upload = workflow.split('      - uses: actions/upload-artifact@v4\n')[1]
    expect(upload).toContain('name: plugin-market-${{ github.ref_name }}')
    expect(upload).toContain('${{ steps.market.outputs.directory }}/catalog.json')
    expect(upload).toContain(
      '${{ steps.market.outputs.directory }}/plugins/**/*.nexuspkg',
    )
    expect(upload).toContain('if-no-files-found: error')
  })

  it('accepts the matching artifact and checks its exact startup methods', () => {
    const data = fixture()
    const result = data.verify()
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(data.started)).toBe(true)
    expect(result.stdout).toContain('ok studio.vinted-accounts 1.1.0')
  })

  it.each(['plugin-vinted-accounts@1.0.2', 'v0.1.23', 'plugin-ai-image@1.1.0'])(
    'rejects mismatched tag %s before executing the package',
    (tag) => {
      const data = fixture()
      expect(data.verify(tag).status).toBe(1)
      expect(existsSync(data.started)).toBe(false)
    },
  )

  it.each([
    ['package identity', (data) => (data.packageJson.name = '@nexus/plugin-other')],
    ['version', (data) => (data.packageJson.version = '1.0.2')],
    [
      'catalog digest',
      (data) => (data.catalog.plugins[0].package.sha256 = '0'.repeat(64)),
    ],
    ['catalog size', (data) => (data.catalog.plugins[0].package.size = 1)],
    ['catalog path', (data) => (data.catalog.plugins[0].package.url = '../other')],
    ['manifest', (data) => (data.catalog.plugins[0].manifest.version = '1.0.2')],
    ['header', (data) => (data.container.manifest.id = 'studio.other')],
    [
      'embedded manifest',
      (data) => (data.container.files[0].data = Buffer.from('{"id":"studio.other"}')),
    ],
    [
      'unrelated package',
      (data) => write(join(data.market, 'plugins/studio.other/1.0.0.nexuspkg'), 'stale'),
    ],
  ])('rejects invalid %s before startup', (_, mutate) => {
    const data = fixture()
    mutate(data)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(existsSync(data.started)).toBe(false)
  })

  it.each(methods)('rejects a package missing RPC %s', (method) => {
    const data = fixture()
    data.report.methods = data.report.methods.filter((value) => value !== method)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(existsSync(data.started)).toBe(true)
  })

  it.each([
    ['extra method', (data) => data.report.methods.push('account.unexpected')],
    ['duplicate method', (data) => (data.report.methods[0] = data.report.methods[1])],
    ['startup failure', (data) => (data.report.error = 'fixture cannot start')],
    [
      'incomplete compiled contract',
      (data) => write(data.methodFile, 'export const ACCOUNT_METHODS = []\n'),
    ],
  ])('rejects %s', (_, mutate) => {
    const data = fixture()
    mutate(data)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
  })
})
