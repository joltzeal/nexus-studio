import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

describe('public application and private local plugin boundary', () => {
  it('ignores plugin sources and generated market artifacts', () => {
    const ignored = read('.gitignore').split('\n')
    expect(ignored).toContain('/plugins/')
    expect(ignored).toContain('market/')
  })

  it('builds the application without any private plugin workspace dependency', () => {
    const app = JSON.parse(read('apps/desktop/package.json'))
    const dependencies = Object.keys(app.dependencies)
    expect(dependencies.filter((name) => name.startsWith('@nexus/plugin-'))).toEqual([
      '@nexus/plugin-contracts',
      '@nexus/plugin-sdk',
    ])
    const scripts = JSON.parse(read('package.json')).scripts
    expect(scripts['build:packages']).not.toContain('./plugins/')
    expect(scripts['plugins:build']).toContain('./plugins/*')
  })

  it('publishes desktop releases independently of local plugin packaging', () => {
    const workflows = readdirSync(resolve(root, '.github/workflows'))
    expect(workflows).not.toContain('ai-plugin-release.yml')
    expect(workflows).not.toContain('accounts-plugin-release.yml')
    expect(workflows).not.toContain('plugin-release.yml')
    const release = read('.github/workflows/release.yml')
    expect(release).not.toMatch(/^ {2}plugins:/m)
    expect(release).toContain('needs: [package]')
    expect(release).not.toContain('scripts/pack-plugin.mjs')
    expect(release).not.toContain('plugins/*')
  })
})
