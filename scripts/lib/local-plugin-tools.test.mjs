import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(script) {
  const root = mkdtempSync(join(tmpdir(), 'raccoon-local-plugins-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'))
  copyFileSync(resolve(import.meta.dirname, '..', script), join(root, 'scripts', script))
  const run = (args = [], env = {}) =>
    spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
  return { root, run }
}

describe('local plugin development', () => {
  it('rejects paths outside the local plugin directory before spawning a compiler', () => {
    const { run } = fixture('dev-plugin.mjs')
    for (const args of [[], ['../private'], ['/tmp/plugin'], ['--help']])
      expect(run(args).status).toBe(1)
  })

  it('reports missing local source without requiring it in the public checkout', () => {
    const { run } = fixture('dev-plugin.mjs')
    const result = run(['fixture'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('本地没有插件源码')
  })

  it.each([0, 17])(
    'builds dependencies before watching, preserving compiler exit code %s',
    (buildExit) => {
      const { root, run } = fixture('dev-plugin.mjs')
      mkdirSync(join(root, 'plugins', 'fixture'), { recursive: true })
      writeFileSync(
        join(root, 'plugins', 'fixture', 'package.json'),
        JSON.stringify({ name: '@nexus/plugin-fixture' }),
      )
      const recorder = join(root, 'package-manager.cjs')
      const calls = join(root, 'calls.jsonl')
      writeFileSync(
        recorder,
        `const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n')
if (args.includes('build')) process.exit(Number(process.env.FIXTURE_BUILD_EXIT))
`,
      )
      const result = run(['fixture'], {
        npm_execpath: recorder,
        FIXTURE_CALLS: calls,
        FIXTURE_BUILD_EXIT: String(buildExit),
      })
      expect(result.status, result.stderr).toBe(buildExit)
      const actual = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
      expect(actual[0]).toEqual(['--filter', '@nexus/plugin-fixture...', 'build'])
      expect(actual).toHaveLength(buildExit ? 1 : 2)
      if (!buildExit)
        expect(actual[1]).toEqual([
          '--filter',
          '@nexus/plugin-fixture',
          'exec',
          'tsc',
          '-p',
          'tsconfig.json',
          '--watch',
        ])
    },
  )
})

describe('public Git boundary guard', () => {
  it('accepts local untracked plugins and rejects files staged for publication', () => {
    const { root, run } = fixture('check-public-boundary.mjs')
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }
    git('init', '--quiet')
    mkdirSync(join(root, 'plugins'))
    writeFileSync(join(root, 'plugins', 'fixture.ts'), 'const fixture = true\n')
    expect(run().status).toBe(0)
    git('add', 'plugins/fixture.ts')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('共 1 个')
  })

  it('fails closed when the Git file inventory is unavailable', () => {
    const { run } = fixture('check-public-boundary.mjs')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('无法检查 Git 文件清单')
  })
})
