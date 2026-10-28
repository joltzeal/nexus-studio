import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
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
import { writePackage } from './market-package.mjs'

const root = resolve(import.meta.dirname, '../..')
const workflowFile = join(root, '.github/workflows/ai-plugin-release.yml')
const workflow = existsSync(workflowFile) ? readFileSync(workflowFile, 'utf8') : ''
const directories = []
const requiredMethods = [
  'image.plans.create',
  'image.plans.get',
  'image.providers.list',
  'image.providers.save',
  'image.providers.remove',
  'image.providers.test',
  'image.providers.testImage',
  'image.presets',
  'image.upload.begin',
  'image.upload.chunk',
  'image.upload.finish',
  'image.upload.abort',
  'image.upload.remote',
  'image.file.chunk',
  'image.records.list',
  'image.records.get',
  'image.records.remove',
  'image.records.retry',
  'image.records.recognize',
  'image.records.export',
  'image.generate',
]

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-ai-release-test-'))
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
  expect(section, `Missing workflow step: ${name}`).toBeDefined()
  return section
}

function command(name) {
  const lines = step(name).split('\n')
  const index = lines.findIndex((line) => line.startsWith('        run: '))
  expect(index, `Missing run command: ${name}`).toBeGreaterThanOrEqual(0)
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
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      timeout: 15_000,
    },
  )
}

function orchestration(failCall = -1) {
  const directory = temporaryDirectory()
  const calls = join(directory, 'calls.jsonl')
  const output = join(directory, 'output')
  const runnerTemp = join(directory, 'runner temp')
  mkdirSync(runnerTemp)
  write(join(directory, 'market/plugins/studio.shared-supply/old.nexuspkg'), 'stale')
  write(
    join(directory, 'record.mjs'),
    `import { appendFileSync, readFileSync } from 'node:fs'
const file = process.env.TEST_CALLS
appendFileSync(file, JSON.stringify(process.argv.slice(2)) + '\\n')
const index = readFileSync(file, 'utf8').trim().split('\\n').length - 1
if (index === Number(process.env.TEST_FAIL_CALL)) process.exit(23)
`,
  )
  // Exercise the actual shell commands without building or packaging any plugin.
  const stubs = `
pnpm() { "$TEST_NODE" "$TEST_RECORDER" pnpm "$@"; }
node() { "$TEST_NODE" "$TEST_RECORDER" node "$@"; }
`
  const result = run(
    `${stubs}\n${command('Build AI plugin and dependencies')}\n${command('Check AI plugin')}\n${command('Pack AI plugin')}`,
    directory,
    {
      TEST_NODE: process.execPath,
      TEST_RECORDER: join(directory, 'record.mjs'),
      TEST_CALLS: calls,
      TEST_FAIL_CALL: String(failCall),
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: runnerTemp,
    },
  )
  return {
    result,
    runnerTemp,
    output,
    commands: readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse),
  }
}

