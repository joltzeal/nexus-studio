import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')
const directories = []

const requiredMethods = {
  'ai-image': ['image.plans.create', 'image.plans.get'],
  'vinted-monitor': [
    'vinted.monitors.list',
    'vinted.monitors.save',
    'vinted.monitors.remove',
    'vinted.monitors.run',
    'vinted.runs.list',
    'vinted.runs.get',
    'vinted.items.list',
    'vinted.items.get',
    'vinted.items.star',
    'vinted.items.availability',
    'vinted.items.remove',
    'vinted.items.monitorSeller',
    'vinted.proxies.list',
    'vinted.proxies.save',
    'vinted.proxies.remove',
    'vinted.proxies.default',
    'vinted.image.open',
    'vinted.image.read',
    'vinted.image.close',
    'vinted.url.inspect',
  ],
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-release-test-'))
  directories.push(directory)
  return directory
}

function write(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, value)
}

function writeJson(file, value) {
  write(file, JSON.stringify(value))
}

function step(name) {
  const section = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0]
  if (section === undefined) throw new Error(`Missing workflow step: ${name}`)
  return section
}

function command(name) {
  const lines = step(name).split('\n')
  const index = lines.findIndex((line) => line.startsWith('        run: '))
  if (index === -1) throw new Error(`Missing run command: ${name}`)
  const value = lines[index].slice('        run: '.length)
  return value === '|'
    ? lines
        .slice(index + 1)
        .filter((line) => line.startsWith('          ') || line === '')
        .map((line) => line.slice(10))
        .join('\n')
    : value
}

function run(script, directory, env = {}) {
  return spawnSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
    {
      cwd: directory,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 15_000,
    },
  )
}