function fixture() {
  const directory = temporaryDirectory()
  const market = join(directory, 'market with spaces')
  const invocations = join(directory, 'verified.jsonl')
  const manifest = {
    apiVersion: 1,
    id: 'studio.ai-image',
    name: 'AI image fixture',
    version: '11.2.3',
    minCoreVersion: '0.1.18',
    capabilities: ['image.provider'],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
  }
  writeJson(join(directory, 'plugins/ai-image/dist/nexus.plugin.json'), manifest)
  writeJson(join(directory, 'plugins/ai-image/package.json'), {
    name: '@nexus/plugin-ai-image',
    version: manifest.version,
    type: 'module',
  })
  const methodFile = join(directory, 'plugins/ai-image/dist/src/capabilities/ai-image.js')
  write(
    methodFile,
    `export const AI_IMAGE_METHODS = ${JSON.stringify(requiredMethods)}\n`,
  )
  // Keep the real container reader; never derive a key or read the repository salt.
  write(
    join(directory, 'scripts/lib/market-package.mjs'),
    readFileSync(join(root, 'scripts/lib/market-package.mjs')),
  )
  const container = {
    manifest: structuredClone(manifest),
    entry: 'bootstrap.cjs',
    changelog: 'English output and realistic casual smartphone photos.',
    createdAt: '2026-10-28T00:00:00.000Z',
    files: [
      { path: 'nexus.plugin.json', data: Buffer.from(JSON.stringify(manifest)) },
      { path: 'bootstrap.cjs', data: Buffer.from('opaque test entry\n') },
      { path: 'payload.bin', data: Buffer.from('opaque test payload\n') },
    ],
  }
  const url = `plugins/${manifest.id}/${manifest.version}.nexuspkg`
  const file = join(market, url)
  const catalog = {
    schemaVersion: 1,
    plugins: [
      {
        manifest: structuredClone(manifest),
        changelog: container.changelog,
        package: { url },
      },
    ],
  }
  const report = {
    id: manifest.id,
    version: manifest.version,
    methods: [...requiredMethods].reverse(),
  }
  // Only the external packaged-process check is replaced. All artifact validation
  // runs unchanged against synthetic container bytes, not a built plugin.
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
if (report.output !== undefined) {
  process.stdout.write(report.output)
} else {
  console.log('ok ' + report.id + ' ' + report.version)
  console.log('   \\u65b9\\u6cd5 ' + (report.count ?? report.methods.length) +
    ' \\u4e2a\\uff1a' + report.methods.join(', '))
  console.log('   \\u72b6\\u6001 {}')
}
`,
  )
  const data = {
    directory,
    market,
    file,
    manifest,
    catalog,
    container,
    report,
    invocations,
    methodFile,
    verify(env = {}) {
      writeJson(`${file}.report.json`, report)
      return run(command('Verify artifact and plugin startup'), directory, {
        PLUGIN_MARKET_DIR: market,
        GITHUB_REF_NAME: `plugin-ai-image@${manifest.version}`,
        TEST_VERIFIED: invocations,
        ...env,
      })
    },
    saveCatalog() {
      writeJson(join(market, 'catalog.json'), catalog)
    },
    savePackage(bytes = writePackage(container)) {
      write(file, bytes)
      catalog.plugins[0].package.size = bytes.length
      catalog.plugins[0].package.sha256 = createHash('sha256').update(bytes).digest('hex')
      data.saveCatalog()
    },
  }
  data.savePackage()
  return data
}

describe('AI plugin release workflow', () => {
  it('runs only on AI plugin tags with pinned tools and read-only repository permissions', () => {
    expect(workflow.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1].trim()).toBe(
      "push:\n    tags:\n      - 'plugin-ai-image@*'",
    )
    expect(workflow.match(/^permissions:\n([\s\S]*?)(?=^\S)/m)?.[1].trim()).toBe(
      'contents: read',
    )
    expect([...workflow.matchAll(/^ {2}(\S+):$/gm)].map((match) => match[1])).toEqual([
      'push',
      'package',
    ])
    expect(workflow).toContain("if: github.repository == 'joltzeal/nexus-studio'")
    expect(workflow).toContain('runs-on: ubuntu-latest')
    expect(workflow).toContain('timeout-minutes: 15')
    expect(workflow).toContain('version: 11.17.0')
    expect(workflow).toContain('node-version-file: .node-version')
    expect(readFileSync(join(root, '.node-version'), 'utf8').trim()).toBe('24.18.0')
    expect(workflow).toContain('run: pnpm install --frozen-lockfile')
    expect(
      [...workflow.matchAll(/^\s+- uses: (.+)$/gm)].map((match) => match[1]),
    ).toEqual([
      'actions/checkout@v4',
      'pnpm/action-setup@v4',
      'actions/setup-node@v4',
      'actions/upload-artifact@v4',
    ])
    expect(workflow).not.toMatch(
      /secrets\.|wrangler|cloudflare|publish-market|market:publish|contents: write|id-token:/i,
    )
  })

  it('builds only AI dependencies, checks directly, and packs only AI into a fresh directory', () => {
    const { result, commands, output, runnerTemp } = orchestration()
    expect(result.status, result.stderr).toBe(0)
    const market = readFileSync(output, 'utf8').match(/^directory=(.+)$/m)?.[1]
    expect(dirname(market)).toBe(runnerTemp)
    expect(readdirSync(market)).toEqual([])
    expect(commands.slice(0, 3)).toEqual([
      ['pnpm', '-r', '--filter', '@nexus/plugin-ai-image...', 'build'],
      [
        'pnpm',
        'exec',
        'eslint',
        'plugins/ai-image',
        'scripts/lib/ai-plugin-release-workflow.test.mjs',
        '--max-warnings',
        '0',
      ],
      [
        'pnpm',
        'exec',
        'vitest',
        'run',
        'plugins/ai-image',
        'scripts/lib/ai-plugin-release-workflow.test.mjs',
        '--maxWorkers=2',
      ],
    ])
    expect(commands[3].slice(0, 6)).toEqual([
      'node',
      'scripts/pack-plugin.mjs',
      'plugins/ai-image',
      '--out',
      market,
      '--changelog',
    ])
    expect(commands[3]).toHaveLength(7)
    expect(commands[3][6]).toMatch(/English/i)
    expect(commands[3][6]).toMatch(/realistic casual smartphone photos/i)
    expect(commands.slice(4)).toEqual([
      ['node', 'scripts/build-market.mjs', '--out', market],
    ])
    expect(step('Pack AI plugin')).toContain('id: market')
    expect(step('Verify artifact and plugin startup')).toContain(
      'PLUGIN_MARKET_DIR: ${{ steps.market.outputs.directory }}',
    )
  })

  it.each([
    ['build', 0],
    ['lint', 1],
    ['plugin tests', 2],
    ['packaging', 3],
  ])('stops orchestration when %s fails', (_, index) => {
    const { result, commands, output } = orchestration(index)
    expect(result.status, result.stderr).toBe(23)
    expect(commands).toHaveLength(index + 1)
    if (index < 3) expect(existsSync(output)).toBe(false)
  })

  it('uploads only the verified temporary catalog and package with no failure bypass', () => {
    const names = [...workflow.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1])
    expect(names).toEqual([
      'Build AI plugin and dependencies',
      'Check AI plugin',
      'Pack AI plugin',
      'Verify artifact and plugin startup',
    ])
    const upload = workflow.split('      - uses: actions/upload-artifact@v4\n')[1]
    expect(upload).toContain('name: plugin-market-${{ github.ref_name }}')
    expect(upload).toContain('${{ steps.market.outputs.directory }}/catalog.json')
    expect(upload).toContain(
      '${{ steps.market.outputs.directory }}/plugins/**/*.nexuspkg',
    )
    expect(upload).toContain('if-no-files-found: error')
    expect(upload).toContain('retention-days: 14')
    expect(workflow.indexOf('Verify artifact and plugin startup')).toBeLessThan(
      workflow.indexOf('uses: actions/upload-artifact@'),
    )
    expect(workflow).not.toMatch(/continue-on-error|always\(\)|failure\(\)|\|\|\s*true/)
    expect([...workflow.matchAll(/^ +(?:- )?run: /gm)]).toHaveLength(5)
  })

  it('accepts matching tag, versions, container and the exact 21 methods in any order', () => {
    const data = fixture()
    const result = data.verify()
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(data.invocations, 'utf8').trim()).toBe(JSON.stringify(data.file))
    expect(result.stdout).toContain('ok studio.ai-image 11.2.3')
  })

  it.each(['plugin-ai-image@0.0.1', 'plugin-vinted-monitor@11.2.3', 'v11.2.3', ''])(
    'rejects mismatched tag %s before starting a plugin',
    (tag) => {
      const data = fixture()
      const result = data.verify({ GITHUB_REF_NAME: tag })
      expect(result.status, result.stdout).toBe(1)
      expect(result.stderr).toContain('tag')
      expect(existsSync(data.invocations)).toBe(false)
    },
  )

  it.each([
    ['package name', 'plugins/ai-image/package.json', 'name', '@nexus/plugin-other'],
    ['package version', 'plugins/ai-image/package.json', 'version', '0.0.1'],
    [
      'manifest identity',
      'plugins/ai-image/dist/nexus.plugin.json',
      'id',
      'studio.other',
    ],
  ])('rejects mismatched %s', (_, path, key, value) => {
    const data = fixture()
    const file = join(data.directory, path)
    writeJson(file, { ...JSON.parse(readFileSync(file, 'utf8')), [key]: value })
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(existsSync(data.invocations)).toBe(false)
  })

  it.each([
    ['schema', (data) => (data.catalog.schemaVersion = 2)],
    ['size', (data) => (data.catalog.plugins[0].package.size += 1)],
    ['digest', (data) => (data.catalog.plugins[0].package.sha256 = '0'.repeat(64))],
    ['path', (data) => (data.catalog.plugins[0].package.url = '../elsewhere.nexuspkg')],
    ['manifest', (data) => (data.catalog.plugins[0].manifest.version = '0.0.1')],
    ['missing plugin', (data) => data.catalog.plugins.pop()],
    ['duplicate plugin', (data) => data.catalog.plugins.push(data.catalog.plugins[0])],
    [
      'unrelated plugin',
      (data) => (data.catalog.plugins[0].manifest.id = 'studio.shared-supply'),
    ],
  ])('rejects invalid catalog %s before starting a plugin', (_, mutate) => {
    const data = fixture()
    mutate(data)
    data.saveCatalog()
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(existsSync(data.invocations)).toBe(false)
  })

  it.each(['studio.shared-supply/1.0.0', 'studio.ai-image/0.0.1'])(
    'rejects an uncatalogued package %s that the upload glob would include',
    (path) => {
      const data = fixture()
      write(join(data.market, `plugins/${path}.nexuspkg`), 'stale')
      const result = data.verify()
      expect(result.status, result.stdout).toBe(1)
      expect(result.stderr).toContain(path)
    },
  )

  it('rejects bytes changed after catalog generation', () => {
    const data = fixture()
    appendFileSync(data.file, 'corrupted')
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(existsSync(data.invocations)).toBe(false)
  })

  it('rejects internal corruption even when the outer catalog digest matches', () => {
    const data = fixture()
    const bytes = readFileSync(data.file)
    bytes[bytes.length - 1] ^= 1
    data.savePackage(bytes)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toContain('package body checksum mismatch')
    expect(existsSync(data.invocations)).toBe(false)
  })

  it.each(['header', 'embedded'])('rejects a mismatched %s package manifest', (kind) => {
    const data = fixture()
    if (kind === 'header') data.container.manifest.version = '0.0.1'
    else {
      data.container.files[0].data = Buffer.from(
        JSON.stringify({ ...data.manifest, version: '0.0.1' }),
      )
    }
    data.savePackage()
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toMatch(/manifest/i)
    expect(existsSync(data.invocations)).toBe(false)
  })

  it.each(requiredMethods)('rejects a packaged handshake missing %s', (method) => {
    const data = fixture()
    data.report.methods = data.report.methods.filter((entry) => entry !== method)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toContain(method)
  })

  it.each([
    ['substring', (methods) => methods.map((method) => `${method}Legacy`)],
    ['duplicate', (methods) => [methods[0], ...methods.slice(0, -1)]],
    ['extra', (methods) => [...methods, 'image.unexpected']],
  ])('rejects %s RPC names', (_, mutate) => {
    const data = fixture()
    data.report.methods = mutate(data.report.methods)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
  })

  it.each([
    [
      'missing method report',
      (report) => (report.output = 'ok studio.ai-image 11.2.3\n'),
    ],
    ['inconsistent method count', (report) => (report.count = 20)],
    ['wrong identity', (report) => (report.id = 'studio.shared-supply')],
    ['wrong version', (report) => (report.version = '0.0.1')],
    ['startup failure', (report) => (report.error = 'fixture plugin failed to start')],
  ])('rejects verifier %s', (_, mutate) => {
    const data = fixture()
    mutate(data.report)
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(existsSync(data.invocations)).toBe(true)
    if (data.report.error) expect(result.stderr).toContain(data.report.error)
  })

  it('uses the compiled method export as the handshake contract', () => {
    const data = fixture()
    const methods = [...requiredMethods.slice(0, -1), 'image.generateNext']
    write(data.methodFile, `export const AI_IMAGE_METHODS = ${JSON.stringify(methods)}\n`)
    data.report.methods = methods
    const result = data.verify()
    expect(result.status, result.stderr).toBe(0)
  })

  it.each([
    ['missing', requiredMethods.slice(1)],
    ['duplicate', [requiredMethods[0], ...requiredMethods.slice(0, -1)]],
    ['extra', [...requiredMethods, 'image.unexpected']],
  ])('rejects a compiled method contract with %s entries', (_, methods) => {
    const data = fixture()
    write(data.methodFile, `export const AI_IMAGE_METHODS = ${JSON.stringify(methods)}\n`)
    data.report.methods = methods
    const result = data.verify()
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toContain('21')
  })
})