function fixture() {
  const directory = temporaryDirectory()
  const market = join(directory, 'market')
  const invocations = join(directory, 'verified.jsonl')
  const catalog = {
    schemaVersion: 1,
    generatedAt: '2026-10-25T00:00:00.000Z',
    plugins: [],
  }
  const plugins = Object.entries(requiredMethods).map(([name, methods], index) => {
    // Deliberately unrelated to release versions: paths must follow the manifests.
    const version = index === 0 ? '11.2.3' : '17.4.5'
    const manifest = {
      apiVersion: 1,
      id: `studio.${name}`,
      name,
      version,
      minCoreVersion: '0.1.0',
      capabilities: [index === 0 ? 'image.provider' : 'monitor.collector'],
      permissions: {
        networkDomains: [],
        wantsBrowserAccess: false,
        storage: 'private',
        secrets: [],
      },
    }
    writeJson(join(directory, 'plugins', name, 'dist/nexus.plugin.json'), manifest)
    writeJson(join(directory, 'plugins', name, 'package.json'), {
      name: `@nexus/plugin-${name}`,
      version,
    })
    // These are opaque test bytes, not a built or packaged plugin.
    const bytes = Buffer.from(`fixture ${name} ${version}\n`)
    const url = `plugins/${manifest.id}/${version}.nexuspkg`
    const file = join(market, url)
    write(file, bytes)
    catalog.plugins.push({
      manifest,
      description: 'fixture',
      changelog: 'fixture',
      package: {
        url,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    })
    const report = { id: manifest.id, version, methods }
    writeJson(`${file}.report.json`, report)
    return { name, file, report, manifest }
  })
  writeJson(join(market, 'catalog.json'), catalog)
  // Only the external packaged-process check is replaced. The workflow's
  // catalog, file, digest and RPC validation execute unchanged.
  write(
    join(directory, 'scripts/verify-package.mjs'),
    `import { appendFileSync, readFileSync } from 'node:fs'
const file = process.argv[2]
appendFileSync(process.env.TEST_VERIFIED, JSON.stringify(file) + '\\n')
const report = JSON.parse(readFileSync(file + '.report.json', 'utf8'))
if (report.error) {
  console.error(report.error)
  process.exit(1)
}
console.log('ok ' + report.id + ' ' + report.version)
console.log('   \\u65b9\\u6cd5 ' + report.methods.length + ' \\u4e2a\\uff1a' + report.methods.join(', '))
console.log('   \\u72b6\\u6001 {}')
`,
  )
  return {
    directory,
    market,
    catalog,
    plugins,
    invocations,
    verify() {
      return run(command('Verify packaged plugin startup'), directory, {
        PLUGIN_MARKET_DIR: market,
        TEST_VERIFIED: invocations,
      })
    },
    saveCatalog() {
      writeJson(join(market, 'catalog.json'), catalog)
    },
  }
}

describe('companion plugin release workflow', () => {
  it('builds AI and Vinted with dependencies and packs only them into a fresh directory', () => {
    const directory = temporaryDirectory()
    const calls = join(directory, 'calls.jsonl')
    const output = join(directory, 'output')
    const runnerTemp = join(directory, 'runner temp')
    mkdirSync(runnerTemp)
    write(join(directory, 'market/plugins/studio.shared-supply/old.nexuspkg'), 'stale')
    write(
      join(directory, 'record.mjs'),
      "import { appendFileSync } from 'node:fs'\n" +
        "appendFileSync(process.env.TEST_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')\n",
    )
    // Execute the shell orchestration while preventing builds and packaging.
    const stubs = `
pnpm() { "$TEST_NODE" "$TEST_RECORDER" pnpm "$@"; }
node() { "$TEST_NODE" "$TEST_RECORDER" node "$@"; }
`
    const result = run(
      `${stubs}\n${command('Build companion plugins')}\n${command('Pack companion plugins')}`,
      directory,
      {
        TEST_NODE: process.execPath,
        TEST_RECORDER: join(directory, 'record.mjs'),
        TEST_CALLS: calls,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: runnerTemp,
      },
    )
    expect(result.status, result.stderr).toBe(0)
    const commands = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
    expect(commands[0]).toEqual([
      'pnpm',
      '-r',
      '--filter',
      '@nexus/plugin-ai-image...',
      '--filter',
      '@nexus/plugin-vinted-monitor...',
      'build',
    ])
    expect(commands.slice(1).map((args) => args.slice(0, 3))).toEqual([
      ['node', 'scripts/pack-plugin.mjs', 'plugins/ai-image'],
      ['node', 'scripts/pack-plugin.mjs', 'plugins/vinted-monitor'],
      ['node', 'scripts/build-market.mjs', '--out'],
    ])
    const market = readFileSync(output, 'utf8').match(/^directory=(.+)$/m)?.[1]
    expect(dirname(market)).toBe(runnerTemp)
    expect(readdirSync(market)).toEqual([])
    for (const args of commands.slice(1)) {
      expect(args[args.indexOf('--out') + 1]).toBe(market)
    }
    expect(step('Pack companion plugins')).toContain('id: plugin-market')
    expect(step('Verify packaged plugin startup')).toContain(
      'PLUGIN_MARKET_DIR: ${{ steps.plugin-market.outputs.directory }}',
    )
  })

  it('uploads the verified partial catalog and packages before allowing desktop publication', () => {
    const pluginsJob = workflow.split('  plugins:\n')[1].split('\n  package:')[0]
    expect(pluginsJob).toContain('contents: read')
    expect(pluginsJob).toContain('name: plugin-market-${{ github.ref_name }}')
    expect(pluginsJob).toContain(
      '${{ steps.plugin-market.outputs.directory }}/catalog.json',
    )
    expect(pluginsJob).toContain(
      '${{ steps.plugin-market.outputs.directory }}/plugins/**/*.nexuspkg',
    )
    expect(pluginsJob.indexOf('Verify packaged plugin startup')).toBeLessThan(
      pluginsJob.indexOf('uses: actions/upload-artifact@'),
    )
    expect(workflow.split('  publish:\n')[1]).toContain('needs: [package, plugins]')
  })

  it('accepts a complete two-plugin artifact using manifest versions and successful verifier reports', () => {
    const data = fixture()
    const result = data.verify()
    expect(result.status, result.stderr).toBe(0)
    const verified = readFileSync(data.invocations, 'utf8')
      .trim()
      .split('\n')
      .map((line) => resolve(data.directory, JSON.parse(line)))
    expect(verified).toEqual(data.plugins.map((plugin) => plugin.file))
    expect(result.stdout).toContain('ok studio.ai-image 11.2.3')
    expect(result.stdout).toContain('ok studio.vinted-monitor 17.4.5')
  })

  it.each(
    Object.entries(requiredMethods).flatMap(([name, methods]) =>
      methods.map((method) => [name, method]),
    ),
  )('rejects %s when the packaged handshake omits %s', (name, method) => {
    const data = fixture()
    const plugin = data.plugins.find((entry) => entry.name === name)
    plugin.report.methods = plugin.report.methods.filter((entry) => entry !== method)
    writeJson(`${plugin.file}.report.json`, plugin.report)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toContain(method)
  })

  it('does not accept a method name that only contains the required name', () => {
    const data = fixture()
    const plugin = data.plugins[0]
    plugin.report.methods = ['image.plans.createLegacy', 'image.plans.get']
    writeJson(`${plugin.file}.report.json`, plugin.report)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toContain('image.plans.create')
  })

  it.each([
    [
      'digest',
      (data) => {
        data.catalog.plugins[0].package.sha256 = '0'.repeat(64)
      },
    ],
    [
      'size',
      (data) => {
        data.catalog.plugins[0].package.size += 1
      },
    ],
    [
      'path',
      (data) => {
        data.catalog.plugins[0].package.url = '../elsewhere.nexuspkg'
      },
    ],
    [
      'manifest',
      (data) => {
        data.catalog.plugins[0].manifest.version = '0.0.1'
      },
    ],
    [
      'missing plugin',
      (data) => {
        data.catalog.plugins.pop()
      },
    ],
    [
      'duplicate plugin',
      (data) => {
        data.catalog.plugins[1] = data.catalog.plugins[0]
      },
    ],
    [
      'unrelated plugin',
      (data) => {
        data.catalog.plugins.push({
          ...data.catalog.plugins[0],
          manifest: { ...data.catalog.plugins[0].manifest, id: 'studio.shared-supply' },
        })
      },
    ],
  ])('rejects invalid partial catalog metadata: %s', (_, mutate) => {
    const data = fixture()
    mutate(data)
    data.saveCatalog()
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
  })

  it('rejects a plugin package version that differs from its built manifest', () => {
    const data = fixture()
    writeJson(join(data.directory, 'plugins/ai-image/package.json'), {
      name: '@nexus/plugin-ai-image',
      version: '0.0.1',
    })
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toContain('version')
  })

  it('rejects stale packages that the upload glob would otherwise include', () => {
    const data = fixture()
    write(join(data.market, 'plugins/studio.shared-supply/1.0.1.nexuspkg'), 'stale')
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toContain('studio.shared-supply')
  })

  it('rejects package bytes modified after catalog generation', () => {
    const data = fixture()
    appendFileSync(data.plugins[0].file, 'corrupted')
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
  })

  it('rejects a verifier reporting the wrong package identity', () => {
    const data = fixture()
    const plugin = data.plugins[0]
    plugin.report.id = 'studio.shared-supply'
    writeJson(`${plugin.file}.report.json`, plugin.report)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
  })

  it('propagates packaged startup failure instead of uploading an unusable plugin', () => {
    const data = fixture()
    const plugin = data.plugins[0]
    plugin.report.error = 'fixture plugin failed to start'
    writeJson(`${plugin.file}.report.json`, plugin.report)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toContain('fixture plugin failed to start')
  })
})
